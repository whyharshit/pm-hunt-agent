/**
 * Spec check for the funding source gate (lib/sources/techcrunch.ts).
 *
 * Two halves:
 *  1. An offline bank of REAL titles observed live in the venture + startups feeds on
 *     2026-08-08, asserting the raise gate keeps startup rounds and drops VC-fund raises,
 *     acquisitions and TechCrunch's own event marketing. These are the exact strings that
 *     produced the junk rows in prod ("NEA", "Amazon's Alexa Fund"), so they stay pinned.
 *  2. A live fetch, printing the funnel + how fresh the newest item actually is — the
 *     number that told us `/tag/funding/` had gone stale in the first place.
 *
 * Run: npx tsx scripts/check-funding-source.mts
 */
import { MAX_AGE_DAYS, fetchTechCrunchFundingDetailed, isStartupRaise } from '../lib/sources/techcrunch';

const SHOULD_PASS = [
  'Moove raises $250M to become the backbone of the robotaxi industry',
  'Smallest.ai raises $13M to build ultra-fast voice AI that sounds genuinely human',
  'Repeat founder Ryan Williams raises $10M seed for an AI startup for private credit managers',
  'Inforcer raises $50M to help prepare smaller businesses for a new world of AI and security risks',
  'Edtech platform raises $4.5M to help teach students how to vibe code',
  "Travis Kalanick's robotics company raises $1.7B, led by a16z",
  'Defense tech Hadrian raises $1.37B at $8B valuation',
  'Naïve raises $28.5M to automate the grunt work of setting up and running a company',
  'Omilia raises $67M to scale its customer support platform',
  "Elon Musk's Boring Company reportedly raising funding at a $20B valuation",
  'Conifer raises $20M seed round to electrify motors',
  'Cheersy closes a $550,000 pre-seed round',
];

const SHOULD_REJECT = [
  // VC firms raising their own funds — an investor, not a company that hires interns.
  'Fresh off its Wiz payout, Index Ventures raises $2B across three funds',
  'Convective Capital raises an $85 million fund for wildfire tech',
  'NEA closes on $6.2B across two funds',
  'Robinhood to list a fund that lets anyone back Y Combinator startups',
  // Exits / M&A.
  'Klaviyo acquires Elias Torres’ Agency in full-circle reunion for tech founders',
  'Bending Spoons to buy Airtable for $1.28B',
  // Opinion / reporting with no raise.
  'VC-backed startups commit more fraud, and researchers think they know why',
  'How Lightspeed found its newest hire … via Instagram DM',
  'Inside the London hacker house taking a stand against founder burnout',
  'AI makes weather prediction better. Can WindBorne make it lucrative?',
  "Trump's DOJ gains oversight of OpenAI’s green-card employee sponsorships",
  // TechCrunch house ads — these flood the startups feed.
  'Today’s the last day to get up to $400 off your TechCrunch Disrupt 2026 ticket',
  'Host a Side Event during TechCrunch Founder Summit Week in Boston',
  'Your table awaits: Exhibit at TechCrunch Disrupt 2026 to be seen by thousands',
  'Meet the eight startups pitching at Startup Battlefield Australia',
  // Raise-shaped verbs with no money — the classic false positive.
  'New report raises questions about AI safety benchmarks',
];

let bad = 0;

for (const t of SHOULD_PASS) {
  if (!isStartupRaise(t, '')) {
    console.log(`✗ MISSED (should pass): ${t}`);
    bad++;
  }
}
for (const t of SHOULD_REJECT) {
  if (isStartupRaise(t, '')) {
    console.log(`✗ LEAKED (should reject): ${t}`);
    bad++;
  }
}

console.log(
  `\nGate: ${SHOULD_PASS.length} must-pass / ${SHOULD_REJECT.length} must-reject → ${
    bad === 0 ? 'ALL GOOD' : `${bad} WRONG`
  }`
);

console.log('\n--- live fetch ---');
const { items, stats } = await fetchTechCrunchFundingDetailed();
console.log(`per feed: ${JSON.stringify(stats.perFeed)}`);
console.log(`deduped ${stats.fetched} → raise gate ${stats.afterRaiseGate} → ≤${MAX_AGE_DAYS}d ${stats.afterAgeGate}`);
if (stats.errors.length) console.log(`errors: ${stats.errors.join(' · ')}`);

if (items.length) {
  const ageDays = (d: string) => Math.round((Date.now() - Date.parse(d)) / 86_400_000);
  console.log(`newest item is ${ageDays(items[0].postedAt)}d old, oldest ${ageDays(items[items.length - 1].postedAt)}d\n`);
  for (const i of items) console.log(` - [${ageDays(i.postedAt)}d] ${i.title}`);
} else {
  console.log('no fresh raises — suspicious, check the feeds by hand');
  bad++;
}

process.exit(bad === 0 ? 0 : 1);
