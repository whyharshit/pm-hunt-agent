/**
 * Spec for the /mail timeline (lib/mail-timeline.ts). Free — no network, no Redis.
 *   npx tsx scripts/check-mail-timeline.mts
 *
 * WHY A TIMELINE NEEDS PINNING AT ALL. Its whole job is to make one specific failure visible:
 * on 2026-08-21 a follow-up went out at 09:29 to a recruiter who had replied at 02:03 the same
 * morning. The reply must therefore appear BEFORE that follow-up in the list — which it only
 * does if the reply is stamped when THEY wrote rather than when the cron noticed. Stamp it with
 * the noticing time and the page draws the reply after the bump, i.e. it hides the bug it
 * exists to show.
 */
import { isOverdue, lastActivityAt, mailTimeline, needsAttention } from '../lib/mail-timeline';
import type { OutreachSend, OutreachSequence } from '../lib/types';

let bad = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    bad++;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const send = (at: string, kind: OutreachSend['kind'], messageId?: string): OutreachSend => ({
  at,
  to: 'careers@rovia.one',
  kind,
  subject: 'Saw your LinkedIn post, Shivansh from IIT KGP :)',
  ...(messageId ? { messageId } : {}),
});

const INITIAL = '2026-08-18T04:14:00Z'; // 18 Aug 09:44 IST
const BUMP_1 = '2026-08-21T03:59:00Z'; // 21 Aug 09:29 IST
const REPLY_AT = '2026-08-20T20:33:00Z'; // 21 Aug 02:03 IST — BEFORE the bump
const NOTICED = '2026-08-22T03:50:00Z'; // the run that found it, a day later

const rovia = (over: Partial<OutreachSequence> = {}): OutreachSequence => ({
  id: 'job:rovia',
  kind: 'job',
  company: 'Rovia',
  to: 'careers@rovia.one',
  greeted: 'team',
  subject: 'Saw your LinkedIn post, Shivansh from IIT KGP :)',
  rootMessageId: '<root@gmail.com>',
  sends: [send(INITIAL, 'initial', '<root@gmail.com>'), send(BUMP_1, 'followup-1', '<bump1@gmail.com>')],
  step: 1,
  state: 'active',
  nextDueAt: '2026-08-24T00:00:00Z',
  ...over,
});

console.log('\n--- the sends, in order, labelled as a person would say them ---');
const active = mailTimeline(rovia(), new Date('2026-08-22T04:00:00Z'));
check('the first email comes first', active[0]?.kind === 'sent' && active[0].label === 'first email');
check('then the bump, named by its number', active[1]?.label === 'follow-up 1', active[1]?.label);
check('and the next one is shown as due', active.at(-1)?.kind === 'due', active.at(-1)?.label);
check('the due event names the step that is coming', active.at(-1)?.label === 'follow-up 2 due');
check('every send carries the address it went to', active[0]?.address === 'careers@rovia.one');

console.log('\n--- ⚠️ THE REPLY SITS WHERE IT HAPPENED, NOT WHERE IT WAS NOTICED ---');
const replied = mailTimeline(
  rovia({
    state: 'replied',
    nextDueAt: undefined,
    closedAt: NOTICED,
    closedReason: 'reply from aayush.j@rovia.one (colleague)',
    reply: { from: 'aayush.j@rovia.one', at: REPLY_AT, how: 'colleague', noticedAt: NOTICED },
  })
);
const kinds = replied.map((e) => e.kind).join(' > ');
check(
  'sent > reply > follow-up: the bump went out AFTER they had answered',
  kinds === 'sent > reply > followup',
  kinds
);
check(
  'the reply names the person, not the inbox we wrote to',
  replied[1]?.address === 'aayush.j@rovia.one',
  replied[1]?.address
);
check(
  'and says it came from a colleague of that inbox',
  replied[1]?.label.includes('a colleague of the inbox') === true,
  replied[1]?.label
);
check('a reply with a real timestamp is not marked approximate', !replied[1]?.approximate);
check('the reply is the newest real activity', +lastActivityAt(rovia({
  state: 'replied',
  nextDueAt: undefined,
  closedAt: NOTICED,
  reply: { from: 'aayush.j@rovia.one', at: '2026-08-23T10:00:00Z', how: 'thread', noticedAt: NOTICED },
})) === +new Date('2026-08-23T10:00:00Z'));

console.log('\n--- sequences that predate the reply record ---');
// Closed before 2026-08-21, so there is no `reply` object: only closedAt and a sentence. The
// timeline still has to render, and must SAY the time is second-hand rather than imply the
// recruiter answered at the moment a cron happened to run.
const legacy = mailTimeline(
  rovia({
    state: 'replied',
    nextDueAt: undefined,
    closedAt: NOTICED,
    closedReason: 'reply from careers@rovia.one',
  })
);
check('it still renders a reply event', legacy.some((e) => e.kind === 'reply'));
check(
  'stamped at the close time, and flagged approximate',
  legacy.find((e) => e.kind === 'reply')?.approximate === true
);
check(
  'falling back to the address we wrote to, since nothing better was recorded',
  legacy.find((e) => e.kind === 'reply')?.address === 'careers@rovia.one'
);

console.log('\n--- the other endings ---');
const bounced = mailTimeline(
  rovia({ state: 'bounced', nextDueAt: undefined, closedAt: NOTICED, closedReason: 'bounce for careers@rovia.one' })
);
check('a bounce is on the timeline', bounced.some((e) => e.kind === 'bounce'));
check('a bounce quotes the reason', bounced.find((e) => e.kind === 'bounce')?.label.includes('bounce for') === true);
const spent = mailTimeline(rovia({ state: 'done', step: 3, nextDueAt: undefined, closedAt: NOTICED }));
check(
  'three bumps and silence says exactly that',
  spent.at(-1)?.label === 'all three follow-ups sent, no answer',
  spent.at(-1)?.label
);
check('a closed sequence never shows a due event', !spent.some((e) => e.kind === 'due'));
const stopped = mailTimeline(
  rovia({ state: 'stopped', nextDueAt: undefined, closedAt: NOTICED, closedReason: 'duplicate recipient' })
);
check('a stopped sequence explains itself', stopped.at(-1)?.label.includes('duplicate recipient') === true);

console.log('\n--- what wants the user, and what is merely late ---');
check('a reply wants the user', needsAttention(rovia({ state: 'replied' })));
check('an active sequence does not', !needsAttention(rovia()));
check('nor does a bounce — nothing to answer', !needsAttention(rovia({ state: 'bounced' })));
check('nor a spent one', !needsAttention(rovia({ state: 'done' })));

// The cron fires once a day, so a bump due this morning is not late until tomorrow's fire has
// also missed it. This is the signal that a pass declined for lack of time (see
// lib/invocation-clock.ts) or that the schedule stopped firing at all.
check(
  'due today is not overdue',
  !isOverdue(rovia({ nextDueAt: '2026-08-24T00:00:00Z' }), new Date('2026-08-24T04:00:00Z'))
);
check(
  'still unsent three days later IS overdue',
  isOverdue(rovia({ nextDueAt: '2026-08-24T00:00:00Z' }), new Date('2026-08-27T04:00:00Z'))
);
check(
  'a closed sequence is never overdue, whatever date it carries',
  !isOverdue(
    rovia({ state: 'replied', nextDueAt: '2026-08-01T00:00:00Z' }),
    new Date('2026-08-27T04:00:00Z')
  )
);

console.log('\n--- a sequence with no sends at all must not throw ---');
const empty = rovia({ sends: [], step: 0, nextDueAt: '2026-08-24T00:00:00Z' });
check('it renders just the due event', mailTimeline(empty).length === 1);
check('and sorting it does not produce an invalid date', Number.isFinite(+lastActivityAt(empty)));

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} CHECKS FAILED`);
process.exit(bad === 0 ? 0 : 1);
