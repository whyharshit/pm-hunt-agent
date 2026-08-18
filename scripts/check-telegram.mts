/**
 * Telegram channel source smoke test — run with:
 *   npx tsx scripts/check-telegram.mts
 *
 * Hits the real t.me/s/ previews (no key, no auth) and prints the same funnel the other
 * source checks print, so a dry run is distinguishable from a broken one.
 */
import { fetchTelegramChannels } from '../lib/sources/telegram';
import {
  isIntern,
  isProductOrOps,
  isRemote,
  isOnsiteAllowed,
  isHardRejected,
  passes,
} from '../lib/filters';

const channels = process.env.TELEGRAM_CHANNELS;
console.log(
  channels === undefined
    ? 'TELEGRAM_CHANNELS not set — using the built-in default channel list'
    : `TELEGRAM_CHANNELS=${channels}`
);

const jobs = await fetchTelegramChannels();
console.log(`\nmatched ${jobs.length} posts across the mined channels`);

const internOnly = jobs.filter(isIntern);
const plusRole = internOnly.filter(isProductOrOps);
// Remote OR the on-site India product allowance, which is what `passes()` has asked since
// 2026-08-17. Filtering on `isRemote` alone (as this did until 2026-08-18) under-reported
// the source against its own Discover result: it showed `final: 4` on a run where all 10
// rows passed, which reads as six rows being dropped somewhere unnamed.
const reachable = plusRole.filter((j) => isRemote(j) || isOnsiteAllowed(j));
const final = reachable.filter((j) => !isHardRejected(j));
console.log('funnel:', {
  intern: internOnly.length,
  internAndRole: plusRole.length,
  remoteOnly: plusRole.filter(isRemote).length,
  plusOnsiteIndia: reachable.length,
  final: final.length,
});

const byChannel: Record<string, number> = {};
for (const j of jobs) byChannel[j.company] = (byChannel[j.company] ?? 0) + 1;
console.log('by channel:', byChannel);

console.log('\n--- final matches ---');
for (const j of final) {
  console.log(`• ${j.title}`);
  console.log(`    ${j.company} · ${j.url}${j.applyUrl ? ` · apply: ${j.applyUrl}` : ''}`);
}

const dropped = jobs.filter((j) => !passes(j));
if (dropped.length > 0) {
  console.log('\n--- matched by the post matcher but dropped by Discover ---');
  for (const j of dropped) console.log(`• ${j.title}`);
}
