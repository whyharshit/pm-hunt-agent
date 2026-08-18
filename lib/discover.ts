import { fetchRemoteOk } from './sources/remoteok';
import { fetchWeWorkRemotely } from './sources/wwr';
import { fetchHnWhoIsHiring } from './sources/hn';
import { fetchInternshala } from './sources/internshala';
import { fetchLinkedInViaSerper } from './sources/linkedin';
import { fetchLinkedInGuest } from './sources/linkedin-guest';
import { fetchUnstop } from './sources/unstop';
import { fetchYc } from './sources/yc';
import { fetchLinkedInPostsViaApify } from './sources/apify';
import { fetchLinkedInPostSearch } from './sources/apify-posts';
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

/**
 * Comment mining and post search are BOTH Apify, both bill $0.002 an item, and the free plan
 * is $5 a month — measured 2026-08-17 with $3.56 of it already spent. Running both would
 * empty the plan inside a week and then fail as "no new matches", which is the worst possible
 * way for a source to die.
 *
 * So post search (lib/sources/apify-posts.ts) takes the budget by default and the comment
 * miner stands down: it is the same money for a hiring post instead of a comment that might
 * lead to one, and on 2026-08-17 the comment miner's entire daily yield was 2 posts.
 * `APIFY_MINE_COMMENTS=true` runs both.
 *
 * ⚠️ SINCE 2026-08-18 POST SEARCH IS FOUR SCRAPERS, NOT ONE — one lane per role family
 * (product, founder's office/strategy, data, SWE), on the user's instruction, and the comment
 * miner is the fifth of that set rather than an alternative to it. They still share ONE
 * budget, `APIFY_POSTS_PER_RUN`, because they still share one $5 plan unless more tokens are
 * added to `APIFY_TOKENS`. Turning this on without raising that budget makes every lane
 * shallower; turning it on without more tokens makes the plan run out sooner.
 */
function mineComments(): boolean {
  return /^(1|true|yes)$/i.test(process.env.APIFY_MINE_COMMENTS ?? '');
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
      safe('linkedin-guest', fetchLinkedInGuest, errors),
      safe('unstop', fetchUnstop, errors),
      safe('yc', fetchYc, errors),
      safe('apify-posts', fetchLinkedInPostSearch, errors),
      mineComments() ? safe('apify', fetchLinkedInPostsViaApify, errors) : Promise.resolve([]),
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
