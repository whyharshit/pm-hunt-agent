/**
 * Spec for "did they reply?" — the question the follow-up pass must not get wrong.
 * Free: no network, no IMAP, no credentials.
 *   npx tsx scripts/check-reply-detection.mts
 *
 * ⚠️ THE FAILURE THIS PINS IS A REAL EMAIL THE USER RECEIVED A COMPLAINT-WORTHY REMINDER FOR.
 * On 18 Aug 2026 an application went to `careers@rovia.one`, a Google Group. On 21 Aug at
 * 02:03 IST Aayush Jain answered from `aayush.j@rovia.one` — a two-question assignment with a
 * 26 Aug deadline. At 09:29 the same morning the follow-up pass sent "Just following up on my
 * note below, in case it got buried."
 *
 * The check asked IMAP for mail FROM `careers@rovia.one` and there was none. Verified against
 * the live mailbox on 2026-08-21: the old check returns false, and both new signals return
 * `aayush.j@rovia.one`.
 *
 * A SHARED INBOX NEVER REPLIES; A PERSON BEHIND IT DOES. Three signals answer it now — the
 * thread, the address, a colleague on the same company domain — and two of them are pinned
 * here. The third (`findReply` itself) needs a mailbox: `scripts/check-imap.mts`.
 */
import { colleagueDomainFor } from '../lib/imap';
import { firstSentAt, lastSentAt, threadMessageIds } from '../lib/sequence';
import type { OutreachSequence, OutreachSend } from '../lib/types';

let bad = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    bad++;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

console.log('\n--- colleagueDomainFor: when a colleague answers for the inbox ---');
// THE ROVIA CASE. This is the pair of addresses that produced the incident.
check(
  'careers@rovia.one accepts a reply from anyone at rovia.one',
  colleagueDomainFor('careers@rovia.one') === 'rovia.one',
  String(colleagueDomainFor('careers@rovia.one'))
);
for (const inbox of [
  'jobs@acme.io',
  'hr@acme.io',
  'hiring@acme.io',
  'recruiting@acme.io',
  'talent@acme.io',
  'internships@acme.io',
  'apply@acme.io',
  'workwithus@acme.io',
  'info@acme.io',
  'hello@acme.io',
  'team@acme.io',
]) {
  check(`${inbox} is a shared inbox`, colleagueDomainFor(inbox) === 'acme.io');
}

// ⚠️ A PERSON'S ADDRESS MUST NOT OPEN THE DOMAIN UP. We wrote to a named human; if they reply
// it is the address signal that catches it. Treating every colleague of theirs as their reply
// would close a sequence because somebody else at the company happened to write to us.
for (const person of ['aayush.j@rovia.one', 'shivansh@acme.io', 'a.jain@acme.io']) {
  check(`${person} is NOT a shared inbox`, colleagueDomainFor(person) === null);
}

// ⚠️ AND NEVER ON A CONSUMER HOST, where "same domain" means "another of the world's gmail
// users". This is the gate that keeps the rule from being catastrophic: plenty of small
// employers post from a gmail address.
for (const consumer of [
  'careers@gmail.com',
  'hr@outlook.com',
  'jobs@yahoo.com',
  'hiring@hotmail.com',
  'talent@icloud.com',
  'apply@protonmail.com',
  'info@rediffmail.com',
  'hello@zoho.com',
]) {
  check(`${consumer} gets NO colleague rule`, colleagueDomainFor(consumer) === null);
}

check('an empty address is null', colleagueDomainFor('') === null);
check('a non-address is null', colleagueDomainFor('careers') === null);
check('case does not matter', colleagueDomainFor('Careers@Rovia.One') === 'rovia.one');

console.log('\n--- threadMessageIds: a reply threads to ANY touch, not just the last ---');
const send = (at: string, kind: OutreachSend['kind'], messageId?: string): OutreachSend => ({
  at,
  to: 'careers@rovia.one',
  kind,
  subject: 'Saw your LinkedIn post',
  ...(messageId ? { messageId } : {}),
});

const seq = (over: Partial<OutreachSequence> = {}): OutreachSequence => ({
  id: 'job:rovia',
  kind: 'job',
  company: 'Rovia',
  to: 'careers@rovia.one',
  greeted: 'team',
  subject: 'Saw your LinkedIn post',
  rootMessageId: '<root@gmail.com>',
  sends: [send('2026-08-18T04:14:00Z', 'initial', '<root@gmail.com>')],
  step: 0,
  state: 'active',
  ...over,
});

check(
  'the root id is included, and the duplicate send id is not repeated',
  JSON.stringify(threadMessageIds(seq())) === JSON.stringify(['<root@gmail.com>']),
  JSON.stringify(threadMessageIds(seq()))
);

const bumped = seq({
  sends: [
    send('2026-08-18T04:14:00Z', 'initial', '<root@gmail.com>'),
    send('2026-08-21T03:59:00Z', 'followup-1', '<bump1@gmail.com>'),
  ],
  step: 1,
});
check(
  'every touch is asked about, oldest first',
  JSON.stringify(threadMessageIds(bumped)) ===
    JSON.stringify(['<root@gmail.com>', '<bump1@gmail.com>']),
  JSON.stringify(threadMessageIds(bumped))
);
// Somebody answering the FIRST email three weeks later threads onto the root, not onto the
// bump we sent yesterday. Asking about only the latest id would miss them.
check(
  'a send with no recovered message id is skipped, not sent as an empty search',
  JSON.stringify(
    threadMessageIds(
      seq({
        rootMessageId: undefined,
        sends: [send('2026-08-18T04:14:00Z', 'initial'), send('2026-08-21T03:59:00Z', 'followup-1', '<bump1@gmail.com>')],
      })
    )
  ) === JSON.stringify(['<bump1@gmail.com>'])
);
check(
  'a sequence with nothing threadable yields an empty list, not [undefined]',
  threadMessageIds(seq({ rootMessageId: undefined, sends: [send('2026-08-18T04:14:00Z', 'initial')] }))
    .length === 0
);

console.log('\n--- the reply window opens at the FIRST send ---');
// ⚠️ THE SECOND HALF OF THE SAME BUG. The window used to start at the LAST send, so a reply
// the pass missed once could never be seen again: each bump moved the window past it. One
// missed reply meant all three follow-ups went out. The Rovia reply survived only because it
// landed on the same calendar day as the bump, and IMAP's SINCE ignores the time of day.
const late = seq({
  sends: [
    send('2026-08-18T04:14:00Z', 'initial', '<root@gmail.com>'),
    send('2026-08-21T03:59:00Z', 'followup-1', '<bump1@gmail.com>'),
  ],
  step: 1,
});
check(
  'the window starts at the initial send',
  firstSentAt(late).toISOString() === '2026-08-18T04:14:00.000Z',
  firstSentAt(late).toISOString()
);
check(
  'and NOT at the last one, which is what hid the reply',
  +firstSentAt(late) < +lastSentAt(late),
  `${firstSentAt(late).toISOString()} vs ${lastSentAt(late).toISOString()}`
);
check(
  'a reply that arrived between the two sends is inside the window',
  +new Date('2026-08-21T02:03:00+05:30') > +firstSentAt(late)
);
check(
  'the same reply was OUTSIDE the old window',
  +new Date('2026-08-20T20:33:00Z') < +lastSentAt(late)
);
check(
  'a sequence with no sends falls back rather than throwing',
  Number.isFinite(+firstSentAt(seq({ sends: [], nextDueAt: '2026-08-24T04:00:00Z' })))
);

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} CHECKS FAILED`);
process.exit(bad === 0 ? 0 : 1);
