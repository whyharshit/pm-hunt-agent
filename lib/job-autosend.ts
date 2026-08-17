import { addressLooksLikePerson, isGenericEmail } from './contact';
import { isEditedJobDraft, renderJobOutreach } from './job-outreach-template';
import { sendOutreachMail } from './mailer';
import { firstName } from './outreach-template';
import { createPacer } from './pace';
import { readResumePdf } from './resume-file';
import { recordInitialSend } from './sequence';
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

/** Pacing budget. Smaller than the founder sender's 70s: it shares the same 300s invocation. */
const PACE_BUDGET_MS = 40_000;

/** How many rows a dry run lists. Enough to judge the queue, short of an unreadable dump. */
const DRY_RUN_LIST_LIMIT = 25;

export function jobSendCap(): number {
  const raw = process.env.JOB_SEND_MAX_PER_DAY;
  if (raw === undefined || raw.trim() === '') return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** Addresses trusted enough to mail unattended. On a job row the post itself is the best one. */
function trustedProvenance(e: ContactEmail): boolean {
  return /the job post itself|hunter\.io|added by hand/i.test(e.foundOn);
}

/** Does the draft already open by greeting this person? */
function greetingMatches(text: string, person: string): boolean {
  return new RegExp(`^\\s*hi\\s+${firstName(person)}\\b`, 'i').test(text);
}

export type JobSendCandidate = {
  job: Job;
  draft: JobOutreach;
  contact: JobContact;
  to: string;
  greeted: string;
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
      (e) => trustedProvenance(e) && !NEVER_SEND_TO.includes(e.address.toLowerCase())
    );
    if (usable.length === 0) continue;

    // Shared inboxes are counted before being discarded, so the report can say how many rows
    // a "Hi team," variant of the template would unlock.
    const personal = usable.filter((e) => !isGenericEmail(e.address));
    if (personal.length === 0) {
      blockedSharedInbox += 1;
      continue;
    }

    // Whoever receives it must be who the email greets. Not a policy preference: it is the
    // difference between "Hi Ananya" reaching Ananya and reaching her colleague.
    const chosen = personal.find((e) => e.person && addressLooksLikePerson(e.address, e.person));
    if (!chosen?.person) {
      blockedNoPersonMatch += 1;
      continue;
    }

    out.push({
      job,
      draft,
      contact,
      to: chosen.address,
      greeted: chosen.person,
      foundOn: chosen.foundOn,
    });
  }

  // Freshest posting first: if the cap bites, it should bite on the least timely row.
  out.sort((a, b) => +new Date(b.job.postedAt) - +new Date(a.job.postedAt));

  // Never twice to the same person or the same company in one run. Two sources can carry the
  // same role under different ids, and two emails to one recruiter in one morning is the most
  // spam-like thing this could do.
  const seenAddress = new Set<string>();
  const seenCompany = new Set<string>();
  const candidates = out.filter((c) => {
    const address = c.to.toLowerCase();
    const company = c.job.company.toLowerCase().replace(/[^a-z0-9]/g, '');
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
      company: c.job.company,
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
  const pace = createPacer({ budgetMs: PACE_BUDGET_MS, count: batch.length });

  for (const c of batch) {
    try {
      await pace();

      // The stored draft greets whoever the contact led with at the time it was written. If
      // the chosen recipient has changed since, re-render rather than send an email that
      // addresses somebody else.
      let draft = c.draft;
      if (!greetingMatches(draft.text, c.greeted)) {
        if (isEditedJobDraft(draft.model)) {
          result.failed.push({
            company: c.job.company,
            to: c.to,
            error: `hand-edited draft greets someone other than ${c.greeted} — fix or reset it`,
          });
          continue;
        }
        const regenerated = renderJobOutreach(c.job, {
          ...c.contact,
          people: [{ name: c.greeted }, ...c.contact.people],
        });
        if (!regenerated) {
          result.failed.push({ company: c.job.company, to: c.to, error: 'could not render draft' });
          continue;
        }
        draft = regenerated;
        await saveJobOutreach(c.job.id, draft);
      }

      const sent = await sendOutreachMail({
        to: c.to,
        subject: draft.subject,
        text: draft.text,
        company: c.job.company,
      });
      const sentAt = new Date().toISOString();
      await saveJobOutreach(c.job.id, { ...draft, sentAt, sentTo: c.to });
      await updateJobStatus(c.job.id, 'contacted');
      // Open the follow-up sequence with the real Message-ID, tagged `job` so the bumps use
      // the application copy rather than congratulating a recruiter on a funding round.
      await recordInitialSend({
        id: c.job.id,
        kind: 'job',
        company: c.job.company,
        to: c.to,
        greeted: c.greeted,
        subject: draft.subject,
        sentAt,
        messageId: sent.id,
      });
      result.sent.push({
        company: c.job.company,
        title: c.job.title,
        to: c.to,
        greeted: c.greeted,
        foundOn: c.foundOn,
      });
    } catch (e) {
      result.failed.push({ company: c.job.company, to: c.to, error: (e as Error).message });
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
