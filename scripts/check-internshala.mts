/**
 * Internshala source smoke test — run with:  npx tsx scripts/check-internshala.mts
 * Fetches the live pages and pushes the results through the real filter funnel.
 */
import { fetchInternshala } from '../lib/sources/internshala';
import { isIntern, isProductOrOps, isRemote, isHardRejected, passes } from '../lib/filters';

const jobs = await fetchInternshala();
console.log(`fetched ${jobs.length} paid listings`);

const funnel = {
  intern: jobs.filter(isIntern).length,
  internAndRole: jobs.filter((j) => isIntern(j) && isProductOrOps(j)).length,
  plusRemote: jobs.filter((j) => isIntern(j) && isProductOrOps(j) && isRemote(j)).length,
  final: jobs.filter(passes).length,
};
console.log('funnel:', funnel);

console.log('\n--- final matches ---');
for (const j of jobs.filter(passes).slice(0, 25)) {
  console.log(`  ${j.title} · ${j.company} · ${j.location} · ${j.tags[0] ?? ''}\n    ${j.url}`);
}

console.log('\n--- sample rejects (first 8 non-passing) ---');
for (const j of jobs.filter((x) => !passes(x)).slice(0, 8)) {
  const why = isHardRejected(j)
    ? 'hard-reject'
    : !isIntern(j)
      ? 'no intern signal'
      : !isProductOrOps(j)
        ? 'no role signal'
        : 'not remote';
  console.log(`  [${why}] ${j.title} · ${j.location}`);
}
