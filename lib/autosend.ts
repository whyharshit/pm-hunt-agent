import { addressLooksLikePerson, isGenericEmail } from './contact';
import { sendOutreachMail } from './mailer';
import { readResumePdf } from './resume-file';
import { MAX_AGE_DAYS } from './sources/techcrunch';
import {
  getFundingContacts,
  getFundingOutreaches,
  getRecentFunding,
  recordAgentRun,
  saveFundingOutreach,
  setAgentRunning,
  updateFundingStatus,
} from './storage';
import type { ContactEmail, FundingContact, FundingItem, FundingOutreach } from './types';

/**
 * Send founder outreach without a human click. User's explicit standing instruction
 * (2026-08-09): "for founders whose contact email is correctly found using hunter send
 * emails automatically instead of me pressing send button. send in morning time."
 *
 * This is the only place in the project that acts on the outside world unsupervised, so
 * every gate below is deliberate. A wrong send cannot be recalled: it reaches a real
 * founder, from the user's real Gmail, and it is their reputation on the line.
 *
 * THE GATES
 *  1. `AUTO_SEND_MAX_PER_DAY` doubles as the kill switch — set it to 0 and nothing sends,
 *     no deploy needed. Unset defaults to a deliberately small number, because a burst of
 *     cold email from a personal Gmail is what gets an address flagged as spam.
 *  2. The address must belong to the person the email greets. `addressLooksLikePerson` is
 *     the check that stopped "Hi Paolo," going to booking@weroad.com; without it a
 *     denylist alone leaked `care@`, `connect@`, `supplier@`, `coordinators@`.
 *  3. Provenance must be Hunter or hand-added. A scraped page address is what produced the
 *     shared-inbox problem in the first place, and the user said "found using hunter".
 *  4. The raise must still be recent. Congratulating a founder on a stale round is worse
 *     than silence, and unattended is exactly when nobody would notice.
 *  5. The user's own test inboxes can never receive outreach.
 */

/** Never outreach to the user's own addresses — they are test recipients. */
const NEVER_SEND_TO = [
  'shivanshch001@gmail.com',
  'hr.lovng@gmail.com',
  'shivanshchaudhary.iitkgp@gmail.com',
  'hello@lovingroom.co',
];

/** Addresses we trust enough to mail unattended. A page scrape is not one of them. */
function trustedProvenance(e: ContactEmail): boolean {
  return /hunter\.io|added by hand/i.test(e.foundOn);
}

export function autoSendCap(): number {
  const raw = process.env.AUTO_SEND_MAX_PER_DAY;
  if (raw === undefined || raw.trim() === '') return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export type AutoSendCandidate = {
  item: FundingItem;
  draft: FundingOutreach;
  contact: FundingContact;
  to: string;
  greeted: string;
};

/**
 * Rows eligible to send unattended. Exported so a dry run can show exactly what WOULD go
 * out — never trust an unattended sender you cannot inspect first.
 */
export async function autoSendCandidates(): Promise<AutoSendCandidate[]> {
  const items = await getRecentFunding(200);
  const ids = items.map((i) => i.id);
  const [drafts, contacts] = await Promise.all([getFundingOutreaches(ids), getFundingContacts(ids)]);

  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const out: AutoSendCandidate[] = [];

  for (const item of items) {
    if (item.status !== 'new') continue;
    if (Date.parse(item.postedAt) < cutoff) continue;

    const draft = drafts.get(item.id);
    if (!draft || draft.sentAt) continue;

    const contact = contacts.get(item.id);
    const greeted = contact?.founders[0]?.name;
    if (!contact || !greeted) continue;

    const match = contact.emails.find(
      (e) =>
        trustedProvenance(e) &&
        !isGenericEmail(e.address) &&
        addressLooksLikePerson(e.address, greeted) &&
        !NEVER_SEND_TO.includes(e.address.toLowerCase())
    );
    if (!match) continue;

    out.push({ item, draft, contact, to: match.address, greeted });
  }

  // Freshest raise first: if the cap bites, it should bite on the least timely row.
  return out.sort((a, b) => Date.parse(b.item.postedAt) - Date.parse(a.item.postedAt));
}

export type AutoSendResult = {
  cap: number;
  eligible: number;
  sent: Array<{ company: string; to: string }>;
  failed: Array<{ company: string; to: string; error: string }>;
  dryRun: boolean;
  /**
   * Whether the resume is readable IN THIS RUNTIME. The build trace proves the file was
   * bundled; only reading it inside a deployed function proves it can be attached. Reported
   * on the dry run so a missing attachment is caught before a founder receives an email
   * without one.
   */
  resumeKB: number | null;
};

/**
 * `dryRun` reports what would be sent and touches nothing. The cron calls it for real; use
 * the dry run to inspect the queue before trusting a schedule change.
 */
export async function runAutoSend(opts: { dryRun?: boolean } = {}): Promise<AutoSendResult> {
  const dryRun = opts.dryRun ?? false;
  const cap = autoSendCap();
  const candidates = await autoSendCandidates();
  const batch = candidates.slice(0, cap);

  const resume = await readResumePdf();
  const result: AutoSendResult = {
    cap,
    eligible: candidates.length,
    sent: [],
    failed: [],
    dryRun,
    resumeKB: resume ? Math.round(resume.length / 1024) : null,
  };

  if (dryRun) {
    result.sent = batch.map((c) => ({ company: c.item.company, to: c.to }));
    return result;
  }

  if (cap === 0) {
    await recordAgentRun('mailer', {
      state: 'ok',
      summary: `auto-send off (AUTO_SEND_MAX_PER_DAY=0) · ${candidates.length} would qualify`,
      error: null,
    });
    return result;
  }

  await setAgentRunning('mailer');

  for (const c of batch) {
    try {
      await sendOutreachMail({
        to: c.to,
        subject: c.draft.subject || `${c.item.company} — quick note`,
        text: c.draft.text,
        company: c.item.company,
      });
      await saveFundingOutreach(c.item.id, {
        ...c.draft,
        sentAt: new Date().toISOString(),
        sentTo: c.to,
      });
      await updateFundingStatus(c.item.id, 'contacted');
      result.sent.push({ company: c.item.company, to: c.to });
    } catch (e) {
      result.failed.push({ company: c.item.company, to: c.to, error: (e as Error).message });
    }
  }

  await recordAgentRun('mailer', {
    state: result.failed.length > 0 ? 'error' : 'ok',
    summary:
      `auto-sent ${result.sent.length}/${Math.min(cap, candidates.length)}` +
      ` (${candidates.length} eligible, cap ${cap})` +
      (result.failed.length ? ` · ${result.failed.length} failed` : ''),
    stats: { sent: result.sent.length, eligible: candidates.length, cap },
    error: result.failed.length ? result.failed.map((f) => `${f.company}: ${f.error}`).join(' · ') : null,
  });

  return result;
}
