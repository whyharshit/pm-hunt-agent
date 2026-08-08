/**
 * Live check for the extra funding feeds (lib/sources/fundingnews.ts) and the Gemini key
 * pool (lib/gemini.ts). Makes NO Gemini calls — the daily free-tier quota is 20 per key
 * and this script must never be the thing that spends it.
 *
 *   npx tsx --env-file=.env.local scripts/check-funding-news.mts
 */
import { fetchFundingNews, isUnresolvableNewsLink } from '../lib/sources/fundingnews';
import { geminiKeys } from '../lib/gemini';

const keys = geminiKeys();
console.log(`Gemini key pool: ${keys.length} key(s) → ~${keys.length * 20} requests/day`);
if (keys.length === 0) console.log('  ⚠️ none set — every LLM-backed agent will fail');
else console.log(`  ${keys.map((k) => `…${k.slice(-6)}`).join(', ')}`);
if (!process.env.SERPER_API_KEY) console.log('SERPER_API_KEY unset → serper contributes 0 by design');

console.log('\n--- live fetch ---');
const { items, perSource, duplicateStories, errors } = await fetchFundingNews();
console.log(`per source: ${JSON.stringify(perSource)}`);
console.log(`collapsed ${duplicateStories} duplicate article(s) of the same raise`);
if (errors.length) console.log(`errors: ${errors.join(' · ')}`);

const ageDays = (d: string) => Math.round((Date.now() - Date.parse(d)) / 86_400_000);
for (const i of items.slice(0, 25)) {
  console.log(` - [${ageDays(i.postedAt)}d]${isUnresolvableNewsLink(i.url) ? ' [browser-only link]' : ''} ${i.title}`);
}

console.log(`\n${items.length} raises after the gate`);
process.exit(items.length > 0 && keys.length > 0 ? 0 : 1);
