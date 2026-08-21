/**
 * Spec for reading LinkedIn's notification mail (lib/linkedin-mail.ts).
 * Free — no network, no IMAP, no credentials.
 *   npx tsx scripts/check-linkedin-mail.mts
 *
 * WHY THIS IS THE RISKIEST PARSER IN THE PROJECT. LinkedIn has no API for invitations, so the
 * only signal that somebody accepted is the email it sends — and LinkedIn sends far more
 * "somebody you might know" mail than "somebody accepted", using the same words. "Add Aayush
 * Jain to your network" is one loose regex away from reading as a connection, and with name
 * matching switched on a false positive does not just show a wrong row: it ties a stranger to a
 * job row and claims they accepted an invitation that was never sent.
 *
 * So the matching is an ALLOWLIST with a reject pass in front of it, and the pins below are
 * mostly about what must NOT be read as an acceptance. Losing a real acceptance is recoverable
 * — the /linkedin page has a "Mark accepted" button — and inventing one is not.
 */
import {
  isLinkedInSender,
  linkedInInviteId,
  parseLinkedInNotification,
  personKey,
} from '../lib/linkedin-mail';

let bad = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    bad++;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const LI = 'invitations@linkedin.com';
const parse = (subject: string, from = LI) => parseLinkedInNotification({ from, subject });

console.log('\n--- the sender gate ---');
for (const good of [
  'invitations@linkedin.com',
  'messages-noreply@linkedin.com',
  'notifications-noreply@linkedin.com',
  'invitations@e.linkedin.com',
  'INVITATIONS@LinkedIn.com',
]) {
  check(`${good} is LinkedIn`, isLinkedInSender(good));
}
// ⚠️ THE LOOKALIKES. A domain that merely CONTAINS "linkedin" is not LinkedIn, and this is the
// difference between a tracker and a phishing target.
for (const bogus of [
  'invitations@linkedin.com.evil.ru',
  'noreply@linkedin-mail.com',
  'noreply@notlinkedin.com',
  'someone@gmail.com',
  '',
]) {
  check(`${bogus || '(empty)'} is NOT LinkedIn`, !isLinkedInSender(bogus));
}
check(
  'an acceptance subject from a stranger is ignored entirely',
  parse('Aayush Jain accepted your invitation to connect', 'someone@gmail.com').kind === 'other'
);

console.log('\n--- the acceptance phrasings LinkedIn actually uses ---');
const ACCEPTED: Array<[string, string]> = [
  // ⚠️ THE REAL ONE. Received by the user on 2026-08-20 and reported on the 22nd — the first
  // actual LinkedIn acceptance subject this project has ever been able to test against. Every
  // other line in this list was written from memory of LinkedIn's phrasings; this one is
  // evidence, so it must never stop parsing.
  ['Kajol accepted your invitation, explore their network', 'Kajol'],
  ['Kajol Sharma accepted your invitation, explore their network', 'Kajol Sharma'],
  // ⚠️ AND THE HEADLINE CASE THAT WAS SILENTLY BROKEN. LinkedIn appends the person's headline,
  // and people put "Hiring!" in theirs — which the digest reject list (it matches /hiring/)
  // threw away, discarding a real acceptance. Acceptances are matched BEFORE the rejects now.
  [
    'Kajol Sharma (Hiring! Product Interns) accepted your invitation, explore their network',
    'Kajol Sharma',
  ],
  ['Aayush Jain | Hiring accepted your invitation', 'Aayush Jain'],
  ['Aayush Jain accepted your invitation to connect', 'Aayush Jain'],
  ['Aayush Jain has accepted your invitation. Let’s start a conversation', 'Aayush Jain'],
  ['Congrats, you and Aayush Jain are now connected!', 'Aayush Jain'],
  ['You and Aayush Jain are now connected', 'Aayush Jain'],
  ['Aayush Jain and you are now connected', 'Aayush Jain'],
  ["You're now connected to Aayush Jain", 'Aayush Jain'],
  ['Congratulations! You are now connected to Aayush Jain', 'Aayush Jain'],
  // The headline LinkedIn sometimes appends is not part of the name.
  ['Aayush Jain, Founder at Rovia accepted your invitation to connect', 'Aayush Jain'],
  ['🎉 Congrats, you and Aayush Jain are now connected!', 'Aayush Jain'],
];
for (const [subject, name] of ACCEPTED) {
  const got = parse(subject);
  check(
    `"${subject.slice(0, 52)}…" -> accepted, ${name}`,
    got.kind === 'accepted' && got.name === name,
    `${got.kind} ${got.name ?? ''}`
  );
}

console.log('\n--- ⚠️ WHAT MUST NEVER BE AN ACCEPTANCE ---');
for (const subject of [
  // Suggestions. These arrive weekly and share every keyword.
  'Add Aayush Jain to your network',
  'Aayush Jain is on LinkedIn',
  'People you may know at Rovia',
  'Invitations you may be interested in',
  'Grow your network: 12 people to connect with',
  'Suggestions for you: Aayush Jain and 4 others',
  // Other notification traffic.
  'Aayush Jain sent you a message',
  'You have a new message from Aayush Jain',
  'Aayush Jain viewed your profile',
  'You appeared in 9 searches this week',
  '15 new jobs for Product Manager',
  'Job alert: Strategy & Ops Intern',
  'Aayush Jain posted: we are hiring',
  'Your network is growing',
  'Security alert: new sign-in',
  'Verify your email address',
] as const) {
  check(`"${subject.slice(0, 46)}" is not an acceptance`, parse(subject).kind !== 'accepted');
}

console.log('\n--- an invitation TO us is a different event ---');
for (const [subject, name] of [
  ['Aayush Jain wants to connect', 'Aayush Jain'],
  ['Aayush Jain would like to connect on LinkedIn', 'Aayush Jain'],
  ['Invitation from Aayush Jain', 'Aayush Jain'],
  ['Aayush Jain sent you an invitation to connect', 'Aayush Jain'],
] as const) {
  const got = parse(subject);
  check(
    `"${subject}" -> invite-received`,
    got.kind === 'invite-received' && got.name === name,
    `${got.kind} ${got.name ?? ''}`
  );
}
check(
  'an inbound invite is never counted as an acceptance',
  ['Aayush Jain wants to connect', 'Invitation from Aayush Jain'].every(
    (s) => parse(s).kind !== 'accepted'
  )
);

console.log('\n--- ⚠️ a subject that names NOBODY must not invent a person ---');
// Both of these were live bugs, found on 2026-08-22 the moment a real subject line was
// available to test against: the first produced a connection with a person called "See who",
// the second one called "3 others". The guard that stops them was itself disabled by an
// invisible BACKSPACE byte sitting where a word boundary should have been — the regex printed
// correctly, tsc and eslint were happy, and it silently matched nothing. See
// scripts/check-source-hygiene.mts, which now scans every source file for that class of damage.
for (const [subject, why] of [
  ['See who accepted your invitation', 'a nudge with no name in it'],
  ['You and 3 others are now connected', 'a digest counting people'],
  ['Someone accepted your invitation', 'a pronoun is not a person'],
  ['New connections this week', 'a weekly summary'],
] as const) {
  const got = parse(subject);
  check(
    `"${subject}" is not a connection (${why})`,
    got.kind !== 'accepted',
    `${got.kind} ${got.name ?? ''}`
  );
}

console.log('\n--- a nameless match is no match ---');
// ⚠️ A connection with nobody's name in it cannot be shown, matched or deduplicated — it would
// be a mystery row that reappears on every scan.
for (const subject of [
  'accepted your invitation to connect',
  '  accepted your invitation',
  '12345 accepted your invitation to connect',
  'You and are now connected',
]) {
  check(`"${subject.trim().slice(0, 40)}" yields no event`, parse(subject).kind === 'other');
}
check('an empty subject is ignored', parse('').kind === 'other');

console.log('\n--- one person, one row ---');
check('spacing and case collapse', personKey('Aayush  JAIN ') === personKey('aayush jain'));
check('punctuation collapses', personKey('Aayush Jain.') === personKey('Aayush Jain'));
check('different people do not collapse', personKey('Aayush Jain') !== personKey('Ayush Jain'));
check('the row id is derived from the key', linkedInInviteId('Aayush Jain') === 'li:aayushjain');
check(
  'so logging by hand and an email land on the SAME row',
  linkedInInviteId('aayush jain') === linkedInInviteId('Aayush  Jain')
);

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} CHECKS FAILED`);
process.exit(bad === 0 ? 0 : 1);
