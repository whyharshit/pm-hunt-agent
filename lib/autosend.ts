import { addressLooksLikePerson, isGenericEmail } from './contact';
import { sendOutreachMail } from './mailer';
import { firstName, isEditedDraft, renderOutreachTemplate } from './outreach-template';
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

/** Does the draft already open by greeting this person's first name? */
function greetingMatches(text: string, person: string): boolean {
  return new RegExp(`^\\s*hi\\s+${firstName(person)}\\b`, 'i').test(text);
}

/** Addresses we trust enough to mail unattended. A page scrape is not one of them. */
function trustedProvenance(e: ContactEmail): boolean {
  return /hunter\.io|added by hand/i.test(e.foundOn);
}

/**
 * A domain that a web search guessed is NOT safe to mail unattended.
 *
 * Caught by a dry run 2026-08-09, one cron away from going out: the row was "Amigo", a
 * Kolkata startup that raised ₹4.5 Cr pre-seed (founders Anshuk Sengupta, Saswata C.).
 * Search resolved "Amigo" to amigo.ai — a different American company entirely — Hunter
 * happily returned its staff, and the sender was about to greet "Hi Ali" and congratulate
 * a stranger on someone else's round.
 *
 * Common-word company names (Amigo, Scape, Moove, River) match many domains, and the
 * name-relates-to-domain test cannot tell them apart. So search-resolved rows stay visible
 * on the dashboard for a human to confirm, and are excluded from unattended sending. A
 * domain Hunter resolved itself, or a contact added by hand, is unaffected.
 */
function domainUnverified(contact: FundingContact): boolean {
  return /found by web search/i.test(contact.note ?? '');
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
  /** False when falling back to an employee, so the report shows which is which. */
  isFounder: boolean;
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
    if (!contact) continue;
    if (domainUnverified(contact)) continue;

    const usable = contact.emails.filter(
      (e) =>
        trustedProvenance(e) &&
        !isGenericEmail(e.address) &&
        !NEVER_SEND_TO.includes(e.address.toLowerCase())
    );
    if (usable.length === 0) continue;

    // FOUNDER FIRST, employee as fallback (user's instruction 2026-08-09: "put founder on
    // priority but if cannot find send emails to employee also"). Hunter already ranks
    // decision-makers and executives ahead of everyone else, so the first usable address is
    // the most senior person it knows.
    const founderNames = contact.founders.map((f) => f.name);
    const founderMatch = usable.find((e) =>
      founderNames.some((n) => addressLooksLikePerson(e.address, n))
    );
    const chosen = founderMatch ?? usable.find((e) => e.person) ?? null;
    if (!chosen) continue;

    // Whoever receives it must be who the email greets. That is not a policy choice, it is
    // the difference between "Hi Dimitris" reaching Dimitris and reaching a colleague.
    const greeted =
      (founderMatch
        ? founderNames.find((n) => addressLooksLikePerson(chosen.address, n))
        : chosen.person) ?? chosen.person;
    if (!greeted || !addressLooksLikePerson(chosen.address, greeted)) continue;

    out.push({
      item,
      draft,
      contact,
      to: chosen.address,
      greeted,
      isFounder: Boolean(founderMatch),
    });
  }

  // Freshest raise first: if the cap bites, it should bite on the least timely row.
  out.sort((a, b) => Date.parse(b.item.postedAt) - Date.parse(a.item.postedAt));

  // Never twice to the same person or the same company in one run. Duplicate rows for one
  // raise do survive into the queue — a dry run on 2026-08-09 had Hadrian listed twice,
  // which would have sent tom.leach@hadrian.co the identical email twice in one morning,
  // the single most spam-like thing this could do. The company-level scan dedupe runs at
  // fetch time and cannot catch rows that were already stored separately, so the guard
  // belongs here too, at the last point before sending.
  const seenAddress = new Set<string>();
  const seenCompany = new Set<string>();
  return out.filter((c) => {
    const address = c.to.toLowerCase();
    const company = c.item.company.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (seenAddress.has(address) || seenCompany.has(company)) return false;
    seenAddress.add(address);
    seenCompany.add(company);
    return true;
  });
}

export type AutoSendResult = {
  cap: number;
  eligible: number;
  sent: Array<{ company: string; to: string; greeted?: string; isFounder?: boolean }>;
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
    result.sent = batch.map((c) => ({
      company: c.item.company,
      to: c.to,
      greeted: c.greeted,
      isFounder: c.isFounder,
    }));
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
      // The stored draft greets founders[0]; falling back to an employee means it now
      // greets the wrong person. Re-render against whoever is actually receiving it.
      let draft = c.draft;
      if (!greetingMatches(draft.text, c.greeted)) {
        if (isEditedDraft(draft.model)) {
          // Hand-written copy is not ours to rewrite. Leave it for the human rather than
          // sending it to someone it does not address.
          result.failed.push({
            company: c.item.company,
            to: c.to,
            error: `hand-edited draft greets someone other than ${c.greeted} — fix or reset it`,
          });
          continue;
        }
        const regenerated = renderOutreachTemplate(c.item, {
          ...c.contact,
          founders: [{ name: c.greeted }, ...c.contact.founders],
        });
        if (!regenerated) {
          result.failed.push({ company: c.item.company, to: c.to, error: 'could not render draft' });
          continue;
        }
        draft = regenerated;
        await saveFundingOutreach(c.item.id, draft);
      }

      await sendOutreachMail({
        to: c.to,
        subject: draft.subject || `${c.item.company} — quick note`,
        text: draft.text,
        company: c.item.company,
      });
      await saveFundingOutreach(c.item.id, {
        ...draft,
        sentAt: new Date().toISOString(),
        sentTo: c.to,
      });
      await updateFundingStatus(c.item.id, 'contacted');
      result.sent.push({ company: c.item.company, to: c.to, greeted: c.greeted, isFounder: c.isFounder });
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
