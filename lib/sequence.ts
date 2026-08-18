import {
  getAllOutreachSequences,
  getOutreachSequence,
  saveOutreachSequence,
} from './storage';
import type { OutreachSend, OutreachSequence } from './types';

/**
 * Follow-up scheduling, kept separate from the runner in lib/followup.ts so that the two
 * places which START a sequence (the cron sender and the dashboard send action) do not have
 * to pull in imapflow to do it.
 *
 * THE CADENCE (user's choice, 2026-08-09): three follow-ups, then stop.
 *
 *   day 0    initial email
 *   day 3    follow-up 1   short bump, one concrete idea
 *   day 10   follow-up 2   lower the ask to a written reply
 *   day 24   follow-up 3   one line, closes the loop, invites nothing
 *
 * Gaps are measured from the PREVIOUS touch, not from day 0, so a sequence that starts late
 * or gets re-sent by hand keeps the same spacing.
 */
const OFFSET_DAYS: readonly number[] = [3, 7, 14];

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When follow-up number `step + 1` is due, given the last touch.
 *
 * Normalised to midnight UTC on the target day, NOT to the same time of day as the send.
 * The cron fires at 03:30 UTC: an email sent at 03:35 would otherwise come due at 03:35 three
 * days later, five minutes after that morning's cron had already run, and every follow-up
 * would silently slip a day.
 *
 * A due date landing on a weekend rolls forward to Monday. Nobody reads a cold follow-up on
 * Saturday, and a bump that arrives on Monday morning has not lost anything by waiting.
 */
export function dueAfter(from: string | Date, days: number): string {
  const base = new Date(from);
  const due = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()) + days * DAY_MS
  );
  const dow = due.getUTCDay();
  if (dow === 6) due.setUTCDate(due.getUTCDate() + 2); // Saturday
  if (dow === 0) due.setUTCDate(due.getUTCDate() + 1); // Sunday
  return due.toISOString();
}

/** The gap before the next follow-up, or null once all three have gone. */
function gapAfter(step: OutreachSequence['step']): number | null {
  return step >= OFFSET_DAYS.length ? null : OFFSET_DAYS[step];
}

/**
 * Record that an initial outreach email went out, starting its follow-up sequence.
 *
 * Called from both send paths with the real SendResult, because the Message-ID is only
 * available at the moment of sending and is what every later follow-up threads onto.
 */
export async function recordInitialSend(input: {
  id: string;
  company: string;
  to: string;
  greeted: string;
  subject: string;
  sentAt: string;
  messageId?: string;
  /** Which pipeline this came from, deciding the follow-up copy. Absent means funding. */
  kind?: OutreachSequence['kind'];
}): Promise<OutreachSequence> {
  const send: OutreachSend = {
    at: input.sentAt,
    to: input.to,
    kind: 'initial',
    subject: input.subject,
    ...(input.messageId ? { messageId: input.messageId } : {}),
  };

  const existing = await getOutreachSequence(input.id);

  // A re-send from the dashboard appends to the record instead of replacing it, and does not
  // resurrect a sequence that replied, bounced or was stopped. Reopening one of those would
  // mail a founder who has already been dealt with, which is the whole thing this guards.
  if (existing) {
    const reopened: OutreachSequence = {
      ...existing,
      to: input.to,
      subject: input.subject,
      rootMessageId: existing.rootMessageId ?? input.messageId,
      sends: [...existing.sends, send],
      ...(existing.state === 'active'
        ? { nextDueAt: dueAfter(input.sentAt, gapAfter(existing.step) ?? 0) }
        : {}),
    };
    await saveOutreachSequence(reopened);
    return reopened;
  }

  const seq: OutreachSequence = {
    id: input.id,
    ...(input.kind ? { kind: input.kind } : {}),
    company: input.company,
    to: input.to,
    greeted: input.greeted,
    subject: input.subject,
    ...(input.messageId ? { rootMessageId: input.messageId } : {}),
    sends: [send],
    step: 0,
    nextDueAt: dueAfter(input.sentAt, OFFSET_DAYS[0]),
    state: 'active',
  };
  await saveOutreachSequence(seq);
  return seq;
}

/** Record a follow-up that went out, then schedule the next one or close the sequence. */
export async function recordFollowUpSend(
  seq: OutreachSequence,
  send: OutreachSend
): Promise<OutreachSequence> {
  const step = (seq.step + 1) as OutreachSequence['step'];
  const gap = gapAfter(step);
  const updated: OutreachSequence = {
    ...seq,
    sends: [...seq.sends, send],
    step,
    ...(gap === null
      ? {
          nextDueAt: undefined,
          state: 'done',
          closedAt: send.at,
          closedReason: 'all three follow-ups sent',
        }
      : { nextDueAt: dueAfter(send.at, gap) }),
  };
  await saveOutreachSequence(updated);
  return updated;
}

/** Stop a sequence for good. Removing it from the due index is handled by the store. */
export async function closeSequence(
  seq: OutreachSequence,
  state: Extract<OutreachSequence['state'], 'replied' | 'bounced' | 'stopped'>,
  reason: string
): Promise<OutreachSequence> {
  const closed: OutreachSequence = {
    ...seq,
    nextDueAt: undefined,
    state,
    closedAt: new Date().toISOString(),
    closedReason: reason,
  };
  await saveOutreachSequence(closed);
  return closed;
}

/**
 * Who an email actually greeted, read back off the text that was sent.
 *
 * Preferred over re-deriving the name from the contact record: the contact can change after
 * the fact, and a follow-up must greet whoever the founder saw at the top of the first email.
 */
export function greetedIn(text: string): string | null {
  const m = /^\s*hi\s+([^,\n]+),/i.exec(text);
  return m ? m[1].trim() : null;
}

/** The Message-ID a new follow-up should reply to: the most recent touch that has one. */
export function lastMessageId(seq: OutreachSequence): string | undefined {
  for (let i = seq.sends.length - 1; i >= 0; i -= 1) {
    if (seq.sends[i].messageId) return seq.sends[i].messageId;
  }
  return undefined;
}

/** When we last wrote to them. The window a reply check searches. */
export function lastSentAt(seq: OutreachSequence): Date {
  const last = seq.sends[seq.sends.length - 1];
  return new Date(last?.at ?? seq.nextDueAt ?? Date.now());
}


/**
 * Every address this project has EVER sent an initial email to, both pipelines, lowercased.
 *
 * ⚠️ THE GUARD THIS EXISTS TO PROVIDE IS ACROSS RUNS, AND UNTIL 2026-08-18 THERE WAS NONE.
 * Both senders deduplicate by address and company inside a single run, which is why the
 * comment there says "never twice to the same person" — but the only thing stopping a second
 * email the NEXT morning was per-row state (`draft.sentAt`, `status !== 'new'`), and a row is
 * one job posting. Two postings from the same company, or one posting arriving from two
 * sources under different ids, are two rows that never learn about each other. That sent
 * careers@cloudsecurityweb.com the same application twice.
 *
 * A sequence is written by `recordInitialSend` for every send in both pipelines and is never
 * deleted when it closes, so `followup:all` is the durable record of who has been written to.
 * Reading it costs one index read plus one pipelined fetch, once per run.
 */
export async function mailedAddresses(): Promise<Set<string>> {
  const all = await getAllOutreachSequences();
  return new Set(all.map((s) => s.to.trim().toLowerCase()).filter(Boolean));
}

/**
 * Of the sequences handed in, the ones whose recipient is ALREADY served by an earlier live
 * sequence. Returns the later duplicates; the earliest holder of an address is never in it.
 *
 * "Earlier" is by first send, not by id: the recipient has seen that thread, and a follow-up
 * threads against its own root Message-ID, so continuing the older one is the only choice
 * that lands in the conversation they actually have.
 *
 * Closed sequences are ignored deliberately. One that ended because the person REPLIED must
 * not suppress a later application to the same address forever - that is the sender's job to
 * prevent up front, and it now does.
 */
export async function duplicateRecipientSequences(
  among: OutreachSequence[]
): Promise<OutreachSequence[]> {
  if (among.length === 0) return [];
  const all = await getAllOutreachSequences();

  const firstSentAt = (s: OutreachSequence) =>
    s.sends.length > 0 ? Math.min(...s.sends.map((x) => Date.parse(x.at))) : Infinity;

  const earliestByAddress = new Map<string, OutreachSequence>();
  for (const s of all) {
    if (s.state !== 'active') continue;
    const key = s.to.trim().toLowerCase();
    const held = earliestByAddress.get(key);
    if (!held || firstSentAt(s) < firstSentAt(held)) earliestByAddress.set(key, s);
  }

  return among.filter((s) => {
    const holder = earliestByAddress.get(s.to.trim().toLowerCase());
    return Boolean(holder) && holder!.id !== s.id;
  });
}

/**
 * Addresses a previous send BOUNCED on, lowercased.
 *
 * Repeatedly mailing addresses that do not exist is one of the few things that genuinely
 * damages a sender's standing with Gmail — far more than wording or send times, which is
 * where people usually look first. The follow-up runner already detects bounces and closes
 * those sequences, but nothing stopped the SENDERS from writing to the same address again on
 * a different row, and Hunter-derived addresses on small Indian startups bounce often.
 *
 * Read together with `mailedAddresses` — that one stops a second email to somebody real, this
 * one stops a second email to somebody who does not exist.
 */
export async function bouncedAddresses(): Promise<Set<string>> {
  const all = await getAllOutreachSequences();
  return new Set(
    all
      .filter((s) => s.state === 'bounced')
      .map((s) => s.to.trim().toLowerCase())
      .filter(Boolean)
  );
}
