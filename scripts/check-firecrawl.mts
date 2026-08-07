/**
 * Firecrawl source smoke test — run with:
 *   npx tsx --env-file=.env.local scripts/check-firecrawl.mts
 *
 * ⚠️ Spends real credits: 1 per page (4 pages). Prints the same funnel as the other
 * source checks, plus wall-clock — this source is the one that threatens the 60s cron
 * ceiling, so the timing line matters as much as the matches.
 */
import { fetchViaFirecrawl } from '../lib/sources/firecrawl';
import { isIntern, isProductOrOps, isRemote, isHardRejected } from '../lib/filters';

if (!process.env.FIRECRAWL_API_KEY) {
  console.log('FIRECRAWL_API_KEY not set — source would return []. Run with --env-file=.env.local');
  process.exit(1);
}

const started = Date.now();
const jobs = await fetchViaFirecrawl();
const secs = ((Date.now() - started) / 1000).toFixed(1);
console.log(`fetched ${jobs.length} rows in ${secs}s (wall-clock — must sit well under 60s)`);

const bySource: Record<string, number> = {};
for (const j of jobs) bySource[j.source] = (bySource[j.source] ?? 0) + 1;
console.log('by source:', bySource);

const internOnly = jobs.filter(isIntern);
const plusRole = internOnly.filter(isProductOrOps);
const plusRemote = plusRole.filter(isRemote);
const final = plusRemote.filter((j) => !isHardRejected(j));
console.log('funnel:', {
  intern: internOnly.length,
  internAndRole: plusRole.length,
  plusRemote: plusRemote.length,
  final: final.length,
});

console.log('\n--- final matches ---');
for (const j of final) {
  console.log(`• ${j.title}`);
  console.log(`    ${j.company} · ${j.location} · ${j.url}${j.salary ? ` · ${j.salary}` : ''}`);
}

console.log('\n--- sample rows (first 8, pre-filter — eyeball the parse) ---');
for (const j of jobs.slice(0, 8)) {
  console.log(`• [${j.source}] ${j.title} @ ${j.company} · ${j.location}${j.salary ? ` · ${j.salary}` : ''}`);
}
