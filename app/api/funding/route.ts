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

  // Vercel Hobby caps at 2 crons and both are taken, so morning outreach rides along with
  // the funding scan rather than getting its own schedule. That makes this route the one
  // that mails real founders, so it must send on the SCHEDULE and never merely because
  // someone curled it while debugging.
  //
  // The trigger is Vercel's documented cron user-agent, not a query string: the docs
  // guarantee `vercel-cron/1.0` on scheduled invocations but say nothing about query
  // strings surviving in a cron `path`, and betting on that would fail silently — the
  // schedule would run, never send, and look configured. `?autosend=true` forces a send
  // manually; `?autosend=dry` reports what would go out and sends nothing.
  const autosend = url.searchParams.get('autosend');
  const isVercelCron = /vercel-cron/i.test(request.headers.get('user-agent') ?? '');
  const shouldSend = autosend === 'true' || (isVercelCron && autosend !== 'off');

  try {
    const result = await runFundingScan();

    if (shouldSend || autosend === 'dry') {
      const send = await runAutoSend({ dryRun: autosend === 'dry' });
      return Response.json({ ok: true, ...result, autosend: send, triggeredByCron: isVercelCron });
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
