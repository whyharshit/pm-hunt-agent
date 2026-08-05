/**
 * YC job board smoke test — run with:  npx tsx scripts/check-yc.mts
 * Fetches the live Inertia payloads and pushes the results through the real filter funnel.
 */
import { fetchYc } from '../lib/sources/yc';
import { isIntern, isProductOrOps, isRemote, isHardRejected, passes } from '../lib/filters';

const jobs = await fetchYc();
console.log(`fetched ${jobs.length} postings (US-citizen-only roles already dropped)`);

const funnel = {
  intern: jobs.filter(isIntern).length,
  internAndRole: jobs.filter((j) => isIntern(j) && isProductOrOps(j)).length,
  plusRemote: jobs.filter((j) => isIntern(j) && isProductOrOps(j) && isRemote(j)).length,
  final: jobs.filter(passes).length,
};
console.log('funnel:', funnel);

console.log('\n--- final matches ---');
for (const j of jobs.filter(passes)) {
  console.log(`  ${j.title} · ${j.company} · ${j.location} · ${j.salary ?? 'pay n/d'}\n    ${j.url}`);
}

console.log('\n--- intern-typed postings that did NOT pass ---');
for (const j of jobs.filter((x) => /\bintern/i.test(x.title) && !passes(x))) {
  const why = isHardRejected(j)
    ? 'hard-reject'
    : !isIntern(j)
      ? 'no intern signal'
      : !isProductOrOps(j)
        ? 'no role signal'
        : 'not remote';
  console.log(`  [${why}] ${j.title} · ${j.location}`);
}
