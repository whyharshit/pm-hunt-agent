/**
 * Free-boards smoke test (Himalayas + Remotive + Jobicy) — run with:
 *   npx tsx scripts/check-boards.mts
 *
 * Hits the real public APIs (no key, no auth) and prints per-board funnels, so a genuinely
 * dry board is distinguishable from a broken one. Low finals are EXPECTED here — generic
 * remote boards skew senior/US; they're in because "don't drop any free source".
 */
import { fetchHimalayas, fetchRemotive, fetchJobicy } from '../lib/sources/boards';
import { isIntern, isProductOrOps, isRemote, isHardRejected } from '../lib/filters';
import type { Job } from '../lib/types';

const boards: Array<[string, () => Promise<Job[]>]> = [
  ['himalayas', fetchHimalayas],
  ['remotive', fetchRemotive],
  ['jobicy', fetchJobicy],
];

for (const [name, fetcher] of boards) {
  const started = Date.now();
  try {
    const jobs = await fetcher();
    const internOnly = jobs.filter(isIntern);
    const plusRole = internOnly.filter(isProductOrOps);
    const plusRemote = plusRole.filter(isRemote);
    const final = plusRemote.filter((j) => !isHardRejected(j));

    console.log(`\n=== ${name} — ${jobs.length} fetched in ${Date.now() - started}ms ===`);
    console.log('funnel:', {
      intern: internOnly.length,
      internAndRole: plusRole.length,
      plusRemote: plusRemote.length,
      final: final.length,
    });
    for (const j of final) {
      console.log(`• ${j.title}`);
      console.log(`    ${j.company} · ${j.location} · ${j.url}${j.salary ? ` · ${j.salary}` : ''}`);
    }
    if (final.length === 0 && internOnly.length > 0) {
      console.log('-- intern-titled rows that fell out downstream --');
      for (const j of internOnly.slice(0, 5)) {
        console.log(
          `• ${j.title} [role:${isProductOrOps(j)} remote:${isRemote(j)} hardReject:${isHardRejected(j)}]`
        );
      }
    }
  } catch (e) {
    console.log(`\n=== ${name} — FAILED: ${(e as Error).message} ===`);
  }
}
