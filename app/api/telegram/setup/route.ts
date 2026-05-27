export const dynamic = 'force-dynamic';
export const maxDuration = 15;

const TG_API = 'https://api.telegram.org';

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return Response.json({ ok: false, error: 'CRON_SECRET not set' }, { status: 500 });
  const auth = request.headers.get('authorization');
  if (auth !== `Bearer ${secret}`) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action') ?? 'info';
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (!token) return Response.json({ ok: false, error: 'TELEGRAM_BOT_TOKEN not set' }, { status: 500 });

  if (action === 'register') {
    if (!webhookSecret) {
      return Response.json({ ok: false, error: 'TELEGRAM_WEBHOOK_SECRET not set' }, { status: 500 });
    }
    const target = url.searchParams.get('url') ?? `https://${request.headers.get('host')}/api/telegram/webhook`;
    const res = await fetch(`${TG_API}/bot${token}/setWebhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: target,
        secret_token: webhookSecret,
        allowed_updates: ['message', 'edited_message'],
      }),
    });
    return Response.json({ ok: res.ok, registeredAs: target, telegram: await res.json() });
  }

  if (action === 'delete') {
    const res = await fetch(`${TG_API}/bot${token}/deleteWebhook`, { method: 'POST' });
    return Response.json({ ok: res.ok, telegram: await res.json() });
  }

  const res = await fetch(`${TG_API}/bot${token}/getWebhookInfo`);
  return Response.json({ ok: res.ok, telegram: await res.json() });
}
