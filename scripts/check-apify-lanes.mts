/**
 * Per-lane LinkedIn post-search report.
 *   npx tsx --env-file=.env.local scripts/check-apify-lanes.mts
 *
 * 💰 SPENDS REAL APIFY CREDIT — $0.002 per post bought, `APIFY_POSTS_PER_RUN` posts per run
 * across all lanes. At the default 40 that is $0.08. Set APIFY_POSTS_PER_RUN low (8-12) and
 * APIFY_LANES to one lane while trying a query change, or a bad phrasing costs the same as a
 * good one.
 *
 * What it answers, which nothing else can: WHICH LANE THE MONEY WENT TO. Each lane reports
 * posts bought, posts matched, and posts dropped for naming no address and no form — the last
 * number is the one that says whether the `requireContact` rule is earning its place or
 * throwing away the whole purchase.
 */
import {
  apifyRequireContact,
  apifyTokens,
  fetchLinkedInPostSearch,
  POST_LANES,
  type LaneStat,
} from '../lib/sources/apify-posts';
import { isHardRejected, isIntern, isProductOrOps, isRemote, passes } from '../lib/filters';

if (apifyTokens().length === 0) {
  console.log('! no APIFY_TOKENS / APIFY_TOKEN set — the source returns [] by design');
  process.exit(0);
}
console.log(`tokens pooled: ${apifyTokens().length}`);
console.log(`lanes available: ${POST_LANES.map((l) => l.key).join(', ')}`);
console.log(`APIFY_LANES=${process.env.APIFY_LANES ?? '(all)'}`);
console.log(`APIFY_POSTS_PER_RUN=${process.env.APIFY_POSTS_PER_RUN ?? '(40 default)'}`);
console.log(`require an address or a form: ${apifyRequireContact()}`);

const stats: LaneStat[] = [];
const jobs = await fetchLinkedInPostSearch(stats);

console.log('\n--- per lane ---');
for (const s of stats) {
  console.log(
    `  ${s.lane.padEnd(9)} bought ${String(s.bought).padStart(3)} · kept ${String(s.matched).padStart(3)}` +
      ` · dropped-no-contact ${String(s.noContact).padStart(3)}` +
      (s.error ? `  ERROR: ${s.error}` : '')
  );
}
const bought = stats.reduce((n, s) => n + s.bought, 0);
console.log(`  total bought ${bought} = about $${(bought * 0.002).toFixed(3)}`);

console.log(`\nrows produced: ${jobs.length}`);
console.log('funnel:', {
  intern: jobs.filter(isIntern).length,
  internAndRole: jobs.filter((j) => isIntern(j) && isProductOrOps(j)).length,
  remote: jobs.filter(isRemote).length,
  final: jobs.filter(passes).length,
});

console.log('\n--- rows Discover would keep ---');
for (const j of jobs.filter(passes)) {
  const lane = j.tags.find((t) => t.startsWith('lane:')) ?? 'lane:?';
  const emails = j.tags.filter((t) => t.includes('@'));
  console.log(`  [${lane.slice(5)}] ${j.title} · ${j.company} · ${j.location || 'no location'}`);
  console.log(`      post: ${j.url}`);
  if (j.applyUrl) console.log(`      apply: ${j.applyUrl}`);
  if (emails.length) console.log(`      email in post: ${emails.join(', ')}`);
}

const dropped = jobs.filter((j) => !passes(j));
if (dropped.length > 0) {
  console.log('\n--- bought, matched, then dropped by Discover (money spent for nothing) ---');
  for (const j of dropped) {
    const why = isHardRejected(j)
      ? 'hard-reject'
      : !isIntern(j)
        ? 'no intern signal'
        : !isProductOrOps(j)
          ? 'no role signal'
          : 'not remote, and not an on-site India product role';
    console.log(`  [${why}] ${j.title} · ${j.location || 'no location'}`);
  }
  console.log(
    '\n  A pile of "not remote" here means the data/SWE lanes are buying on-site India posts.\n' +
      '  The on-site allowance is product-only, so those cannot pass — either keep those lanes\n' +
      '  phrased remote, or widen PRODUCT_PATTERNS in lib/filters.ts (the user\'s call).'
  );
}
