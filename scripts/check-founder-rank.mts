/**
 * Spec for WHICH person on a contact gets the email (lib/autosend.ts `personRank`).
 * Free — no network, no Gemini.
 *   npx tsx scripts/check-founder-rank.mts
 *
 * The failure this pins is real. Until 2026-08-13 the sender took the first ADDRESS matching
 * any name in `contact.founders`, and on a Hunter-enriched row that array is simply everyone
 * Hunter knows — so the "founder first" rule did nothing. A dry run had Lovable's $400M raise
 * about to be congratulated to its Head of Product Experience while the co-founder's address
 * sat three rows below.
 *
 * The other half is the rule that must NOT regress: a founder named by the funding ARTICLE
 * is never displaced by a titled non-founder Hunter returned (Omilia's "Hi Petr").
 */
import { rankPeople } from '../lib/autosend';
import type { ContactPerson } from '../lib/types';

let bad = 0;
const check = (label: string, ok: boolean) => {
  if (!ok) {
    console.log(`✗ ${label}`);
    bad++;
  }
};

/** The person `runAutoSend` would greet, given the people a contact holds. */
const top = (people: ContactPerson[]): string => rankPeople(people)[0]?.name ?? '(none)';

// --- Lovable, exactly as Hunter returned it on 2026-08-13 ---
const lovable: ContactPerson[] = [
  { name: 'Olof Halfvarsson', title: 'Head of Product Experience' },
  { name: 'Simon Tong', title: 'Head of Total Rewards' },
  { name: 'Anton Osika', title: 'Co-Founder' },
  { name: 'Matt Sellers', title: 'Product Designer' },
  { name: 'Robbert Hoeven', title: 'Frontend Engineer' },
  { name: 'Karen Vistar' },
];
check('Lovable: the co-founder outranks Head of Product Experience', top(lovable) === 'Anton Osika');

// --- Omilia: the article named Dimitris Vassos; Hunter appended titled execs ---
// runEnrichPass puts article-derived people first and they carry no Hunter title, so an
// untitled person must beat a titled non-founder or this regresses to "Hi Petr".
const omilia: ContactPerson[] = [
  { name: 'Dimitris Vassos' },
  { name: 'Petr Mizera', title: 'Chief Revenue Officer' },
  { name: 'Lena Parshyna', title: 'Head of Marketing' },
];
check('Omilia: the article-named founder beats a titled exec', top(omilia) === 'Dimitris Vassos');

// An explicit CEO title still wins over an untitled name — that is the one case where
// Hunter's data is better than the article's silence.
check(
  'an explicit CEO outranks an untitled person',
  top([{ name: 'Untitled Person' }, { name: 'Real Boss', title: 'CEO & Founder' }]) === 'Real Boss'
);

// Ties preserve input order, which is what keeps article-derived people ahead of Hunter's.
check(
  'equal rank keeps original order',
  top([{ name: 'First Listed' }, { name: 'Second Listed' }]) === 'First Listed'
);
check(
  'equal rank keeps original order (both founders)',
  top([
    { name: 'Founder A', title: 'Co-Founder' },
    { name: 'Founder B', title: 'Founder' },
  ]) === 'Founder A'
);

// Title spellings seen in the wild must all read as founder.
for (const title of [
  'Founder',
  'founder',
  'Co-Founder',
  'Cofounder',
  'co-founder & CTO',
  'CEO',
  'CEO & Co-Founder',
  'Chief Executive Officer',
]) {
  check(
    `founder title: "${title}"`,
    top([{ name: 'Someone Else', title: 'Head of Growth' }, { name: 'The Boss', title }]) ===
      'The Boss'
  );
}

// ...and titles that merely sound senior must NOT. "Founding engineer" is the trap: it
// contains "founding" but is an early employee, not the person to congratulate on a raise.
for (const title of [
  'Head of Product Experience',
  'Head of Total Rewards',
  'Chief of Staff',
  'VP Engineering',
  'Product Designer',
  'Founding Engineer',
]) {
  check(
    `NOT a founder title: "${title}"`,
    top([{ name: 'Not The Boss', title }, { name: 'Untitled Person' }]) === 'Untitled Person'
  );
}

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} CHECKS FAILED`);
process.exit(bad === 0 ? 0 : 1);
