import { addressLooksLikePerson, isGenericEmail } from './contact';
import { domainMatchesCompany } from './enrich';
import { byPreference } from './job-category';
import { isHiringInbox } from './job-contact';
import {
  isEditedJobDraft,
  isStaleJobDraft,
  renderJobOutreach,
  type JobGreeting,
} from './job-outreach-template';
import { sendOutreachMail } from './mailer';
import { firstName } from './outreach-template';
import { createPacer } from './pace';
import { companyLabel, employerName, posterName } from './postjob';
import { readResumePdf } from './resume-file';
import { bouncedAddresses, mailedAddresses, recordInitialSend } from './sequence';
import {
  getJobContacts,
  getJobOutreaches,
  getRecentJobs,
  recordAgentRun,
  saveJobOutreach,
  setAgentRunning,
  updateJobStatus,
} from './storage';
import type { ContactEmail, Job, JobContact, JobOutreach } from './types';

/**
 * Apply to discovered jobs without a human click. User's explicit instruction 2026-08-17,
 * chosen over a review-then-send dashboard button: "Auto-send under the same gates."
 *
 * "The same gates" is the whole specification, so this is deliberately the founder sender's
 * gate list re-applied to job rows, with ONE inversion and one addition:
 *
 *  1. `JOB_SEND_MAX_PER_DAY` is cap and kill switch — 0 = off, no deploy needed. Separate
 *     from `AUTO_SEND_MAX_PER_DAY` so pausing one pipeline never silently pauses the other,
 *     and because they add up in the same Gmail: a personal address that sends twenty cold
 *     emails a morning gets flagged as spam regardless of how good the copy is.
 *  2. The address must belong to the person the draft greets (`addressLooksLikePerson`). This
 *     is the check that stopped "Hi Paolo," reaching booking@weroad.com.
 *  3. ⚠️ PROVENANCE IS INVERTED FROM THE FUNDING SENDER. There, a scraped address is
 *     untrusted and only Hunter or a human counts. Here the BEST address is the one written
 *     into the job post itself, because the poster put it there to be written to. Hunter and
 *     hand-added still count; nothing else does.
 *  4. The posting must still be recent. An application to a six-week-old internship is a cold
 *     email with no upside.
 *  5. The user's own addresses can never receive outreach.
 *  6. NEW: shared hiring inboxes are refused. `careers@` is a perfectly good address for a
 *     human to use, but this draft opens "Hi <first name>," and a named greeting arriving at
 *     a shared inbox reads as a botched mail-merge. Those rows are counted and reported, not
 *     silently dropped, so the size of what is being left on the table stays visible.
 */

/** Never outreach to the user's own addresses — they are test recipients. */
const NEVER_SEND_TO = [
  'shivanshch001@gmail.com',
  'hr.lovng@gmail.com',
  'shivanshchaudhary.iitkgp@gmail.com',
  'hello@lovingroom.co',
];

/** Applications go stale fast. Matches the window lib/job-prepare.ts drafts within. */
const MAX_JOB_AGE_DAYS = 21;

/**
 * Pacing budget, scaled to the batch rather than fixed.
 *
 * It shares one 300s invocation with the funding scan, the founder sender (70s), the job
 * prepare pass and the follow-up pass with its IMAP session — so this cannot simply take the
 * lot. A fixed 40s was fine at a cap of 3; at the cap of 20 the user asked for on 2026-08-18
 * it worked out at 2s per message, which fell under the pacer's floor and disabled spacing
 * altogether. Scaling with the batch keeps roughly 6s between sends while the batch is small
 * and degrades gracefully when it is not.
 */
const PACE_MS_PER_SEND = 6_000;
const PACE_BUDGET_CEILING_MS = 120_000;

function paceBudgetMs(count: number): number {
  return Math.min(PACE_BUDGET_CEILING_MS, Math.max(20_000, count * PACE_MS_PER_SEND));
}

/** How many rows a dry run lists. Enough to judge the queue, short of an unreadable dump. */
const DRY_RUN_LIST_LIMIT = 25;

export function jobSendCap(): number {
  const raw = process.env.JOB_SEND_MAX_PER_DAY;
  if (raw === undefined || raw.trim() === '') return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * The key behind the one-application-per-employer-per-run guard.
 *
 * The employer when the row names one, else whoever posted it, else '' for no guard at all.
 * See the call site for why the poster half still matters.
 */
function dedupeKey(job: Job): string {
  const name = employerName(job) || posterName(job.tags);
  return name.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Addresses trusted enough to mail unattended. On a job row the post itself is the best one. */
function trustedProvenance(e: ContactEmail): boolean {
  return /the job post itself|hunter\.io|added by hand/i.test(e.foundOn);
}

/**
 * Does this address belong to the company whose job this is?
 *
 * ⚠️ CHECKED AT SEND TIME ON PURPOSE, not only at lookup time. `resolveDomain` was fixed on
 * 2026-08-18 to stop accepting a domain that merely resembles the company name, but that fix
 * is forward-looking: contacts enriched BEFORE it are already stored, already drafted, and
 * still perfectly sendable. The row that mailed a person at `aikyamjobs.org` about a
 * The/Nudge Institute internship is exactly such a row, and there is no way to know from here
 * how many others are sitting in the queue with it.
 *
 * Only Hunter-derived addresses are tested. An address the poster wrote into their own post
 * is not required to sit on the employer's domain - people post from gmail accounts, and that
 * address is still the one they asked to be written to. Hand-added addresses are a human's
 * decision and are left alone for the same reason.
 */
function recipientBelongsToCompany(job: Job, e: ContactEmail): boolean {
  if (!/hunter\.io/i.test(e.foundOn)) return true;
  const domain = e.address.split('@')[1] ?? '';
  // `employerName`, so the comparison is against a COMPANY. Comparing against the raw field
  // meant comparing a domain to a person's name on every LinkedIn post row, which failed for
  // the wrong reason and would have started passing the moment somebody "fixed" the field.
  return domain !== '' && domainMatchesCompany(employerName(job), domain);
}

/**
 * Does the stored draft already open the way this recipient requires?
 *
 * Both directions matter. A person draft reaching a shared inbox is the mail-merge failure;
 * a TEAM draft reaching a named person is merely cold, but it is still not the email that was
 * reviewed. Either mismatch triggers a re-render before anything is sent.
 */
function greetingMatches(text: string, greeting: JobGreeting, person: string): boolean {
  if (greeting === 'team') return /^\s*hi\s+team\s*,/i.test(text);
  if (!person) return false;
  return new RegExp(`^\\s*hi\\s+${firstName(person)}\\b`, 'i').test(text);
}

export type JobSendCandidate = {
  job: Job;
  draft: JobOutreach;
  contact: JobContact;
  to: string;
  /** The name the email must open with. Empty for a team draft, which greets nobody. */
  greeted: string;
  /** Which draft this address requires. A mismatch here is what re-renders before sending. */
  greeting: JobGreeting;
  /** Where the address came from, carried through so a dry run can be eyeballed. */
  foundOn: string;
};

export type JobSendResult = {
  cap: number;
  eligible: number;
  sent: Array<{ company: string; title: string; to: string; greeted: string; foundOn: string }>;
  failed: Array<{ company: string; to: string; error: string }>;
  /**
   * Rows holding a real address that only a human can use: a shared hiring inbox, or an
   * address that does not match the greeting. Reported because "0 eligible" and "0 eligible,
   * and 14 rows are one decision away" are very different states of the world.
   */
  blockedSharedInbox: number;
  blockedNoPersonMatch: number;
  dryRun: boolean;
  resumeKB: number | null;
};

/**
 * Rows eligible to send unattended. Exported so a dry run shows exactly what WOULD go out —
 * never trust an unattended sender you cannot inspect first.
 */
export async function jobSendCandidates(): Promise<{
  candidates: JobSendCandidate[];
  blockedSharedInbox: number;
  blockedNoPersonMatch: number;
}> {
  const jobs = await getRecentJobs(200);
  const ids = jobs.map((j) => j.id);
  const [drafts, contacts] = await Promise.all([getJobOutreaches(ids), getJobContacts(ids)]);

  const cutoff = Date.now() - MAX_JOB_AGE_DAYS * 24 * 60 * 60 * 1000;
  const out: JobSendCandidate[] = [];
  let blockedSharedInbox = 0;
  let blockedNoPersonMatch = 0;

  for (const job of jobs) {
    if ((job.status ?? 'new') !== 'new') continue;
    if (+new Date(job.postedAt) < cutoff) continue;

    const draft = drafts.get(job.id);
    if (!draft || draft.sentAt) continue;

    const contact = contacts.get(job.id);
    if (!contact) continue;

    const usable = contact.emails.filter(
      (e) =>
        trustedProvenance(e) &&
        !NEVER_SEND_TO.includes(e.address.toLowerCase()) &&
        recipientBelongsToCompany(job, e)
    );
    if (usable.length === 0) continue;

    // A NAMED PERSON FIRST. Whoever receives it must be who the email greets: that is the
    // difference between "Hi Ananya" reaching Ananya and reaching her colleague.
    const personal = usable.filter((e) => !isGenericEmail(e.address));
    const chosen = personal.find((e) => e.person && addressLooksLikePerson(e.address, e.person));

    if (chosen?.person) {
      out.push({
        job,
        draft,
        contact,
        to: chosen.address,
        greeted: chosen.person,
        greeting: 'person',
        foundOn: chosen.foundOn,
      });
      continue;
    }

    // FAILING THAT, a shared HIRING inbox, with the "Hi team," draft (user's call
    // 2026-08-18). careers@ and hr@ exist to receive applications, so an email that greets
    // nobody in particular belongs there.
    //
    // ⚠️ The narrowing is `isHiringInbox`, NOT `isGenericEmail`. info@, support@ and
    // booking@ are shared too and are NOT application inboxes — sending a CV to booking@ is
    // the same class of mistake as sending "Hi Paolo," to it, just quieter. And a row whose
    // only address is a hiring inbox must carry a TEAM draft; a "Hi Sharad," draft reaching
    // careers@ is precisely what this whole branch exists to avoid.
    const hiring = usable.find((e) => isHiringInbox(e.address));
    if (hiring) {
      out.push({
        job,
        draft,
        contact,
        to: hiring.address,
        greeted: '',
        greeting: 'team',
        foundOn: hiring.foundOn,
      });
      continue;
    }

    if (personal.length === 0) blockedSharedInbox += 1;
    else blockedNoPersonMatch += 1;
  }

  // MOST-WANTED CATEGORY FIRST, then freshest. The daily cap is small (5), so the order here
  // decides what actually gets sent rather than merely what is listed — and the user's ranking
  // (2026-08-18) is "product most, then strategy, growth, founder's office, then data/sde".
  // Sorting by date alone spent the cap on whichever row happened to be newest, which after
  // the on-site widening is very often an SDE listing.
  out.sort((a, b) => byPreference(a.job, b.job));

  // Never twice to the same person or the same company in one run. Two sources can carry the
  // same role under different ids, and two emails to one recruiter in one morning is the most
  // spam-like thing this could do.
  //
  // ⚠️ `alreadyMailed` is the ACROSS-RUN half, and it was missing until 2026-08-18. The Sets
  // below are rebuilt every call, so they only ever saw one morning; the sole cross-run guard
  // was per-row (`draft.sentAt`, `status !== 'new'`), and two job rows for one company are two
  // separate rows. careers@cloudsecurityweb.com received the same application twice that way.
  const [alreadyMailed, bounced] = await Promise.all([mailedAddresses(), bouncedAddresses()]);
  const seenAddress = new Set<string>();
  const seenCompany = new Set<string>();
  const candidates = out.filter((c) => {
    const address = c.to.toLowerCase();
    if (alreadyMailed.has(address) || bounced.has(address)) return false;
    // ⚠️ THE EMPLOYER, ELSE THE POSTER - not `job.company`, which is now empty on a post
    // that never named a company. The old field doubled as a per-POSTER guard by accident (it
    // held the poster's name), and that guard is worth keeping on purpose: one recruiter
    // posting twice from two addresses should still get one application, not two. An empty key
    // means no dedupe, which is right - two unnamed employers are not the same employer.
    const company = dedupeKey(c.job);
    if (seenAddress.has(address) || (company && seenCompany.has(company))) return false;
    seenAddress.add(address);
    if (company) seenCompany.add(company);
    return true;
  });

  return { candidates, blockedSharedInbox, blockedNoPersonMatch };
}

/**
 * `dryRun` reports what would be sent and touches nothing. The cron calls it for real; use
 * the dry run to inspect the queue before trusting a schedule change.
 */
export async function runJobAutoSend(opts: { dryRun?: boolean } = {}): Promise<JobSendResult> {
  const dryRun = opts.dryRun ?? false;
  const cap = jobSendCap();
  const { candidates, blockedSharedInbox, blockedNoPersonMatch } = await jobSendCandidates();
  const batch = candidates.slice(0, cap);

  const resume = await readResumePdf();
  const result: JobSendResult = {
    cap,
    eligible: candidates.length,
    sent: [],
    failed: [],
    blockedSharedInbox,
    blockedNoPersonMatch,
    dryRun,
    resumeKB: resume ? Math.round(resume.length / 1024) : null,
  };

  if (dryRun) {
    // The WHOLE queue, not just the first `cap` of it. A dry run is read to decide whether to
    // let this send at all, and the safe way to make that decision is with the cap at 0 — at
    // which point clipping to the cap would report an empty list and look like "nothing to
    // send" rather than "sending is off". `cap` and `eligible` are both in the result, so how
    // many of these would actually go this morning is still plain.
    result.sent = candidates.slice(0, DRY_RUN_LIST_LIMIT).map((c) => ({
      // `companyLabel`, not `job.company`: a post row that never named an employer has an
      // empty company, and a dry run listing a blank there is unreadable. It reads
      // "posted by <name>" instead, which is what that row actually is.
      company: companyLabel(c.job),
      title: c.job.title,
      to: c.to,
      greeted: c.greeted,
      foundOn: c.foundOn,
    }));
    return result;
  }

  if (cap === 0) {
    await recordAgentRun('job-mailer', {
      state: 'ok',
      summary: `job auto-send off (JOB_SEND_MAX_PER_DAY=0) · ${candidates.length} would qualify`,
      error: null,
    });
    return result;
  }

  await setAgentRunning('job-mailer');
  const pace = createPacer({ budgetMs: paceBudgetMs(batch.length), count: batch.length });

  for (const c of batch) {
    try {
      await pace();

      // The stored draft greets whoever the contact led with at the time it was written. If
      // the chosen recipient has changed since, re-render rather than send an email that
      // addresses somebody else.
      //
      // ⚠️ A STALE TEMPLATE IS THE SAME KIND OF PROBLEM, added 2026-08-20. `runJobPrepare`
      // re-renders old drafts, but it is capped by a draft limit and a time budget, so a row
      // it did not reach this morning still arrives here holding whatever the template got
      // wrong when it was written - and the v3 drafts in the queue right now name the LinkEdIn
      // POSTER as the employer. The version bump only protects anything if the sender checks
      // it too.
      let draft = c.draft;
      const staleTemplate = isStaleJobDraft(draft.model);
      if (staleTemplate || !greetingMatches(draft.text, c.greeting, c.greeted)) {
        if (isEditedJobDraft(draft.model)) {
          result.failed.push({
            company: companyLabel(c.job),
            to: c.to,
            error: `hand-edited draft does not open the way ${c.to} requires — fix or reset it`,
          });
          continue;
        }
        const regenerated = renderJobOutreach(
          c.job,
          c.greeting === 'person'
            ? { ...c.contact, people: [{ name: c.greeted }, ...c.contact.people] }
            : c.contact,
          { greeting: c.greeting }
        );
        if (!regenerated) {
          result.failed.push({
            company: companyLabel(c.job),
            to: c.to,
            error: 'could not render draft',
          });
          continue;
        }
        draft = regenerated;
        await saveJobOutreach(c.job.id, draft);
      }

      const sent = await sendOutreachMail({
        to: c.to,
        subject: draft.subject,
        text: draft.text,
        // Only reaches the agent card's log line, so the readable label is the right one here.
        company: companyLabel(c.job),
      });
      const sentAt = new Date().toISOString();
      await saveJobOutreach(c.job.id, { ...draft, sentAt, sentTo: c.to });
      await updateJobStatus(c.job.id, 'contacted');
      // Open the follow-up sequence with the real Message-ID, tagged `job` so the bumps use
      // the application copy rather than congratulating a recruiter on a funding round.
      await recordInitialSend({
        id: c.job.id,
        kind: 'job',
        // ⚠️ THE TRUSTED NAME, NOT THE READABLE LABEL. This one is INTERPOLATED into the
        // follow-up bodies three days from now ("still very interested in the role at ___"),
        // so it has to be EMPTY when the employer is unknown. The label would mail "the role
        // at posted by Fathima Sajid".
        company: employerName(c.job),
        to: c.to,
        // ⚠️ 'team', not '', on a team draft. `runFollowUps` refuses to bump a sequence with
        // an empty `greeted` — rightly, since it would open "Hi ," — so passing the empty
        // string here would strand every shared-inbox send with no follow-ups at all, and
        // report it as a failure three days later. "team" is also literally what the email
        // opened with, which is what a follow-up has to match.
        greeted: c.greeting === 'team' ? 'team' : c.greeted,
        subject: draft.subject,
        sentAt,
        messageId: sent.id,
      });
      result.sent.push({
        company: companyLabel(c.job),
        title: c.job.title,
        to: c.to,
        greeted: c.greeted,
        foundOn: c.foundOn,
      });
    } catch (e) {
      result.failed.push({ company: companyLabel(c.job), to: c.to, error: (e as Error).message });
    }
  }

  await recordAgentRun('job-mailer', {
    state: result.failed.length > 0 ? 'error' : 'ok',
    summary:
      `job applications sent ${result.sent.length}/${Math.min(cap, candidates.length)}` +
      ` (${candidates.length} eligible, cap ${cap})` +
      (blockedSharedInbox ? ` · ${blockedSharedInbox} shared-inbox only` : '') +
      (result.failed.length ? ` · ${result.failed.length} failed` : ''),
    stats: {
      sent: result.sent.length,
      eligible: candidates.length,
      cap,
      blockedSharedInbox,
      blockedNoPersonMatch,
    },
    error: result.failed.length
      ? result.failed.map((f) => `${f.company}: ${f.error}`).join(' · ')
      : null,
  });

  return result;
}
