/**
 * Why are free-text hiring posts being REJECTED? Run with:
 *   npx tsx scripts/check-post-match.mts
 *
 * The 2026-08-18 hand-off asks for more poster-written posts and says, of the matcher:
 * "measure what is being rejected before touching it — write the rejected posts out and
 * read them, do not guess." This is that measurement.
 *
 * It reads the FREE surface only (t.me/s/ previews — no key, no credits, no Apify spend),
 * because the question being asked is about `matchWhatsappPost`, which is shared verbatim
 * by the Telegram, LinkedIn-post-search and comment-mining sources. A rejection reason
 * measured here is the same reason there, at no cost.
 */
import { fetchChannel, channels } from '../lib/sources/telegram';
import { matchWhatsappPost, looksJobish } from '../lib/whatsapp/match';
import { ROLE_PATTERNS, INTERN_PATTERNS } from '../lib/filters';
import { firstIndiaCity } from '../lib/geo';

const list = channels();
console.log(`channels: ${list.join(', ')}\n`);

const settled = await Promise.allSettled(list.map(fetchChannel));
const posts = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
console.log(`fetched ${posts.length} posts`);

const jobish = posts.filter((p) => looksJobish(p.text));
console.log(`job-ish (cheap pre-gate): ${jobish.length}\n`);

const reasons = new Map<string, number>();
let matched = 0;
const onlyRemote: typeof jobish = [];

for (const p of jobish) {
  const m = matchWhatsappPost(p.text);
  if (m.matched) { matched++; continue; }
  for (const r of m.reasons) reasons.set(r, (reasons.get(r) ?? 0) + 1);
  // The hypothesis under test: posts that clear every ROLE test and die only on remote.
  if (m.reasons.length === 1 && m.reasons[0] === 'not remote, and not in a named Indian city') onlyRemote.push(p);
}

console.log(`MATCHED: ${matched} / ${jobish.length}`);
console.log('\nrejection reasons (a post can carry more than one):');
for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(4)}  ${r}`);
}

console.log(`\n=== rejected ONLY on the location gate: ${onlyRemote.length} ===`);
let indiaProduct = 0;
let indiaAny = 0;
for (const p of onlyRemote) {
  const m = matchWhatsappPost(p.text);
  const city = firstIndiaCity(p.text);
  const role = m.matchedRole ?? '';
  const product = role !== '';
  if (city) indiaAny++;
  if (city && product) indiaProduct++;
  console.log(
    `• [${city ?? 'no-india-city'}]${product ? ' [PRODUCT]' : ''} ${role.slice(0, 90)}`
  );
  console.log(`    ${p.url}`);
}
console.log(
  `\nof those: ${indiaAny} name an Indian city, ${indiaProduct} are product-family too` +
    ` (i.e. would pass isOnsiteAllowed today if the matcher let them reach passes()).`
);

// Sanity: how often does a post pass the remote gate on a WEAK word rather than a real
// remote claim? "global" and "distributed" are in REMOTE_PATTERNS and appear in company
// boilerplate constantly, so a high count here means the gate is not measuring what it says.
const WEAK = [/\bglobal\b/i, /\bdistributed\b/i, /\banywhere\b/i, /\bworldwide\b/i];
const STRONG = [/\bremote\b/i, /\bwork from home\b/i, /\bwfh\b/i];
let weakOnly = 0;
for (const p of jobish) {
  const m = matchWhatsappPost(p.text);
  if (!m.matched) continue;
  if (!STRONG.some((re) => re.test(p.text)) && WEAK.some((re) => re.test(p.text))) weakOnly++;
}
console.log(`\nof the ${matched} matched, ${weakOnly} carry NO strong remote word` +
  ` and passed the remote gate on "global"/"distributed"/"anywhere"/"worldwide" alone.`);

void ROLE_PATTERNS; void INTERN_PATTERNS;
