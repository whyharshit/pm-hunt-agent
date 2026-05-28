import { getJd, getTracked, saveJd, updateTracked } from '@/lib/storage';
import { scrapeJd, ScrapeError } from '@/lib/scrape';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

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
  const id = url.searchParams.get('id');
  const force = url.searchParams.get('force') === 'true';
  if (!id) {
    return Response.json({ ok: false, error: 'missing id' }, { status: 400 });
  }

  const tracked = await getTracked(id);
  if (!tracked) {
    return Response.json({ ok: false, error: 'tracker not found' }, { status: 404 });
  }
  if (tracked.tier === 'green') {
    return Response.json({ ok: false, error: 'green tier (Google Form) — no JD to scrape' }, { status: 400 });
  }

  if (!force) {
    const existing = await getJd(id);
    if (existing) {
      return Response.json({ ok: true, cached: true, jd: existing });
    }
  }

  try {
    const jd = await scrapeJd(tracked.url);
    await saveJd(id, jd);

    const patch: Parameters<typeof updateTracked>[1] = {};
    if (!tracked.company && jd.company) patch.company = jd.company;
    if (!tracked.role && jd.role) patch.role = jd.role;
    if (Object.keys(patch).length > 0) await updateTracked(id, patch);

    return Response.json({ ok: true, cached: false, jd });
  } catch (e) {
    const err = e as ScrapeError;
    return Response.json(
      { ok: false, error: err.message, status: err.status ?? null },
      { status: 502 }
    );
  }
}

export async function POST(request: Request) {
  return handle(request);
}

export async function GET(request: Request) {
  return handle(request);
}
