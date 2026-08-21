import { ImapFlow, type SearchObject } from 'imapflow';

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
 * ⚠️ ONE SIGNAL OF THREE, AND NOT THE ONE THE FOLLOW-UP PASS ASKS ANY MORE. `findReply` below
 * is what decides whether somebody answered; this stays exported because it is the primitive
 * the IMAP smoke test uses to prove a search works at all. Answering "did they reply" with
 * this alone is what mailed a reminder to a recruiter who had already written back — he
 * replied from his own address, not from the shared inbox the application went to.
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
 * Consumer mail hosts. On one of these, "somebody else at the same domain" means nothing at
 * all — it means another of the world's gmail users — so the colleague rule below must never
 * fire for them. Everything else is treated as an employer's own domain.
 */
const CONSUMER_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.co.in', 'ymail.com', 'rediffmail.com', 'proton.me', 'protonmail.com',
  'icloud.com', 'me.com', 'aol.com', 'zoho.com', 'zohomail.com', 'mail.com', 'gmx.com',
]);

/** Role inboxes a whole team reads, so a reply legitimately arrives from a person instead. */
const SHARED_INBOX_RE =
  /^(careers?|jobs?|hiring|recruit(ing|ment)?|hr|talent|internships?|apply|applications?|resume|cv|joinus|work(with|for)us|info|hello|contact|team|people|admin|office|reach|connect|support)@/i;

/**
 * The domain at which a colleague's reply counts as THIS sequence's reply, or null.
 *
 * ⚠️ THE BUG THIS ANSWERS, reported 2026-08-21 off a real thread. An application went to
 * `careers@rovia.one` — a Google Group — and Aayush Jain answered from `aayush.j@rovia.one`
 * with a two-question assignment and a deadline. The reply check searched for mail FROM
 * `careers@rovia.one`, found none, and seven hours later the pass sent "Just following up on
 * my note below, in case it got buried". **A SHARED INBOX NEVER REPLIES; A PERSON BEHIND IT
 * DOES.**
 *
 * Gated twice, because a domain match is a blunt instrument: only for an address that is
 * plainly a role inbox, and never on a consumer mail host, where the domain says nothing
 * about who is on the other end.
 */
export function colleagueDomainFor(address: string): string | null {
  const [local, domain] = address.toLowerCase().split('@');
  if (!local || !domain) return null;
  if (!SHARED_INBOX_RE.test(address)) return null;
  if (CONSUMER_MAIL_DOMAINS.has(domain)) return null;
  return domain;
}

function selfAddress(): string {
  return (process.env.GMAIL_USER ?? '').toLowerCase();
}

/** Newest hits only, and only a handful: this is a yes/no question, not an inbox reader. */
const MAX_HITS_EXAMINED = 5;

/**
 * The newest message matching this search that is not one of OUR OWN, and who sent it.
 *
 * ⚠️ THE SELF-CHECK IS LOAD-BEARING. A mailing list echoes our own message back into the
 * INBOX carrying the very References header the thread search looks for — the Rovia thread
 * arrived with a Google Groups footer, so this is not hypothetical. Without it, a send to a
 * group would read as an instant reply from ourselves and close the sequence on the next run.
 */
async function senderOfNewestForeignMatch(
  client: ImapFlow,
  query: SearchObject
): Promise<string | null> {
  const hits = await client.search(query, { uid: true });
  if (!Array.isArray(hits) || hits.length === 0) return null;
  const self = selfAddress();
  for (const uid of hits.slice(-MAX_HITS_EXAMINED).reverse()) {
    const msg = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
    const from = (msg && msg.envelope?.from?.[0]?.address?.toLowerCase()) || '';
    if (from && from !== self) return from;
  }
  return null;
}

export type ReplyProbe = {
  /** The one address this sequence writes to. */
  to: string;
  /**
   * Every Message-ID this sequence has sent, so a reply can be recognised by the thread it
   * hangs from rather than by who happened to send it.
   */
  messageIds: string[];
  /**
   * How far back to look. ⚠️ THE SEQUENCE'S FIRST SEND, NOT ITS LAST. A window that restarts
   * on every send makes a reply the pass failed to notice invisible for ever, so one missed
   * reply becomes three unwanted follow-ups instead of being corrected on the next run.
   */
  since: Date;
};

export type ReplyHit = {
  from: string;
  /** How it was recognised: the thread, the address we wrote to, or a colleague of it. */
  how: 'thread' | 'address' | 'colleague';
};

/**
 * Has anyone answered this sequence?
 *
 * Three signals, most precise first. Any one of them stops the sequence, because the two
 * possible errors are nothing like equal: a false "they replied" costs one unsent follow-up,
 * and a false "they did not" mails a reminder to somebody who has already written back.
 *
 *  1. THREAD. A reply carries one of our Message-IDs in `In-Reply-To` or `References`,
 *     whoever sends it and from whatever address. This is what "replied" actually means, and
 *     it is the signal the old check did not have.
 *  2. ADDRESS. Mail from the address we wrote to — the original check, kept.
 *  3. COLLEAGUE. Mail from the same company domain when we wrote to a role inbox. See
 *     `colleagueDomainFor` for the two gates on it.
 *
 * IMAP's SINCE is date-granular and ignores the time of day, so all three are slightly
 * over-inclusive: mail from earlier on the same day as the send also matches. That error runs
 * in the safe direction.
 */
export async function findReply(client: ImapFlow, probe: ReplyProbe): Promise<ReplyHit | null> {
  // readOnly opens the mailbox with EXAMINE rather than SELECT, so the server itself refuses
  // any state change. ONE lock for all three searches: this runs per sequence, and re-locking
  // per search would spend the pass's budget on round trips.
  const lock = await client.getMailboxLock('INBOX', { readOnly: true });
  try {
    const ids = probe.messageIds.filter(Boolean);
    if (ids.length > 0) {
      // Both headers, because they are different headers: a client that sets only In-Reply-To
      // is unusual, but a list that rewrites one and not the other is not. `or` wants two
      // branches minimum, which a single id already provides.
      const threaded = await senderOfNewestForeignMatch(client, {
        since: probe.since,
        or: ids.flatMap((id): SearchObject[] => [
          { header: { 'in-reply-to': id } },
          { header: { references: id } },
        ]),
      });
      if (threaded) return { from: threaded, how: 'thread' };
    }

    const direct = await senderOfNewestForeignMatch(client, {
      since: probe.since,
      from: probe.to,
    });
    if (direct) return { from: direct, how: 'address' };

    const domain = colleagueDomainFor(probe.to);
    if (domain) {
      // IMAP FROM is a substring match on the header, so "@rovia.one" matches any sender at
      // that domain.
      const colleague = await senderOfNewestForeignMatch(client, {
        since: probe.since,
        from: `@${domain}`,
      });
      if (colleague) return { from: colleague, how: 'colleague' };
    }

    return null;
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
