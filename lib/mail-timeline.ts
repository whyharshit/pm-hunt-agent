import { dueAfter, firstSentAt } from './sequence';
import type { OutreachSequence } from './types';

/**
 * One conversation, as a list of things that happened to it.
 *
 * WHY THIS EXISTS. Every fact about an email thread was already stored — `sends[]` carries a
 * timestamp per touch, `step` counts the bumps, `state` records how it ended — and none of it
 * was READABLE anywhere. /funding showed a status word per row, /jobs showed "✓ applied 3d
 * ago", and the question a person actually asks ("what has this thread done, and when?") had
 * no answer short of the Redis key. That is how a follow-up went out seven hours after a reply
 * without anyone noticing until the recruiter's mail was read by hand.
 *
 * Pure, and deliberately so: the page renders what this returns and decides nothing itself. A
 * timeline computed inside JSX is a timeline nothing can pin.
 */

export type MailEventKind = 'sent' | 'followup' | 'reply' | 'bounce' | 'stopped' | 'spent' | 'due';

export type MailEvent = {
  kind: MailEventKind;
  /** ISO. In the FUTURE for `due`, which is the only forward-looking event. */
  at: string;
  /** What to show: "first email", "follow-up 2", "reply from x@y". */
  label: string;
  /** Present when the event involves an address other than the obvious one. */
  address?: string;
  /**
   * True when the timestamp is when WE noticed rather than when it happened. A reply on a
   * sequence closed before the reply record existed only has `closedAt` to go on, and showing
   * that as the reply time would overstate how slowly they answered.
   */
  approximate?: boolean;
};

const FOLLOWUP_LABEL: Record<number, string> = {
  1: 'follow-up 1',
  2: 'follow-up 2',
  3: 'follow-up 3',
};

/** The label for one send, from its recorded kind. */
function sendLabel(kind: OutreachSequence['sends'][number]['kind']): string {
  if (kind === 'initial') return 'first email';
  const n = Number(kind.slice('followup-'.length));
  return FOLLOWUP_LABEL[n] ?? `follow-up ${n}`;
}

/**
 * Everything that has happened on this sequence, oldest first, with the next due bump last.
 *
 * ⚠️ THE REPLY IS PLACED AT THE TIME THEY WROTE, not at the time the cron found it, and those
 * are different: on the thread that prompted this file they were 02:03 and 09:29 the same
 * morning, with a follow-up sent in between. A timeline that used the noticing time would show
 * the reply AFTER the follow-up it should have prevented, i.e. it would hide the bug.
 */
export function mailTimeline(seq: OutreachSequence, now = new Date()): MailEvent[] {
  const events: MailEvent[] = seq.sends.map((s) => ({
    kind: s.kind === 'initial' ? ('sent' as const) : ('followup' as const),
    at: s.at,
    label: sendLabel(s.kind),
    address: s.to,
  }));

  if (seq.state === 'replied') {
    const from = seq.reply?.from ?? seq.to;
    // `reply.at` when we have it, else `noticedAt`, else the close time — each one a step
    // further from the truth, so the flag goes on as soon as we are past the first.
    const at = seq.reply?.at ?? seq.reply?.noticedAt ?? seq.closedAt ?? seq.sends.at(-1)?.at;
    events.push({
      kind: 'reply',
      at: at ?? new Date(now).toISOString(),
      label: `reply from ${from}${seq.reply?.how === 'colleague' ? ' (a colleague of the inbox)' : ''}`,
      address: from,
      approximate: !seq.reply?.at,
    });
  } else if (seq.state === 'bounced') {
    events.push({
      kind: 'bounce',
      at: seq.closedAt ?? seq.sends.at(-1)?.at ?? new Date(now).toISOString(),
      label: `bounced · ${seq.closedReason ?? 'address rejected the mail'}`,
      address: seq.to,
      approximate: true,
    });
  } else if (seq.state === 'stopped') {
    events.push({
      kind: 'stopped',
      at: seq.closedAt ?? new Date(now).toISOString(),
      label: `stopped · ${seq.closedReason ?? 'closed by hand'}`,
      approximate: true,
    });
  } else if (seq.state === 'done') {
    events.push({
      kind: 'spent',
      at: seq.closedAt ?? seq.sends.at(-1)?.at ?? new Date(now).toISOString(),
      label: 'all three follow-ups sent, no answer',
    });
  }

  events.sort((a, b) => +new Date(a.at) - +new Date(b.at));

  // The forward-looking one, appended after the sort so it is always last even when the due
  // date has slipped into the past (a cron that has not fired yet, or a pass that declined for
  // lack of time — see lib/invocation-clock.ts).
  if (seq.state === 'active' && seq.nextDueAt) {
    events.push({
      kind: 'due',
      at: seq.nextDueAt,
      label: `${FOLLOWUP_LABEL[Math.min(seq.step + 1, 3)]} due`,
    });
  }

  return events;
}

/**
 * When this thread last did anything, for sorting the list. Future due dates do not count:
 * they would float a silent thread above one that got a reply an hour ago.
 */
export function lastActivityAt(seq: OutreachSequence): Date {
  const past = mailTimeline(seq).filter((e) => e.kind !== 'due');
  const last = past.at(-1);
  return last ? new Date(last.at) : firstSentAt(seq);
}

/**
 * Does this thread want the USER, as opposed to the cron?
 *
 * Exactly one thing does: somebody answered. A reply is the only state in this system that no
 * agent can act on — the Rovia reply was an assignment with a deadline — so it is the only one
 * that earns the top of the page.
 */
export function needsAttention(seq: OutreachSequence): boolean {
  return seq.state === 'replied';
}

/** Is the next bump overdue, i.e. has a run failed to send it? Diagnostic, not decorative. */
export function isOverdue(seq: OutreachSequence, now = new Date()): boolean {
  if (seq.state !== 'active' || !seq.nextDueAt) return false;
  // One whole day of slack: the cron fires once a day, so a bump due this morning is not late
  // until tomorrow's fire has also missed it. `dueAfter` is the same arithmetic the scheduler
  // uses, so "late" and "due" can never drift apart.
  return +now > +new Date(dueAfter(seq.nextDueAt, 1));
}
