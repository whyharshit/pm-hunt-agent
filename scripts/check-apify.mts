/**
 * Apify aggregator-comment miner smoke test.
 *   npx tsx --env-file=.env.local scripts/check-apify.mts
 *
 * --env-file is Node's own loader (20.6+); this repo has no dotenv dependency and
 * doesn't need one. Needs APIFY_TOKEN and APIFY_LINKEDIN_PROFILES in .env.local.
 *
 * SPENDS REAL APIFY CREDIT — $0.002 per comment, 20 comments per profile, so a
 * 3-profile run costs about $0.12.
 */
import { fetchLinkedInPostsViaApify } from '../lib/sources/apify';
import { isIntern, isProductOrOps, isRemote, isHardRejected, passes } from '../lib/filters';

const profiles = (process.env.APIFY_LINKEDIN_PROFILES ?? '').split(',').filter(Boolean);
if (!process.env.APIFY_TOKEN) console.log('! APIFY_TOKEN not set — source returns [] by design');
if (profiles.length === 0) {
  console.log('! APIFY_LINKEDIN_PROFILES not set — source returns [] by design.');
  console.log('  Set it to the aggregator profile URLs, comma-separated, e.g.');
  console.log('  APIFY_LINKEDIN_PROFILES=https://www.linkedin.com/in/<slug>,https://www.linkedin.com/in/<slug2>');
}
console.log(`profiles configured: ${profiles.length}`);

const jobs = await fetchLinkedInPostsViaApify();
console.log(`matched ${jobs.length} recruiter posts out of the mined comment feed`);

const funnel = {
  intern: jobs.filter(isIntern).length,
  internAndRole: jobs.filter((j) => isIntern(j) && isProductOrOps(j)).length,
  plusRemote: jobs.filter((j) => isIntern(j) && isProductOrOps(j) && isRemote(j)).length,
  final: jobs.filter(passes).length,
};
console.log('funnel:', funnel);

console.log('\n--- final matches ---');
for (const j of jobs.filter(passes)) {
  console.log(`  ${j.title} · ${j.company}\n    post: ${j.url}`);
  if (j.applyUrl) console.log(`    apply: ${j.applyUrl}`);
}

console.log('\n--- matched by the post matcher but dropped by Discover ---');
for (const j of jobs.filter((x) => !passes(x))) {
  const why = isHardRejected(j)
    ? 'hard-reject'
    : !isIntern(j)
      ? 'no intern signal'
      : !isProductOrOps(j)
        ? 'no role signal'
        : 'not remote';
  console.log(`  [${why}] ${j.title}`);
}
