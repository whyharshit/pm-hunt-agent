import { getOutreachSequence, saveOutreachSequence } from './storage';
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
