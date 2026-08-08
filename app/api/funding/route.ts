import { runAutoSend } from '@/lib/autosend';
import { runFundingScan } from '@/lib/funding';
import { fetchFundingNews } from '@/lib/sources/fundingnews';
import { fetchTechCrunchFundingDetailed } from '@/lib/sources/techcrunch';

export const dynamic = 'force-dynamic';
export const maxDuration = 120;

function authOk(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

async function handle(request: Request) {
  if (!authOk(request)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  // Debug must exercise the SAME sources the real scan does, or it reports health for a
  // subset and a broken feed hides behind a green check.
  if (url.searchParams.get('debug') === 'true') {
    const [tc, news] = await Promise.all([
      fetchTechCrunchFundingDetailed().catch((e) => ({ error: (e as Error).message })),
      fetchFundingNews().catch((e) => ({ error: (e as Error).message })),
    ]);
    return Response.json({ debug: true, techcrunch: tc, news });
  }

  // Auto-send is OPT-IN per request, never implied by hitting this route.
  //
  // Vercel Hobby caps at 2 crons and both are taken, so morning outreach rides along with
  // the funding scan rather than getting its own schedule. That makes this route the thing
  // that sends real email to real founders, and any manual call to it during debugging
  // would otherwise do so silently. `?autosend=true` lives in vercel.json's cron path and
  // nowhere else; `?autosend=dry` reports what would go out and sends nothing.
  const autosend = url.searchParams.get('autosend');

  try {
    const result = await runFundingScan();

    if (autosend === 'true' || autosend === 'dry') {
      const send = await runAutoSend({ dryRun: autosend === 'dry' });
      return Response.json({ ok: true, ...result, autosend: send });
    }

    return Response.json({ ok: true, ...result });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return handle(request);
}

export async function GET(request: Request) {
  return handle(request);
}
