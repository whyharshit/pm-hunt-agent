import { runDiscovery } from '@/lib/discover';
import { fetchRemoteOk } from '@/lib/sources/remoteok';
import { fetchWeWorkRemotely } from '@/lib/sources/wwr';
import { fetchHnWhoIsHiring } from '@/lib/sources/hn';
import { fetchInternshala } from '@/lib/sources/internshala';
import { fetchLinkedInViaSerper } from '@/lib/sources/linkedin';
import { isIntern, isProductOrOps, isRemote, isHardRejected } from '@/lib/filters';

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
    const [remoteOk, wwr, hn, internshala, linkedin] = await Promise.all([
      fetchRemoteOk().catch(() => []),
      fetchWeWorkRemotely().catch(() => []),
      fetchHnWhoIsHiring().catch(() => []),
      fetchInternshala().catch(() => []),
      fetchLinkedInViaSerper().catch(() => []),
    ]);
    const all = [...remoteOk, ...wwr, ...hn, ...internshala, ...linkedin];

    const internOnly = all.filter(isIntern);
    const internAndRole = internOnly.filter(isProductOrOps);
    const internAndRoleAndRemote = internAndRole.filter(isRemote);
    const final = internAndRoleAndRemote.filter((j) => !isHardRejected(j));
    const rejectedByHard = internAndRoleAndRemote.filter(isHardRejected);

    return Response.json({
      counts: {
        fetched: all.length,
        fetchedBySource: {
          remoteok: remoteOk.length,
          wwr: wwr.length,
          hn: hn.length,
          internshala: internshala.length,
          linkedin: linkedin.length,
        },
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
