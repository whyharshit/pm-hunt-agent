import { fetchRemoteOk } from './sources/remoteok';
import { fetchWeWorkRemotely } from './sources/wwr';
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
    // HN "Who's Hiring" source disabled — broken, pulls discussion comments, not job posts.
    // TODO: rewrite to fetch the monthly "Ask HN: Who is hiring?" thread and parse top-level kids.
    const [remoteOk, wwr] = await Promise.all([
      safe('remoteok', fetchRemoteOk, errors),
      safe('wwr', fetchWeWorkRemotely, errors),
    ]);

    const all: Job[] = [...(remoteOk ?? []), ...(wwr ?? [])];
    const matching = all.filter(passes);

    const seen = await getSeenIds();
    const fresh = matching.filter((j) => !seen.has(j.id));

    if (fresh.length > 0) {
      await saveJobs(fresh);
      await markSeen(fresh.map((j) => j.id));
    }

    if (opts.notify ?? true) {
      const msg =
        fresh.length === 0
          ? `<b>PM Hunt Agent</b>\nChecked ${all.length} listings. No new matches.${errors.length ? `\n\n<i>Errors: ${errors.join('; ')}</i>` : ''}`
          : formatDigest(fresh);
      await sendTelegram(msg);
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
