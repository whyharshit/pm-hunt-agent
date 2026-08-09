import { ImapFlow } from 'imapflow';

/**
 * Read the user's own Gmail, for one purpose: knowing whether a founder already answered.
 *
 * WHY THIS EXISTS
 * Before this, nothing in the project could tell "emailed, silence" from "emailed, they
 * replied". `FundingItem.status = 'contacted'` is set by the cron, by the manual send AND by
 * a human picking it from a dropdown, so it is not a signal. Sending a follow-up to a founder
 * who already wrote back is the single worst thing the follow-up pass could do, and without a
 * read channel it would do it blind.
 *
 * WHY IMAP AND NOT THE GMAIL API
 * A Gmail App Password already exists for SMTP, and the same password authenticates IMAP. The
 * Gmail API would mean an OAuth client, a consent screen, a refresh token and a second secret
 * to rotate, to answer one yes/no question. Outbound TCP from Vercel's Node runtime is already
 * proven by nodemailer on port 587.
 *
 * This module only ever READS. It never marks messages seen (every search and fetch here is
 * non-destructive), never moves anything, and never deletes.
 */

const IMAP_HOST = 'imap.gmail.com';
const IMAP_PORT = 993;

/** Same credentials as the Gmail SMTP transport in lib/mailer.ts. */
export function imapConfigured(): boolean {
  return Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
}

export class ImapConfigError extends Error {}

/**
 * Open ONE connection, run everything, close it.
 *
 * The follow-up pass checks several sequences per run and each check is a search on an
 * already-open mailbox. Connecting per sequence would spend the whole function budget on TLS
 * handshakes and Gmail's login throttle, so the caller wraps the entire pass in a single
 * `withImap`.
 */
export async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const user = process.env.GMAIL_USER;
  const pass = process.env.GMAIL_APP_PASSWORD;
  if (!user || !pass) {
    throw new ImapConfigError(
      'IMAP needs GMAIL_USER + GMAIL_APP_PASSWORD (the same App Password the SMTP sender uses)'
    );
  }

  const client = new ImapFlow({
    host: IMAP_HOST,
    port: IMAP_PORT,
    secure: true,
    auth: { user, pass },
    // Without this imapflow writes a JSON log line per IMAP command to stdout, which on
    // Vercel means every function log is IMAP chatter.
    logger: false,
    // IDLE is for long-lived listeners. This connection lives for one pass and then closes.
    disableAutoIdle: true,
  });

  try {
    await client.connect();
    return await fn(client);
  } catch (e) {
    const msg = (e as Error).message;
    // The likeliest failure by far, and the raw IMAP text for it says nothing useful.
    if (/invalid credentials|authenticationfailed|auth/i.test(msg)) {
      throw new Error(
        `Gmail rejected the IMAP login — GMAIL_APP_PASSWORD must be a 16-character App ` +
          `Password and IMAP must be enabled in Gmail settings. (${msg})`
      );
    }
    throw new Error(`IMAP: ${msg}`);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

/**
 * Did anything arrive from this address since we last wrote to them?
 *
 * IMAP's SINCE is date-granular and ignores the time of day, so this is slightly
 * over-inclusive: mail that arrived earlier on the same day as our send also matches. That
 * error runs in the safe direction. A false "they replied" costs one unsent follow-up; a
 * false "they didn't" mails someone who already answered.
 */
export async function hasReplyFrom(
  client: ImapFlow,
  address: string,
  since: Date
): Promise<boolean> {
  // readOnly opens the mailbox with EXAMINE rather than SELECT, so the server itself refuses
  // any state change. The claim that this module only reads is enforced by the protocol.
  const lock = await client.getMailboxLock('INBOX', { readOnly: true });
  try {
    const hits = await client.search({ from: address, since }, { uid: true });
    return Array.isArray(hits) && hits.length > 0;
  } finally {
    lock.release();
  }
}

/**
 * Did this address bounce? Gmail delivers hard bounces as a mailer-daemon message that quotes
 * the failed recipient in the body, so match on both: the daemon alone would catch a bounce
 * for a different recipient entirely.
 */
export async function hasBounceFor(
  client: ImapFlow,
  address: string,
  since: Date
): Promise<boolean> {
  const lock = await client.getMailboxLock('INBOX', { readOnly: true });
  try {
    const hits = await client.search(
      {
        since,
        body: address,
        or: [{ from: 'mailer-daemon' }, { from: 'postmaster' }],
      },
      { uid: true }
    );
    return Array.isArray(hits) && hits.length > 0;
  } finally {
    lock.release();
  }
}

/** Gmail's Sent folder, found by its special-use flag so the name's locale does not matter. */
async function sentMailboxPath(client: ImapFlow): Promise<string> {
  const boxes = await client.list();
  return boxes.find((b) => b.specialUse === '\\Sent')?.path ?? '[Gmail]/Sent Mail';
}

/**
 * Recover the Message-ID of a message we already sent, by searching our own Sent Mail.
 *
 * This exists for one job: the emails that went out BEFORE sequences existed discarded their
 * Message-ID at send time, so their follow-ups would have nothing to thread onto. Reading it
 * back out of Sent Mail lets those threads be repaired instead of restarted.
 *
 * Windowed to the day either side of the recorded send because IMAP dates are day-granular
 * and the stored timestamp is UTC while the server may reckon the day differently.
 */
export async function findSentMessageId(
  client: ImapFlow,
  to: string,
  at: Date
): Promise<string | null> {
  const day = 24 * 60 * 60 * 1000;
  const lock = await client.getMailboxLock(await sentMailboxPath(client), { readOnly: true });
  try {
    const messages = await client.fetchAll(
      { to, since: new Date(+at - day), before: new Date(+at + day) },
      { envelope: true },
      { uid: true }
    );
    if (messages.length === 0) return null;
    // Several outreach emails can share a day. Take the one sent closest to the recorded
    // time rather than whichever the server happened to list first.
    const closest = messages.reduce((best, m) => {
      const d = (x: typeof m) => Math.abs(+(x.envelope?.date ?? new Date(0)) - +at);
      return d(m) < d(best) ? m : best;
    });
    return closest.envelope?.messageId ?? null;
  } finally {
    lock.release();
  }
}
