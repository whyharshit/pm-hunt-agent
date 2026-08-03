import { ingestWhatsappMessages, parseIncoming } from '@/lib/whatsapp/ingest';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** A bridge batch. Bigger batches get rejected rather than silently truncated. */
const MAX_BATCH = 200;

export async function POST(request: Request) {
  // Unlike the Telegram webhook (which is also chat-id locked), this endpoint's only
  // gate is the bearer token — so a missing secret fails closed, never open.
  const secret = process.env.WHATSAPP_INGEST_SECRET;
  if (!secret) {
    return Response.json(
      { ok: false, error: 'WHATSAPP_INGEST_SECRET is not set — ingest disabled' },
      { status: 503 }
    );
  }
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ ok: false, error: 'bad json' }, { status: 400 });
  }

  let messages;
  try {
    messages = parseIncoming(body);
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 400 });
  }

  if (messages.length > MAX_BATCH) {
    return Response.json(
      { ok: false, error: `batch too large: ${messages.length} > ${MAX_BATCH}` },
      { status: 413 }
    );
  }

  const notify = new URL(request.url).searchParams.get('notify') !== 'false';

  try {
    const result = await ingestWhatsappMessages(messages, { notify });
    return Response.json({ ok: true, ...result });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function GET() {
  return Response.json({ ok: true, hint: 'POST only — WhatsApp bridge ingest' });
}
