import { getPdf, getTracked } from '@/lib/storage';

export const dynamic = 'force-dynamic';

function safeFilename(name: string): string {
  return name.replace(/[^a-z0-9_-]+/gi, '_').replace(/^_+|_+$/g, '');
}

// Auth is enforced upstream by proxy.ts basic-auth (matcher covers /download/:path*),
// so no bearer here — the dashboard links to this directly from the browser.
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;

  const stored = await getPdf(id);
  if (!stored) {
    return new Response('No tailored PDF yet — run Tailor first.', { status: 404 });
  }

  const tracked = await getTracked(id);
  const company = tracked?.company ? safeFilename(tracked.company) : 'company';
  const filename = `Shivansh_Chaudhary_${company}.pdf`;
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
