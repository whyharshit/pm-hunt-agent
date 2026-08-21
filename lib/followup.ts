import { renderFollowUp } from './followup-template';
import { hasBounceFor, hasReplyFrom, findSentMessageId, imapConfigured, withImap } from './imap';
import { unboundedClock, type InvocationClock } from './invocation-clock';
import { sendOutreachMail } from './mailer';
import { firstName } from './outreach-template';
import { createPacer, noPacing } from './pace';
import {
  closeSequence,
  duplicateRecipientSequences,
  dueAfter,
  greetedIn,
  lastMessageId,
  lastSentAt,
  recordFollowUpSend,
} from './sequence';
import {
  getDueSequences,
  getFundingContacts,
  getFundingOutreaches,
  getOutreachSequence,
  getRecentFunding,
  recordAgentRun,
  saveOutreachSequence,
  setAgentRunning,
} from './storage';
import type { OutreachSend, OutreachSequence } from './types';

/**
 * The follow-up pass: up to three bumps per founder, sent unattended on the same cron as the
 * initial outreach (Vercel Hobby allows two crons and both are already taken).
 *
 * THE GATES, in the same spirit as lib/autosend.ts. This also acts on the outside world with
 * nobody watching, and a follow-up to someone who already replied is worse than a cold email
 * to a stranger: it says nobody on this side is reading.
 *
 *  1. `FOLLOW_UP_MAX_PER_RUN` doubles as the kill switch. Deliberately SEPARATE from
 *     `AUTO_SEND_MAX_PER_DAY` so that pausing cold sends does not strand sequences already in
 *     flight, and pausing follow-ups does not stop new outreach.
 *  2. A reply closes the sequence, always, before anything is sent.
 *  3. A bounce closes it too. Bumping a dead address three more times is how a sending
 *     reputation gets shredded.
 *  4. NO IMAP, NO SEND. If the mailbox cannot be read, this pass cannot know who answered, so
 *     it does nothing and says why. Failing open here would mail every founder who replied.
 *  5. The raise-recency gate does NOT apply. `MAX_AGE_DAYS` exists so nobody congratulates a
 *     founder on a stale round; a follow-up bumps a conversation that is already open, and by
 *     day 24 that gate would silently swallow the last touch.
 *
 * Re-running the pass is safe: sending advances `nextDueAt`, so a second cron fire in the
 * same day finds nothing due. That is the bug latent in `AUTO_SEND_MAX_PER_DAY`, which is a
 * per-invocation cap despite its name, and this pass does not inherit it.
 */

/** Same reasoning as the cold-send budget in lib/autosend.ts: both share one invocation. */
const PACE_BUDGET_MS = 70_000;

/**
 * Below this the pass does not start — and here that means it does not open IMAP either.
 *
 * The floor is higher than the senders' because this pass pays for a mailbox session before
 * it can send anything: connect, then a reply search and a bounce search per sequence. Half a
 * budget buys the session and then runs out mid-queue, which is the worst outcome available —
 * so it declines. Nothing is lost by declining: sending is what advances `nextDueAt`, so
 * every bump skipped here is due again on the next fire.
 */
const MIN_FOLLOWUP_MS = 25_000;

export function followUpCap(): number {
  const raw = process.env.FOLLOW_UP_MAX_PER_RUN;
  if (raw === undefined || raw.trim() === '') return 5;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

export type FollowUpResult = {
  cap: number;
  /** Sequences created this run for emails that predate sequences. Normally 0 after day one. */
  backfilled: number;
  /** Sequences whose next touch was due at run time. */
  due: number;
  sent: Array<{ company: string; to: string; step: number; threaded: boolean }>;
  /** Sequences closed by this run instead of mailed. */
  stopped: Array<{ company: string; to: string; reason: 'replied' | 'bounced' }>;
  failed: Array<{ company: string; to: string; error: string }>;
  dryRun: boolean;
  /** Set when the mailbox could not be read. Nothing is sent when it is. */
  imapError: string | null;
  /**
   * The shared invocation clock was spent before this pass began, so the mailbox was never
   * opened and `due` is 0 because nothing was counted — not because nothing was due.
   */
  outOfTime?: boolean;
};

/**
 * `dryRun` still performs the reply and bounce checks, because they are reads and because a
 * rehearsal that skipped them would report follow-ups going to people who have already
 * answered. It writes nothing and sends nothing.
 */
export async function runFollowUps(
  opts: { dryRun?: boolean; clock?: InvocationClock } = {}
): Promise<FollowUpResult> {
  const dryRun = opts.dryRun ?? false;
  const cap = followUpCap();
  const clock = opts.clock ?? unboundedClock;

  // ⚠️ CHECKED BEFORE THE BACKFILL, which is the first thing that opens IMAP. Everything
  // below this line costs a mailbox session, and a session paid for out of a spent budget is
  // a session that gets killed halfway through the queue.
  if (cap > 0 && !clock.canAfford(MIN_FOLLOWUP_MS)) {
    const out: FollowUpResult = {
      cap,
      backfilled: 0,
      due: 0,
      sent: [],
      stopped: [],
      failed: [],
      dryRun,
      imapError: null,
      outOfTime: true,
    };
    if (!dryRun) {
      await recordAgentRun('mailer', {
        state: 'error',
        summary: 'follow-ups skipped — the invocation clock was spent before the mailbox opened',
        error: 'out of time: earlier passes in this invocation used the budget',
      });
    }
    return out;
  }

  // Self-heal before reading the queue. Any email sent without a sequence — the batch that
  // predates this feature, or a send that failed midway — is adopted here, so the system
  // never depends on someone remembering to fire a one-off admin call. It also has to work
  // this way in practice: `/api/admin` needs a bearer secret that is deliberately not
  // shareable, while the cron authenticates as Vercel and can do it unattended.
  //
  // Cheap to repeat: after the first run nothing is pending, and the backfill returns
  // before opening an IMAP connection. A dry run stays read-only and skips it.
  const backfill = dryRun ? null : await backfillSequences();

  const due = await getDueSequences(new Date());

  // ⚠️ DUPLICATE RECIPIENTS MULTIPLY HERE, WHICH IS WHY THIS RUNS BEFORE ANYTHING IS SENT.
  // Until 2026-08-18 neither sender had an across-run address guard, so one address could
  // open TWO sequences on two different days (careers@cloudsecurityweb.com did). The senders
  // are fixed, but a duplicate that already exists is worse than the single extra email that
  // created it: each sequence bumps three times, so the address is queued for six more.
  //
  // The EARLIEST sequence survives - it is the one whose thread the recipient has already
  // seen, and the follow-ups quote their own root Message-ID. The later one is stopped, not
  // deleted: the send it records really happened, and erasing it would let the backfill adopt
  // that same sent email all over again.
  const stale = dryRun ? [] : await duplicateRecipientSequences(due);
  for (const seq of stale) {
    await closeSequence(seq, 'stopped', 'duplicate recipient - an earlier sequence has this address');
  }
  const staleIds = new Set(stale.map((seq) => seq.id));

  const result: FollowUpResult = {
    cap,
    backfilled: backfill?.created ?? 0,
    due: due.length,
    sent: [],
    stopped: [],
    failed: [],
    dryRun,
    imapError: null,
  };

  if (due.length === 0) {
    // Adopting sequences is the only visible sign the backfill ran, and the admin endpoint
    // that would otherwise report it needs a secret the user cannot share. Put it on the
    // agent card so the dashboard tells the story on its own.
    if (result.backfilled > 0) {
      await recordAgentRun('mailer', {
        state: backfill?.imapError ? 'error' : 'ok',
        summary:
          `adopted ${result.backfilled} sent email${result.backfilled > 1 ? 's' : ''} into ` +
          `follow-up sequences (${backfill?.unthreaded ?? 0} without a thread id) · none due yet`,
        stats: { backfilled: result.backfilled, due: 0 },
        error: backfill?.imapError ?? null,
      });
    }
    return result;
  }

  if (cap === 0) {
    if (!dryRun) {
      await recordAgentRun('mailer', {
        state: 'ok',
        summary: `follow-ups off (FOLLOW_UP_MAX_PER_RUN=0) · ${due.length} due`,
        error: null,
      });
    }
    return result;
  }

  if (!imapConfigured()) {
    result.imapError =
      'IMAP not configured (GMAIL_USER + GMAIL_APP_PASSWORD) — cannot tell who replied, so nothing was sent';
    // Recorded, not just returned. This is a silent no-op otherwise, and the admin endpoint
    // that would reveal it needs a secret the user cannot share, so the agent card is the
    // only place the truth can surface.
    if (!dryRun) {
      await recordAgentRun('mailer', { state: 'error', error: result.imapError });
    }
    return result;
  }

  if (!dryRun) await setAgentRunning('mailer');

  // Follow-ups get spaced apart for the same reason cold sends do. A dry run never waits.
  const pace = dryRun
    ? noPacing
    : createPacer({ budgetMs: clock.grant(PACE_BUDGET_MS), count: Math.min(cap, due.length) });

  try {
    await withImap(async (client) => {
      for (const seq of due) {
        if (staleIds.has(seq.id)) continue;
        if (seq.state !== 'active') continue;
        const since = lastSentAt(seq);

        try {
          if (await hasReplyFrom(client, seq.to, since)) {
            if (!dryRun) await closeSequence(seq, 'replied', `reply from ${seq.to}`);
            result.stopped.push({ company: seq.company, to: seq.to, reason: 'replied' });
            continue;
          }
          if (await hasBounceFor(client, seq.to, since)) {
            if (!dryRun) await closeSequence(seq, 'bounced', `bounce for ${seq.to}`);
            result.stopped.push({ company: seq.company, to: seq.to, reason: 'bounced' });
            continue;
          }

          // The cap bounds SENDS, not checks. Rows past it keep their due date and are picked
          // up by the next run, but their replies are still noticed today rather than being
          // blocked behind a queue.
          if (result.sent.length >= cap) continue;

          // Same rule the initial template follows: no name, no email. A follow-up opening
          // "Hi ," is worse than no follow-up, and this is the last point that can catch it.
          // Reached only by a legacy LLM draft that never greeted anyone by name.
          if (!seq.greeted.trim()) {
            result.failed.push({
              company: seq.company,
              to: seq.to,
              error: 'sequence has no greeted name — would open "Hi ,"',
            });
            continue;
          }

          const step = (seq.step + 1) as 1 | 2 | 3;
          const { subject, text } = renderFollowUp(seq, step);
          const inReplyTo = lastMessageId(seq);

          if (dryRun) {
            result.sent.push({
              company: seq.company,
              to: seq.to,
              step,
              threaded: Boolean(inReplyTo),
            });
            continue;
          }

          await pace();
          const sent = await sendOutreachMail({
            to: seq.to,
            subject,
            text,
            company: seq.company,
            attachResume: false,
            ...(inReplyTo ? { inReplyTo } : {}),
            ...(seq.rootMessageId ? { references: [seq.rootMessageId] } : {}),
          });

          const send: OutreachSend = {
            at: new Date().toISOString(),
            to: seq.to,
            kind: `followup-${step}` as OutreachSend['kind'],
            subject,
            messageId: sent.id,
          };
          await recordFollowUpSend(seq, send);
          result.sent.push({
            company: seq.company,
            to: seq.to,
            step,
            threaded: Boolean(inReplyTo),
          });
        } catch (e) {
          result.failed.push({ company: seq.company, to: seq.to, error: (e as Error).message });
        }
      }
    });
  } catch (e) {
    // A connection-level failure, not a per-row one. Nothing has been sent.
    result.imapError = (e as Error).message;
  }

  if (!dryRun) {
    const bad = result.failed.length > 0 || result.imapError;
    await recordAgentRun('mailer', {
      state: bad ? 'error' : 'ok',
      summary:
        `follow-ups: ${result.sent.length} sent, ${result.stopped.length} closed` +
        ` (${result.due} due, cap ${cap})` +
        (result.backfilled ? ` · adopted ${result.backfilled}` : '') +
        (result.failed.length ? ` · ${result.failed.length} failed` : ''),
      stats: {
        sent: result.sent.length,
        closed: result.stopped.length,
        due: result.due,
        backfilled: result.backfilled,
      },
      error:
        result.imapError ??
        (result.failed.length
          ? result.failed.map((f) => `${f.company}: ${f.error}`).join(' · ')
          : null),
    });
  }

  return result;
}

export type BackfillResult = {
  created: number;
  skipped: number;
  /** Sequences whose Message-ID could not be recovered. They send, just unthreaded. */
  unthreaded: number;
  rows: Array<{ company: string; to: string; nextDueAt: string; threaded: boolean }>;
  imapError: string | null;
};

/**
 * Give the emails that went out BEFORE sequences existed a sequence to belong to.
 *
 * Those sends discarded their Message-ID, so their follow-ups would otherwise arrive as fresh
 * messages instead of replies. The id is read back out of Gmail's Sent Mail, which is the only
 * remaining copy of it. Recovery is allowed to fail: an unthreaded follow-up carrying "Re:"
 * still reaches the founder, and dropping the sequence entirely would cost the whole thread.
 *
 * Idempotent by design, so it can be re-run after a partial failure.
 */
export async function backfillSequences(): Promise<BackfillResult> {
  const items = await getRecentFunding(1000);
  const ids = items.map((i) => i.id);
  const [drafts, contacts] = await Promise.all([
    getFundingOutreaches(ids),
    getFundingContacts(ids),
  ]);

  const result: BackfillResult = {
    created: 0,
    skipped: 0,
    unthreaded: 0,
    rows: [],
    imapError: null,
  };

  const pending: Array<{ seq: OutreachSequence; sentAt: string }> = [];

  for (const item of items) {
    const draft = drafts.get(item.id);
    if (!draft?.sentAt || !draft.sentTo) continue;
    if (await getOutreachSequence(item.id)) {
      result.skipped += 1;
      continue;
    }

    const greeted =
      greetedIn(draft.text) ?? contacts.get(item.id)?.founders[0]?.name ?? '';
    const subject = draft.subject || `${item.company} — quick note`;

    pending.push({
      seq: {
        id: item.id,
        company: item.company,
        to: draft.sentTo,
        greeted: firstName(greeted),
        subject,
        sends: [{ at: draft.sentAt, to: draft.sentTo, kind: 'initial', subject }],
        step: 0,
        nextDueAt: dueAfter(draft.sentAt, 3),
        state: 'active',
      },
      sentAt: draft.sentAt,
    });
  }

  if (pending.length === 0) return result;

  // One connection for every lookup, same as the send pass.
  if (imapConfigured()) {
    try {
      await withImap(async (client) => {
        for (const p of pending) {
          try {
            const messageId = await findSentMessageId(client, p.seq.to, new Date(p.sentAt));
            if (messageId) {
              p.seq.rootMessageId = messageId;
              p.seq.sends[0].messageId = messageId;
            }
          } catch {
            // One unrecoverable id is not a reason to abandon the rest of the backfill.
          }
        }
      });
    } catch (e) {
      result.imapError = (e as Error).message;
    }
  } else {
    result.imapError = 'IMAP not configured — sequences created without threading';
  }

  for (const p of pending) {
    await saveOutreachSequence(p.seq);
    result.created += 1;
    if (!p.seq.rootMessageId) result.unthreaded += 1;
    result.rows.push({
      company: p.seq.company,
      to: p.seq.to,
      nextDueAt: p.seq.nextDueAt!,
      threaded: Boolean(p.seq.rootMessageId),
    });
  }

  return result;
}
