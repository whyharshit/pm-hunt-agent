import { fetchRemoteOk } from './sources/remoteok';
import { fetchWeWorkRemotely } from './sources/wwr';
import { fetchHnWhoIsHiring } from './sources/hn';
import { fetchInternshala } from './sources/internshala';
import { fetchLinkedInViaSerper } from './sources/linkedin';
import { fetchUnstop } from './sources/unstop';
import { fetchYc } from './sources/yc';
import { fetchLinkedInPostsViaApify } from './sources/apify';
import { fetchTelegramChannels } from './sources/telegram';
import { fetchHimalayas, fetchRemotive, fetchJobicy } from './sources/boards';
import { fetchViaFirecrawl } from './sources/firecrawl';
import { passes } from './filters';
import { getSeenIds, markSeen, recordAgentRun, saveJobs, setAgentRunning } from './storage';
import { sendTelegram, formatDigest } from './telegram';
import type { Job } from './types';

export type DiscoverResult = {
  fetched: number;
  filtered: number;
  newJobs: Job[];
  errors: string[];
};

async function safe<T>(label: string, fn: () => Promise<T>, errors: string[]): Promise<T | null> {
  try {
    return await fn();
  } catch (e) {
    errors.push(`${label}: ${(e as Error).message}`);
    return null;
  }
}

export async function runDiscovery(opts: { notify?: boolean } = {}): Promise<DiscoverResult> {
  const errors: string[] = [];
  await setAgentRunning('discover');

  try {
    // Folded into this one cron rather than given their own: Hobby caps at 2 daily crons.
    const results = await Promise.all([
      safe('remoteok', fetchRemoteOk, errors),
      safe('wwr', fetchWeWorkRemotely, errors),
      safe('hn', fetchHnWhoIsHiring, errors),
      safe('internshala', fetchInternshala, errors),
      safe('linkedin', fetchLinkedInViaSerper, errors),
      safe('unstop', fetchUnstop, errors),
      safe('yc', fetchYc, errors),
      safe('apify', fetchLinkedInPostsViaApify, errors),
      safe('tgchannel', fetchTelegramChannels, errors),
      safe('himalayas', fetchHimalayas, errors),
      safe('remotive', fetchRemotive, errors),
      safe('jobicy', fetchJobicy, errors),
      safe('firecrawl', fetchViaFirecrawl, errors),
    ]);

    const all: Job[] = results.flatMap((r) => r ?? []);
    const matching = all.filter(passes);

    const seen = await getSeenIds();
    const fresh = matching.filter((j) => !seen.has(j.id));

    if (fresh.length > 0) {
      await saveJobs(fresh);
      await markSeen(fresh.map((j) => j.id));
    }

    // Only ping on something actionable. A daily "no new matches" is the norm, not news —
    // the filters are title-anchored and generic boards are intern-sparse for this profile.
    // Source failures still get through: silence should mean "nothing found", not "nothing ran".
    if (opts.notify ?? true) {
      if (fresh.length > 0) {
        await sendTelegram(formatDigest(fresh));
      } else if (errors.length > 0) {
        await sendTelegram(
          `<b>PM Hunt Agent</b>\nChecked ${all.length} listings, no new matches.\n\n<i>Errors: ${errors.join('; ')}</i>`
        );
      }
    }

    await recordAgentRun('discover', {
      state: 'ok',
      summary: `fetched ${all.length} · ${matching.length} matched · ${fresh.length} new`,
      stats: { fetched: all.length, filtered: matching.length, new: fresh.length },
      error: errors.length ? errors.join('; ') : null,
    });

    return { fetched: all.length, filtered: matching.length, newJobs: fresh, errors };
  } catch (e) {
    await recordAgentRun('discover', { state: 'error', error: (e as Error).message });
    throw e;
  }
}
