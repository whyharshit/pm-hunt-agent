import { recordAgentRun, setAgentRunning } from './storage';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export type SendResult = { id: string; to: string };

export class MailConfigError extends Error {}

/**
 * Resend's REST API directly — one fetch, no SDK dependency for a single endpoint.
 * MAIL_FROM must be an address on a domain verified in Resend, e.g.
 * "Shivansh <hello@lovingroom.co>"; Resend rejects unverified senders outright.
 */
function config(): { apiKey: string; from: string } {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (!apiKey) throw new MailConfigError('RESEND_API_KEY not set — add it on Vercel to enable sending');
  if (!from) throw new MailConfigError('MAIL_FROM not set — e.g. "Shivansh <hello@lovingroom.co>"');
  return { apiKey, from };
}

export function mailerConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

/**
 * Send exactly one email to exactly one recipient. There is deliberately no batch
 * variant: mass cold email burns the sending domain, and this project's whole premise
 * is that a human reviews every message before it goes out.
 */
export async function sendMail(opts: {
  to: string;
  subject: string;
  text: string;
  replyTo?: string;
}): Promise<SendResult> {
  const { apiKey, from } = config();

  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [opts.to],
      subject: opts.subject,
      text: opts.text,
      ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
    }),
  });

  const body = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
  if (!res.ok) {
    throw new Error(`Resend ${res.status}: ${body.message ?? body.name ?? 'send failed'}`);
  }
  if (!body.id) throw new Error('Resend accepted the request but returned no id');
  return { id: body.id, to: opts.to };
}

/** Wraps sendMail with agent run-state so the Mailing Agent card reports on the dashboard. */
export async function sendOutreachMail(opts: {
  to: string;
  subject: string;
  text: string;
  company: string;
}): Promise<SendResult> {
  await setAgentRunning('mailer');
  try {
    const result = await sendMail(opts);
    await recordAgentRun('mailer', {
      state: 'ok',
      summary: `sent to ${opts.to} (${opts.company})`,
      error: null,
    });
    return result;
  } catch (e) {
    await recordAgentRun('mailer', { state: 'error', error: (e as Error).message });
    throw e;
  }
}
