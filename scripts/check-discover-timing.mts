/**
 * Times the full 13-source fetch exactly as discover.ts runs it (no storage writes):
 *   npx tsx --env-file=.env.local scripts/check-discover-timing.mts
 *
 * ⚠️ Spends real credits (Apify + Firecrawl) when their keys are in the env. The number
 * that matters is WALL-CLOCK: the sources share one Promise.all, so it is the slowest
 * source, not the sum — and it must sit comfortably under the 60s Hobby cron ceiling.
 * Re-run this whenever a source is added or a timeout is raised.
 */
import { fetchRemoteOk } from '../lib/sources/remoteok';
import { fetchWeWorkRemotely } from '../lib/sources/wwr';
import { fetchHnWhoIsHiring } from '../lib/sources/hn';
import { fetchInternshala } from '../lib/sources/internshala';
import { fetchLinkedInViaSerper } from '../lib/sources/linkedin';
import { fetchUnstop } from '../lib/sources/unstop';
import { fetchYc } from '../lib/sources/yc';
import { fetchLinkedInPostsViaApify } from '../lib/sources/apify';
import { fetchTelegramChannels } from '../lib/sources/telegram';
import { fetchHimalayas, fetchRemotive, fetchJobicy } from '../lib/sources/boards';
import { fetchViaFirecrawl } from '../lib/sources/firecrawl';
import { passes } from '../lib/filters';
import type { Job } from '../lib/types';

const NEW_SOURCES = ['tgchannel', 'himalayas', 'remotive', 'jobicy', 'waas', 'wellfound'];

const sources: Array<[string, () => Promise<Job[]>]> = [
  ['remoteok', fetchRemoteOk],
  ['wwr', fetchWeWorkRemotely],
  ['hn', fetchHnWhoIsHiring],
  ['internshala', fetchInternshala],
  ['linkedin', fetchLinkedInViaSerper],
  ['unstop', fetchUnstop],
  ['yc', fetchYc],
  ['apify', fetchLinkedInPostsViaApify],
  ['tgchannel', fetchTelegramChannels],
  ['himalayas', fetchHimalayas],
  ['remotive', fetchRemotive],
  ['jobicy', fetchJobicy],
  ['firecrawl', fetchViaFirecrawl],
];

const t0 = Date.now();
const timed = await Promise.all(
  sources.map(async ([name, fn]) => {
    const s = Date.now();
    try {
      const jobs = await fn();
      return { name, jobs, ms: Date.now() - s, error: null as string | null };
    } catch (e) {
      return { name, jobs: [] as Job[], ms: Date.now() - s, error: (e as Error).message };
    }
  })
);
const wall = ((Date.now() - t0) / 1000).toFixed(1);

for (const t of timed) {
  console.log(
    `${t.name.padEnd(12)} ${String(t.jobs.length).padStart(4)} jobs  ${(t.ms / 1000)
      .toFixed(1)
      .padStart(6)}s${t.error ? `  ERROR: ${t.error}` : ''}`
  );
}
const all = timed.flatMap((t) => t.jobs);
const finals = all.filter(passes);
console.log(`\nWALL-CLOCK ${wall}s (limit 60s) · fetched ${all.length} · final ${finals.length}`);

const fromNew = finals.filter((j) => NEW_SOURCES.includes(j.source));
console.log(`\n--- final matches from the new sources (${fromNew.length}) ---`);
for (const j of fromNew) {
  console.log(`• [${j.source}] ${j.title} @ ${j.company} · ${j.url}`);
}
