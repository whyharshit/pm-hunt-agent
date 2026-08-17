import { contactFromJob, enrichJobContact } from './job-contact';
import { renderJobOutreach } from './job-outreach-template';
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

/** Wall-clock ceiling. Shares the funding invocation, so it is small by design. */
const PREPARE_BUDGET_MS = 20_000;

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
  errors: string[];
  timedOut: boolean;
  dryRun: boolean;
  wouldSpend?: { credits: number; drafts: number };
};

const expired = (deadline: number) => Date.now() > deadline;

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
export async function runJobPrepare(opts: { dryRun?: boolean } = {}): Promise<JobPrepareResult> {
  const credits = jobEnrichSpendPerRun();
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
    errors: [],
    timedOut: false,
    dryRun: opts.dryRun ?? false,
  };

  if (opts.dryRun) {
    result.wouldSpend = { credits, drafts: draftLimit };
    return result;
  }
  if (draftLimit === 0) return result;

  const deadline = Date.now() + PREPARE_BUDGET_MS;
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

      if (drafts.has(job.id)) continue;

      const draft = renderJobOutreach(job, contact);
      if (!draft) {
        // No name to greet. Not an error and not a retry — the row simply cannot carry this
        // template, and "Hi there" to somebody who posted a role personally is worse than
        // silence. It stays on the dashboard for a human.
        result.noPerson += 1;
        continue;
      }

      await saveJobOutreach(job.id, draft);
      result.drafted += 1;
      if (contact?.emails.some((e) => e.person)) result.sendable += 1;
    } catch (e) {
      const msg = (e as Error).message;
      result.errors.push(`${job.company}: ${msg}`);
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
