import { classifyUrl, extractUrls, TIER_EMOJI } from '@/lib/classify';
import { getTracked, recordAgentRun, saveTracked, urlId } from '@/lib/storage';
import { sendTelegram } from '@/lib/telegram';
import type { TrackedUrl } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 30;

type TgUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number };
    date: number;
    text?: string;
    caption?: string;
  };
  edited_message?: { text?: string; chat: { id: number } };
};

function ok() {
  return Response.json({ ok: true });
}

export async function POST(request: Request) {
  const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (expectedSecret) {
    const got = request.headers.get('x-telegram-bot-api-secret-token');
    if (got !== expectedSecret) {
      return Response.json({ ok: false, error: 'bad secret' }, { status: 401 });
    }
  }

  let update: TgUpdate;
  try {
    update = (await request.json()) as TgUpdate;
  } catch {
    return Response.json({ ok: false, error: 'bad json' }, { status: 400 });
  }

  const msg = update.message ?? update.edited_message;
  if (!msg) return ok();

  const allowedChat = process.env.TELEGRAM_CHAT_ID;
  if (allowedChat && String(msg.chat.id) !== String(allowedChat)) {
    return ok();
  }

  const m = msg as { text?: string; caption?: string };
  const text = m.text ?? m.caption ?? '';
  const urls = extractUrls(text);

  if (urls.length === 0) {
    await sendTelegram('No URL found in that message. Paste a job link and I\'ll track it.', msg.chat.id);
    return ok();
  }

  const lines: string[] = [];
  let added = 0;
  let lastTier: TrackedUrl['tier'] | null = null;
  for (const url of urls) {
    const id = urlId(url);
    const existing = await getTracked(id);
    if (existing) {
      lines.push(`↩️ Already tracked: ${TIER_EMOJI[existing.tier]} ${url}`);
      continue;
    }
    const tier = classifyUrl(url);
    const t: TrackedUrl = {
      id,
      url,
      tier,
      source: 'telegram',
      addedAt: new Date().toISOString(),
      status: 'new',
    };
    await saveTracked(t);
    added += 1;
    lastTier = tier;
    lines.push(`✅ Added ${TIER_EMOJI[tier]} ${url}`);
  }

  await recordAgentRun('intake', {
    state: 'ok',
    summary:
      added > 0
        ? `+${added} URL${added > 1 ? 's' : ''}${lastTier ? ` · ${TIER_EMOJI[lastTier]} ${lastTier}` : ''}`
        : `${urls.length} URL — already tracked`,
    stats: { received: urls.length, added },
  });

  await sendTelegram(lines.join('\n'), msg.chat.id);
  return ok();
}

export async function GET() {
  return Response.json({ ok: true, hint: 'POST only — Telegram webhook' });
}
