import { unboundedClock, type InvocationClock } from './invocation-clock';
import { contactFromJob, enrichJobContact, isHiringInbox } from './job-contact';
import {
  isStaleJobDraft,
  renderJobOutreach,
  type JobGreeting,
} from './job-outreach-template';
import { companyLabel } from './postjob';
import {
  getJobContacts,
  getJobOutreaches,
  getRecentJobs,
  saveJobContact,
  saveJobOutreach,
} from './storage';
import type { Job, JobContact } from './types';

/**
 * The middle of the JOB outreach pipeline: job row → who posted it → a drafted email.
 *
 * The same shape as lib/prepare.ts and for the same reason it was written — a pipeline whose
 * middle steps only run when a human curls an admin action is a pipeline that reports `ok`
 * every morning while mailing nobody (measured on the funding side, four silent days).
 *
 * TWO THINGS ARE CHEAPER HERE THAN ON THE FUNDING SIDE, AND THE BUDGETS REFLECT IT
 *  - Drafting is FREE. lib/job-outreach-template.ts is string interpolation, not a Gemini
 *    call, so the draft limit exists to bound wall-clock rather than quota and can be large.
 *  - The contact is often free too: a LinkedIn post that says "mail me at ananya@acme.com"
 *    needs no lookup at all. Only rows that give nothing reach Hunter.
 *
 * ONE THING IS SCARCER. Hunter's pool is ~100 searches a MONTH across both keys and the
 * funding pipeline is already spending 2 a day of it. Job enrichment therefore defaults to
 * ONE credit per run, and the free phase runs over everything.
 */

/** Rows to consider per pass. Same 200-row window the funding passes use. */
const JOB_WINDOW = 200;

/**
 * Only chase jobs that are still worth applying to. An internship posted six weeks ago is
 * filled, and an application to it is a cold email with no upside.
 */
const MAX_JOB_AGE_DAYS = 21;

/**
 * Wall-clock ceiling, and there are two because the two callers have very different room.
 *
 * The cron shares one 300s invocation with the funding scan, the founder sends and an IMAP
 * session, so it takes a small slice. The dashboard button owns its whole request and is a
 * human waiting on a spinner, so it gets most of a 60s function (`maxDuration` on
 * app/jobs/page.tsx — without that export the action runs under Vercel's default, which is
 * SHORTER than this budget, and the pass is killed part-way through with no error).
 */
const PREPARE_BUDGET_MS = 20_000;
const MANUAL_BUDGET_MS = 45_000;

/**
 * Below this the pass declines. One row costs a Hunter lookup plus two sequential Gemini
 * calls, so a shorter slice spends a metered credit to produce nothing and reports
 * `timedOut`. See lib/invocation-clock.ts for why a budget is now an ask.
 */
const MIN_PREPARE_MS = 8_000;

/**
 * Hunter credits one job pass may spend. Cap AND kill switch: **0 = off**.
 *
 * Default 1, deliberately lower than the funding pipeline's 2. That pipeline is the one
 * currently producing replies, and both draw on the same ~100-a-month pool; a job row that
 * misses out this morning is still there tomorrow.
 */
export function jobEnrichSpendPerRun(): number {
  const raw = process.env.JOB_ENRICH_CREDITS_PER_RUN;
  if (raw === undefined || raw.trim() === '') return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Rows one pass may draft. Cap AND kill switch: **0 = off**.
 *
 * Default 25, far above the funding pipeline's 3, because a job draft costs nothing to
 * produce. The real ceiling is the wall clock, and `timedOut` reports when that is what bit.
 */
/**
 * Hunter credits ONE PRESS of the dashboard button may spend. Default 5, against a measured
 * pool of 80 left of 100 on 2026-08-18.
 *
 * Higher than the cron's 1 on purpose, and the precedent is `?action=enrich&spend=N` on the
 * funding side: a scheduled run must sip at a monthly pool because nobody is watching, while
 * a human pressing a button has decided this batch is worth paying for and is looking at the
 * result. Rows whose paid lookup is already settled are skipped for free, so pressing twice
 * advances into new rows instead of re-buying the same ones.
 */
export function manualSpend(): number {
  const raw = process.env.JOB_ENRICH_CREDITS_PER_CLICK;
  if (raw === undefined || raw.trim() === '') return 5;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export function jobDraftLimitPerRun(): number {
  const raw = process.env.JOB_PREPARE_MAX_PER_RUN;
  if (raw === undefined || raw.trim() === '') return 25;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export type JobPrepareResult = {
  /** Rows examined this pass. */
  considered: number;
  /** Contacts written from the post body alone, costing nothing. */
  contactsFromPost: number;
  /** Contacts that needed Hunter, free phase or paid. */
  contactsFromHunter: number;
  creditsSpent: number;
  drafted: number;
  /** Drafted rows that also hold a person-addressed email, i.e. the sendable ones. */
  sendable: number;
  /** Rows with an address but nobody to greet, so no draft could be written. */
  noPerson: number;
  skippedStale: number;
  /** Portal listings (Internshala, Unstop, the remote boards) with no published address. */
  skippedPortal: number;
  errors: string[];
  timedOut: boolean;
  dryRun: boolean;
  wouldSpend?: { credits: number; drafts: number };
  /**
   * Never started, because the shared invocation clock was already spent. Distinct from
   * `timedOut`, which means it ran and was cut off part-way with rows still queued.
   */
  outOfTime?: boolean;
};

const expired = (deadline: number) => Date.now() > deadline;

/**
 * Sources where you apply THROUGH THE SITE, so there is no poster to write to.
 *
 * ⚠️ THIS IS THE MOST IMPORTANT LINE IN THE FILE, and it was learned the expensive way. The
 * first real runs produced 4 contacts across ~300 rows, and the reason was not the lookup: the
 * queue is ~85% Internshala and Unstop, which are portals. An Internshala listing has an Apply
 * button and a per-role written question; there is no recruiter address anywhere in it, the
 * "company" is frequently a two-person outfit Hunter has never heard of, and cold-emailing
 * them about a listing they posted to a portal is a worse move than simply applying on the
 * portal. Every credit those rows consumed was a credit not spent on a LinkedIn post written
 * by a named human who asked to be contacted.
 *
 * So they are dropped from this queue entirely — not deprioritised. Left in, they still cost
 * a free Hunter domain call each and eat the wall-clock budget ahead of rows that can convert.
 * They remain on /jobs to be applied to by hand, which is the right action for them.
 *
 * A row from one of these sources IS kept if the post itself carries an address, because then
 * somebody did publish a way to reach them.
 */
export const PORTAL_SOURCES = new Set<Job['source']>([
  'internshala',
  'unstop',
  'remoteok',
  'wwr',
  'himalayas',
  'remotive',
  'jobicy',
  'waas',
  'yc',
]);

/** Is there plausibly a human behind this row to email? */
export function hasHumanPoster(job: Job): boolean {
  return !PORTAL_SOURCES.has(job.source);
}

function isNew(job: Job): boolean {
  // Absent status means a row stored before job outreach existed. Those are the backlog and
  // they belong in the queue, so absent reads as 'new' rather than as "already handled".
  return (job.status ?? 'new') === 'new';
}

/**
 * Work out who to write to for each fresh job row, then draft the email.
 *
 * NOTHING HERE SENDS. It writes contacts and drafts; lib/job-autosend.ts decides what leaves
 * the building, and its gates are the safeguard.
 */
export async function runJobPrepare(
  opts: {
    dryRun?: boolean;
    /**
     * A human pressed the button rather than a cron firing. Spends more (a person asking is
     * the same signal `?action=enrich&spend=N` treats as licence on the funding side) and
     * takes the larger time slice, because nothing else is sharing this invocation.
     */
    manual?: boolean;
    /**
     * The invocation's shared clock, passed by the cron route. Absent for the dashboard
     * button, which owns its whole request.
     */
    clock?: InvocationClock;
  } = {}
): Promise<JobPrepareResult> {
  const credits = opts.manual ? manualSpend() : jobEnrichSpendPerRun();
  const draftLimit = jobDraftLimitPerRun();

  const result: JobPrepareResult = {
    considered: 0,
    contactsFromPost: 0,
    contactsFromHunter: 0,
    creditsSpent: 0,
    drafted: 0,
    sendable: 0,
    noPerson: 0,
    skippedStale: 0,
    skippedPortal: 0,
    errors: [],
    timedOut: false,
    dryRun: opts.dryRun ?? false,
  };

  if (opts.dryRun) {
    result.wouldSpend = { credits, drafts: draftLimit };
    return result;
  }
  if (draftLimit === 0) return result;

  const clock = opts.clock ?? unboundedClock;
  if (!clock.canAfford(MIN_PREPARE_MS)) {
    result.outOfTime = true;
    return result;
  }

  const deadline = clock.deadlineFor(opts.manual ? MANUAL_BUDGET_MS : PREPARE_BUDGET_MS);
  const jobs = await getRecentJobs(JOB_WINDOW);
  const ids = jobs.map((j) => j.id);
  const [contacts, drafts] = await Promise.all([getJobContacts(ids), getJobOutreaches(ids)]);

  const cutoff = Date.now() - MAX_JOB_AGE_DAYS * 24 * 60 * 60 * 1000;
  const queue = jobs.filter((j) => {
    if (!isNew(j)) return false;
    if (drafts.get(j.id)?.sentAt) return false;
    if (+new Date(j.postedAt) < cutoff) {
      result.skippedStale += 1;
      return false;
    }
    // A portal listing with no published address has nobody to write to. Counted, not silent,
    // because "0 contacts found" and "0 contacts found, 240 of these are Internshala rows you
    // apply to on the site" are completely different reports.
    if (!hasHumanPoster(j) && !hasPostAddress(j)) {
      result.skippedPortal += 1;
      return false;
    }
    return true;
  });

  // Rows whose post already carries an address go FIRST. They are free to contact and they
  // are the ones a draft turns into an actual email, so if the clock or the credit budget
  // bites it should bite on the rows that need a paid lookup anyway.
  //
  // Ordering, not a gate: every row is still reached eventually. Deliberately a cheap
  // heuristic and not a copy of the sender's checks, because two definitions of "sendable"
  // drift apart, which is the exact failure lib/prepare.ts exists to undo.
  const ordered = [...queue].sort(
    (a, b) => Number(hasPostAddress(b)) - Number(hasPostAddress(a))
  );

  let creditsLeft = credits;

  for (const job of ordered.slice(0, draftLimit)) {
    if (expired(deadline)) {
      result.timedOut = true;
      break;
    }
    result.considered += 1;

    try {
      let contact: JobContact | null = contacts.get(job.id) ?? null;

      // Free first, always. An address the poster wrote into their own post beats anything a
      // lookup can return, and it costs nothing to read.
      if (!contact) {
        contact = contactFromJob(job);
        if (contact) result.contactsFromPost += 1;
      }

      const hasPerson = contact?.emails.some((e) => e.person) ?? false;
      if (!hasPerson) {
        const outcome = await enrichJobContact(job, contact, { spend: creditsLeft > 0 });
        if (outcome.creditsSpent > 0) {
          creditsLeft -= outcome.creditsSpent;
          result.creditsSpent += outcome.creditsSpent;
        }
        if (outcome.contact && outcome.contact !== contact) {
          result.contactsFromHunter += 1;
          contact = outcome.contact;
        }
      }

      if (contact) await saveJobContact(job.id, contact);

      // A draft is normally written once. The exception is a draft from an OLDER template
      // version: those keep whatever the template got wrong at the time, and they sit in the
      // queue ready to send. Sent drafts are the record of what somebody received and
      // hand-edited ones are not ours to rewrite, so neither is touched.
      const existingDraft = drafts.get(job.id);
      if (existingDraft && (existingDraft.sentAt || !isStaleJobDraft(existingDraft.model))) {
        continue;
      }

      // A person to greet wins. Failing that, a shared HIRING inbox (careers@, hr@) gets the
      // "Hi team," variant — it exists to receive applications, so an email addressed to
      // nobody in particular is right for it. A shared COMPANY inbox (info@, support@) gets
      // neither, and the row stays for a human.
      const greeting: JobGreeting = contact?.emails.some((e) => e.person)
        ? 'person'
        : contact?.emails.some((e) => isHiringInbox(e.address))
          ? 'team'
          : 'person';

      const draft = renderJobOutreach(job, contact, { greeting });
      if (!draft) {
        // No name to greet. Not an error and not a retry — the row simply cannot carry this
        // template, and "Hi there" to somebody who posted a role personally is worse than
        // silence. It stays on the dashboard for a human.
        result.noPerson += 1;
        continue;
      }

      await saveJobOutreach(job.id, draft);
      result.drafted += 1;
      if (
        contact?.emails.some((e) => e.person || isHiringInbox(e.address))
      ) {
        result.sendable += 1;
      }
    } catch (e) {
      const msg = (e as Error).message;
      result.errors.push(`${companyLabel(job)}: ${msg}`);
      // Out of credits or throttled: stop rather than hammer Hunter once per remaining row.
      if (/\b429\b|credit|exhausted/i.test(msg)) break;
    }
  }

  return result;
}

/** Does this row already carry an address, so its contact costs nothing? */
function hasPostAddress(job: Job): boolean {
  return job.tags.some((t) => t.includes('@')) || /@/.test(job.description ?? '');
}
