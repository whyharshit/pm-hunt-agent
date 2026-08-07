import { runDiscovery } from '@/lib/discover';
import { fetchRemoteOk } from '@/lib/sources/remoteok';
import { fetchWeWorkRemotely } from '@/lib/sources/wwr';
import { fetchHnWhoIsHiring } from '@/lib/sources/hn';
import { fetchInternshala } from '@/lib/sources/internshala';
import { fetchLinkedInViaSerper } from '@/lib/sources/linkedin';
import { fetchUnstop } from '@/lib/sources/unstop';
import { fetchYc } from '@/lib/sources/yc';
import { fetchLinkedInPostsViaApify } from '@/lib/sources/apify';
import { fetchTelegramChannels } from '@/lib/sources/telegram';
import { fetchHimalayas, fetchRemotive, fetchJobicy } from '@/lib/sources/boards';
import { fetchViaFirecrawl } from '@/lib/sources/firecrawl';
import { isIntern, isProductOrOps, isRemote, isHardRejected } from '@/lib/filters';
import type { Job } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const url = new URL(request.url);
  const notify = url.searchParams.get('notify') !== 'false';
  const debug = url.searchParams.get('debug') === 'true';

  if (debug) {
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
    const perSource = await Promise.all(
      sources.map(([, fn]) => fn().catch((): Job[] => []))
    );
    const fetchedBySource = Object.fromEntries(
      sources.map(([name], i) => [name, perSource[i].length])
    );
    const all = perSource.flat();

    const internOnly = all.filter(isIntern);
    const internAndRole = internOnly.filter(isProductOrOps);
    const internAndRoleAndRemote = internAndRole.filter(isRemote);
    const final = internAndRoleAndRemote.filter((j) => !isHardRejected(j));
    const rejectedByHard = internAndRoleAndRemote.filter(isHardRejected);

    return Response.json({
      counts: {
        fetched: all.length,
        fetchedBySource,
        passIntern: internOnly.length,
        passInternAndRole: internAndRole.length,
        passInternAndRoleAndRemote: internAndRoleAndRemote.length,
        finalAfterHardReject: final.length,
        rejectedByHardCount: rejectedByHard.length,
      },
      internSamples: internOnly.slice(0, 10).map((j) => ({
        title: j.title,
        company: j.company,
        source: j.source,
        passRole: isProductOrOps(j),
        passRemote: isRemote(j),
        hardRejected: isHardRejected(j),
      })),
      finalMatches: final.map((j) => ({
        title: j.title,
        company: j.company,
        source: j.source,
        url: j.url,
      })),
      rejectedByHard: rejectedByHard.map((j) => ({ title: j.title, company: j.company })),
    });
  }

  try {
    const result = await runDiscovery({ notify });
    return Response.json({
      ok: true,
      fetched: result.fetched,
      filtered: result.filtered,
      newCount: result.newJobs.length,
      errors: result.errors,
    });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
