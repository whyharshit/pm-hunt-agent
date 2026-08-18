import nodemailer from 'nodemailer';
import { toHtml } from './mail-html';
import { RESUME_FILENAME, readResumePdf, resumeDelivery, resumeLinkUrl } from './resume-file';
import { recordAgentRun, setAgentRunning } from './storage';

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

export type SendResult = { id: string; to: string };

export class MailConfigError extends Error {}

/**
 * Two transports, Gmail first.
 *
 * Gmail SMTP needs no verified domain — the blocker that kept Resend unusable here, since
 * a Resend account with zero verified domains can only mail its own owner. Sending from
 * the user's real Gmail is also the better cold-outreach channel at this volume: a
 * student's actual address reads genuine, while a freshly verified domain has no sending
 * reputation and tends to land in spam. Gmail allows ~500/day, far beyond what this needs.
 *
 * Resend stays as the fallback for whenever a domain does get verified — better long-term
 * deliverability and it keeps outreach out of the personal inbox.
 *
 * Note IMAP is NOT an option for SENDING with either: it is a read protocol, sending is SMTP.
 * Reading is exactly what it is for, though, and lib/imap.ts uses the same Gmail credentials
 * to check whether a founder replied before a follow-up goes out.
 */
type Transport =
  | { kind: 'gmail'; user: string; pass: string; from: string }
  | { kind: 'resend'; apiKey: string; from: string };

function config(): Transport {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (user && pass) {
    // Gmail rejects any From that isn't the authenticated account or one of its configured
    // aliases, so MAIL_FROM deliberately cannot override the address here — only the
    // display name, via MAIL_FROM_NAME.
    const name = process.env.MAIL_FROM_NAME?.trim();
    return { kind: 'gmail', user, pass, from: name ? `${name} <${user}>` : user };
  }

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;
  if (apiKey && from) return { kind: 'resend', apiKey, from };

  if (apiKey && !from) {
    throw new MailConfigError(
      'RESEND_API_KEY is set but MAIL_FROM is not — set MAIL_FROM to an address on a ' +
        'Resend-verified domain, or set GMAIL_USER + GMAIL_APP_PASSWORD to send via Gmail'
    );
  }
  throw new MailConfigError(
    'No mail transport configured — set GMAIL_USER + GMAIL_APP_PASSWORD (Gmail App ' +
      'Password), or RESEND_API_KEY + MAIL_FROM'
  );
}

export function mailerConfigured(): boolean {
  const gmail = Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
  const resend = Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
  return gmail || resend;
}

/**
 * Send exactly one email to exactly one recipient. There is deliberately no batch
 * variant: mass cold email burns the sending domain, and this project's whole premise
 * is that a human reviews every message before it goes out.
 */
export type Attachment = { filename: string; content: Buffer };

export async function sendMail(opts: {
  to: string;
  subject: string;
  text: string;
  /**
   * Optional HTML part. Sent ALONGSIDE `text`, never instead of it, so the message is
   * multipart/alternative and a client that refuses HTML still shows the real words.
   */
  html?: string;
  replyTo?: string;
  attachments?: Attachment[];
  /** Message-ID of the message this replies to. Puts a follow-up INSIDE the original thread. */
  inReplyTo?: string;
  /** The thread's Message-ID chain, oldest first. Clients that ignore In-Reply-To use this. */
  references?: string[];
}): Promise<SendResult> {
  const transport = config();
  const attachments = opts.attachments ?? [];

  if (transport.kind === 'gmail') {
    // Port 587 + STARTTLS rather than 465/implicit TLS: Vercel's Node runtime allows the
    // outbound TCP either way, but 587 is the submission port Gmail documents for app
    // passwords and it fails faster and more legibly when the password is wrong.
    const mailer = nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 587,
      secure: false,
      auth: { user: transport.user, pass: transport.pass },
    });

    try {
      const info = await mailer.sendMail({
        from: transport.from,
        to: opts.to,
        subject: opts.subject,
        text: opts.text,
        ...(opts.html ? { html: opts.html } : {}),
        ...(opts.replyTo ? { replyTo: opts.replyTo } : {}),
        ...(opts.inReplyTo ? { inReplyTo: opts.inReplyTo } : {}),
        ...(opts.references?.length ? { references: opts.references } : {}),
        ...(attachments.length
          ? { attachments: attachments.map((a) => ({ filename: a.filename, content: a.content })) }
          : {}),
      });
      if (!info.messageId) throw new Error('Gmail accepted the message but returned no id');
      return { id: info.messageId, to: opts.to };
    } catch (e) {
      const msg = (e as Error).message;
      // The single most likely failure, and the raw SMTP text for it is unhelpful.
      if (/invalid login|username and password not accepted|535/i.test(msg)) {
        throw new Error(
          `Gmail rejected the login — GMAIL_APP_PASSWORD must be a 16-character App ` +
            `Password (not the account password), and 2-Step Verification must be on. (${msg})`
        );
      }
      throw new Error(`Gmail SMTP: ${msg}`);
    }
  }

  const res = await fetch(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${transport.apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      from: transport.from,
      to: [opts.to],
      subject: opts.subject,
      text: opts.text,
      ...(opts.html ? { html: opts.html } : {}),
      ...(opts.replyTo ? { reply_to: opts.replyTo } : {}),
      // No inReplyTo/references here: Resend's send API takes no threading headers, so a
      // follow-up sent through this transport lands as a fresh message rather than in the
      // thread. Acceptable while Resend is the dormant fallback and Gmail is live; if that
      // ever flips, threading has to move to Resend's custom-headers field.
      // Resend takes attachment bytes as base64, unlike nodemailer's Buffer.
      ...(attachments.length
        ? {
            attachments: attachments.map((a) => ({
              filename: a.filename,
              content: a.content.toString('base64'),
            })),
          }
        : {}),
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
  inReplyTo?: string;
  references?: string[];
  /**
   * Defaults to true so the initial cold email always carries the resume. Follow-ups pass
   * false: the PDF is already sitting in the thread, and re-attaching 150KB on every bump is
   * both pointless and one of the things spam filters actually score on.
   */
  attachResume?: boolean;
}): Promise<SendResult> {
  const { company, attachResume = true, ...mail } = opts;
  await setAgentRunning('mailer');
  try {
    // Every outreach email carries the resume (user's instruction 2026-08-09). Delivered
    // here, in the single funnel all outreach passes through, so the manual dashboard send
    // and the unattended cron send can never diverge on what the recipient receives.
    //
    // `attachResume` means "include the resume", not "attach it specifically" — follow-ups
    // pass false because it is already in the thread, whichever way it travelled.
    const delivery = resumeDelivery();
    const wantsFile = attachResume && delivery !== 'link';
    const resume = wantsFile ? await readResumePdf() : null;

    // The link goes UNDER the signature, where a signature link belongs, rather than being
    // injected into the body — the body is the user's own copy and the mailer does not edit it.
    const link = attachResume && delivery !== 'attach' ? resumeLinkUrl() : '';
    const text = link ? `${mail.text}\n\nResume: ${link}` : mail.text;

    const result = await sendMail({
      ...mail,
      text,
      // Built here for the same reason the resume is attached here: this is the one funnel
      // all outreach passes through, so the dashboard send and the unattended cron can never
      // disagree about what the founder sees.
      html: toHtml(text),
      ...(resume ? { attachments: [{ filename: RESUME_FILENAME, content: resume }] } : {}),
    });
    await recordAgentRun('mailer', {
      state: 'ok',
      // Records whether the resume actually went, so a silently missing attachment is
      // visible on the agent card instead of being discovered by a founder.
      summary:
        `sent to ${opts.to} (${company})` +
        (attachResume
          ? resume && link
            ? ' + resume (attached and linked)'
            : resume
              ? ' + resume'
              : link
                ? ' + resume link'
                : ' — NO RESUME SENT'
          : ' · follow-up'),
      error: null,
    });
    return result;
  } catch (e) {
    await recordAgentRun('mailer', { state: 'error', error: (e as Error).message });
    throw e;
  }
}
