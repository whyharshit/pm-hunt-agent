import { getPdf, getTailored, getTracked, savePdf } from '@/lib/storage';
import { renderResumePdf } from '@/lib/pdf/render';
import type { StoredPdf } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function authOk(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

function safeFilename(name: string): string {
  return name.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '');
}

async function handle(request: Request) {
  if (!authOk(request)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const id = url.searchParams.get('id');
  const force = url.searchParams.get('force') === 'true';
  const download = url.searchParams.get('download') === 'true';
  const useTailored = url.searchParams.get('tailored') !== 'false';

  if (!id) return Response.json({ ok: false, error: 'missing id' }, { status: 400 });

  const tracked = await getTracked(id);
  if (!tracked) return Response.json({ ok: false, error: 'tracker not found' }, { status: 404 });

  let stored = force ? null : await getPdf(id);

  if (!stored) {
    const tailored = useTailored ? await getTailored(id) : null;
    const buf = await renderResumePdf(
      tailored
        ? {
            summary: tailored.summary,
            experience: tailored.experience,
          }
        : undefined
    );
    stored = {
      base64: buf.toString('base64'),
      size: buf.length,
      generatedAt: new Date().toISOString(),
      tailoredAt: tailored?.generatedAt ?? null,
    } satisfies StoredPdf;
    await savePdf(id, stored);
  }

  if (download) {
    const company = tracked.company ? safeFilename(tracked.company) : 'company';
    const filename = `Harshit_Verma_${company}.pdf`;
    const bytes = Buffer.from(stored.base64, 'base64');
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `inline; filename="${filename}"`,
        'cache-control': 'private, max-age=0, no-store',
      },
    });
  }

  return Response.json({
    ok: true,
    size: stored.size,
    generatedAt: stored.generatedAt,
    tailoredAt: stored.tailoredAt,
  });
}

export async function POST(request: Request) {
  return handle(request);
}

export async function GET(request: Request) {
  return handle(request);
}
