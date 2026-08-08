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

  try {
    const result = await runFundingScan();
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
