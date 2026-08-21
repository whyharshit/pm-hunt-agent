import { imapConfigured, withImap } from './imap';
import { unboundedClock, type InvocationClock } from './invocation-clock';
import {
  linkedInInviteId,
  parseLinkedInNotification,
  personKey,
  type LinkedInEventKind,
} from './linkedin-mail';
import { parseConnectionsCsv, type ConnectionRow } from './linkedin-csv';
import { companyLabel, posterName } from './postjob';
import {
  getLinkedInInvite,
  getRecentJobs,
  recordAgentRun,
  saveLinkedInInvite,
  setAgentRunning,
} from './storage';
import type { Job, LinkedInInvite } from './types';

/**
 * The LinkedIn tracker's one automatic input: LinkedIn's own notification mail.
 *
 * ⚠️ READ lib/linkedin-mail.ts FIRST. There is no API for invitations, the mailbox is the only
 * signal, and as of 2026-08-21 no LinkedIn mail reaches this account at all — so this pass is
 * built, pinned, and finds nothing until the notifications are forwarded here. It is written to
 * behave identically on the day they arrive: nothing to configure, nothing to migrate.
 *
 * The pass is IDEMPOTENT AND SELF-HEALING, which is why it can afford to be the lowest-priority
 * thing in the invocation. It re-reads a 30-day window every run rather than tracking "where I
 * left off", so a run that is skipped, killed or starved loses nothing — the next one sees the
 * same emails and reaches the same conclusion. Contrast the follow-up pass, where a missed
 * reply used to be missed for ever.
 */

/** How far back each run looks. Wider than any plausible gap between runs, on purpose. */
const WINDOW_DAYS = 30;

/**
 * Below this the pass declines. It is one IMAP session, one search and one batched envelope
 * fetch — cheap, but not free, and half a session is worse than none.
 */
const MIN_SCAN_MS = 10_000;

/** Envelopes read per run. A month of LinkedIn mail is well inside this. */
const MAX_MESSAGES = 300;

/**
 * ⚠️ ALL MAIL, NOT INBOX, and it is not a detail.
 *
 * These notifications arrive by a Gmail FILTER forwarding them from another account
 * (shvnsharya@gmail.com, set up 2026-08-21). A filter at either end can archive, label or
 * skip-inbox the message, and a forward that skips the inbox is invisible to an INBOX search —
 * the tracker would report "no LinkedIn mail" while the mail sat in All Mail the whole time.
 * All Mail is every message the account holds bar Spam and Trash, so it cannot be dodged by
 * labelling. Our own Sent copies live there too and are excluded by the sender gate, which
 * requires a real linkedin.com From.
 */
const SCAN_MAILBOX = '[Gmail]/All Mail';

/**
 * Spam is COUNTED, never parsed.
 *
 * Gmail spam-files forwarded mail more readily than mail sent to the account directly, and a
 * spam-filed acceptance is exactly as invisible as one that never arrived. But From headers are
 * forgeable and Spam is where forged mail lands, so a row is never created from it — the count
 * goes in the summary ("3 in Spam — mark them Not spam") and a human decides.
 */
const SPAM_MAILBOX = '[Gmail]/Spam';

export type LinkedInScanResult = {
  /** Messages from LinkedIn examined. */
  scanned: number;
  /** Acceptance notifications recognised, including ones already recorded. */
  accepted: number;
  /** People who were NOT already marked accepted before this run. */
  newlyAccepted: string[];
  /** Invitations somebody sent US. Counted, not recorded: a different event entirely. */
  invitesReceived: number;
  /** Acceptances tied to a discovered job row by name. */
  linkedToJobs: number;
  /**
   * LinkedIn mail sitting in Spam, counted and deliberately not parsed. Non-zero means the
   * forward is working and Gmail is filing it where nothing will look.
   */
  inSpam: number;
  windowDays: number;
  dryRun: boolean;
  /** Set when IMAP is not configured or the mailbox could not be read. */
  imapError: string | null;
  /** The shared invocation clock was spent before this pass began. */
  outOfTime?: boolean;
};

function emptyResult(dryRun: boolean): LinkedInScanResult {
  return {
    scanned: 0,
    accepted: 0,
    newlyAccepted: [],
    invitesReceived: 0,
    linkedToJobs: 0,
    inSpam: 0,
    windowDays: WINDOW_DAYS,
    dryRun,
    imapError: null,
  };
}

/**
 * Index the recent job rows by the name of whoever POSTED them.
 *
 * ⚠️ THE POSTER, NOT THE COMPANY. A LinkedIn acceptance names a person, and the person on a job
 * row lives in the `poster:` tag and only there — copying it into `Job.company` is the bug that
 * mailed a recruiter an application about "roles at Fathima Sajid" (see lib/postjob.ts).
 */
function postersByName(jobs: Job[]): Map<string, Job> {
  const byName = new Map<string, Job>();
  for (const job of jobs) {
    const poster = posterName(job.tags);
    if (!poster) continue;
    const key = personKey(poster);
    // First wins: `getRecentJobs` is newest-first, and the newest post from a person is the one
    // a connection made this week is most likely to be about.
    if (key && !byName.has(key)) byName.set(key, job);
  }
  return byName;
}

/** Merge what a notification says into whatever the row already holds. */
function mergeAcceptance(
  existing: LinkedInInvite | null,
  args: { name: string; at: string; messageId?: string; job?: Job }
): { invite: LinkedInInvite; isNew: boolean } {
  const now = new Date().toISOString();
  const id = linkedInInviteId(args.name);
  const base: LinkedInInvite =
    existing ??
    ({
      id,
      name: args.name,
      createdAt: now,
      updatedAt: now,
    } as LinkedInInvite);

  // ⚠️ THE EARLIEST ACCEPTANCE WINS. A person can be invited again months later, and a second
  // notification must not overwrite the date the connection actually started — that date is
  // what "accepted 4 days after the invite" is measured from.
  const acceptedAt = existing?.acceptedAt
    ? existing.acceptedAt < args.at
      ? existing.acceptedAt
      : args.at
    : args.at;

  const invite: LinkedInInvite = {
    ...base,
    // A hand-typed name is kept: the user's spelling of somebody's name beats a subject line's.
    name: existing?.name?.trim() ? existing.name : args.name,
    acceptedAt,
    acceptedVia: existing?.acceptedVia === 'manual' ? 'manual' : 'email',
    messageId: args.messageId ?? existing?.messageId,
    ...(args.job
      ? { jobId: args.job.id, jobLabel: `${args.job.title} · ${companyLabel(args.job)}` }
      : {}),
    updatedAt: now,
  };
  return { invite, isNew: !existing?.acceptedAt };
}

/**
 * Read the mailbox, record every acceptance, tie each one to a job row when the names match.
 *
 * `dryRun` reads and parses but writes nothing, so the shape of a real inbox can be inspected
 * before anything is stored.
 */
export async function runLinkedInScan(
  opts: { dryRun?: boolean; clock?: InvocationClock } = {}
): Promise<LinkedInScanResult> {
  const dryRun = opts.dryRun ?? false;
  const clock = opts.clock ?? unboundedClock;
  const result = emptyResult(dryRun);

  if (!clock.canAfford(MIN_SCAN_MS)) {
    result.outOfTime = true;
    return result;
  }

  if (!imapConfigured()) {
    result.imapError =
      'IMAP not configured (GMAIL_USER + GMAIL_APP_PASSWORD) — LinkedIn acceptances can only be read from the mailbox';
    return result;
  }

  const since = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);

  try {
    // Inside the try, so a storage failure is reported as this pass failing rather than
    // thrown at whoever called it — the route's other passes still have work to do.
    if (!dryRun) await setAgentRunning('linkedin');
    const jobs = dryRun ? [] : await getRecentJobs(200);
    const posters = postersByName(jobs);
    const counts: Record<LinkedInEventKind, number> = {
      accepted: 0,
      'invite-received': 0,
      other: 0,
    };

    await withImap(async (client) => {
      // Counted first and separately, so the answer survives whatever the main pass finds.
      // A missing Spam folder is not an error worth failing the pass over.
      try {
        const spamLock = await client.getMailboxLock(SPAM_MAILBOX, { readOnly: true });
        try {
          const spam = await client.search({ from: 'linkedin.com', since }, { uid: true });
          result.inSpam = Array.isArray(spam) ? spam.length : 0;
        } finally {
          spamLock.release();
        }
      } catch {
        result.inSpam = 0;
      }

      const lock = await client.getMailboxLock(SCAN_MAILBOX, { readOnly: true });
      try {
        // Sender-scoped: `from` is a substring match on the header, and every LinkedIn domain
        // ends in linkedin.com. A Gmail filter's forward preserves the original From, so this
        // holds for notifications forwarded in from another account.
        const hits = await client.search({ from: 'linkedin.com', since }, { uid: true });
        const uids = (Array.isArray(hits) ? hits : []).slice(-MAX_MESSAGES);
        if (uids.length === 0) return;

        // One round trip for the whole window rather than one per message.
        const messages = await client.fetchAll(uids.join(','), { envelope: true }, { uid: true });
        result.scanned = messages.length;

        for (const msg of messages) {
          const from = msg.envelope?.from?.[0]?.address ?? '';
          const subject = msg.envelope?.subject ?? '';
          const event = parseLinkedInNotification({ from, subject });
          counts[event.kind] += 1;
          if (event.kind !== 'accepted' || !event.name) continue;

          result.accepted += 1;
          if (dryRun) {
            result.newlyAccepted.push(event.name);
            continue;
          }

          const at = (msg.envelope?.date ?? new Date()).toISOString();
          const existing = await getLinkedInInvite(linkedInInviteId(event.name));
          const job = posters.get(personKey(event.name));
          const { invite, isNew } = mergeAcceptance(existing, {
            name: event.name,
            at,
            messageId: msg.envelope?.messageId,
            job,
          });
          await saveLinkedInInvite(invite);
          if (isNew) result.newlyAccepted.push(invite.name);
          if (job) result.linkedToJobs += 1;
        }
      } finally {
        lock.release();
      }
    });

    result.invitesReceived = counts['invite-received'];

    if (!dryRun) {
      await recordAgentRun('linkedin', {
        state: 'ok',
        summary:
          result.scanned === 0
            ? result.inSpam > 0
              ? `0 LinkedIn mails in All Mail but ${result.inSpam} in SPAM — the forward works, Gmail is filing it as junk. Mark them "Not spam" and they will be read next run.`
              : `no LinkedIn mail in the last ${WINDOW_DAYS} days — the forward has not delivered anything yet`
            : `${result.scanned} LinkedIn mails · ${result.accepted} acceptances (${result.newlyAccepted.length} new) · ${result.linkedToJobs} tied to a job row` +
              (result.inSpam > 0 ? ` · ⚠ ${result.inSpam} more in Spam, not read` : ''),
        stats: {
          scanned: result.scanned,
          accepted: result.accepted,
          newlyAccepted: result.newlyAccepted.length,
          invitesReceived: result.invitesReceived,
          inSpam: result.inSpam,
        },
        error: null,
      });
    }
    return result;
  } catch (e) {
    result.imapError = (e as Error).message;
    if (!dryRun) {
      await recordAgentRun('linkedin', { state: 'error', error: result.imapError });
    }
    return result;
  }
}

/**
 * Import LinkedIn's own connections export.
 *
 * ⚠️ THIS IS THE INPUT THAT ACTUALLY WORKS. Two real acceptances on 2026-08-21/22 produced no
 * email at all — only phone notifications — so the mail parser, correct as it is, has nothing
 * to read. The CSV is the user's own data, offered by LinkedIn for download, and it carries the
 * one fact the tracker needs: a per-person date the connection was made.
 *
 * ⚠️ ONLY A RECENT WINDOW IS IMPORTED, and that is a feature. A connections file holds every
 * contact the account has ever made; importing all of it would bury the handful of invitations
 * this project is actually tracking under years of college friends, and write a Redis row for
 * each. A row is kept when it is inside the window, OR when it is already tracked here, OR when
 * the person posted a job this project has seen — the three ways a connection is relevant.
 * `windowDays: 0` means import everything, for whoever wants the whole address book.
 */
export type ImportResult = {
  /** Rows the file yielded. */
  parsed: number;
  /** Newly recorded as connected. */
  added: string[];
  /** Already known, refreshed with the export's date or details. */
  updated: number;
  /** Outside the window and matching nothing tracked. */
  skippedOld: number;
  /** Lines the parser could not use, with reasons. */
  unusable: Array<{ line: string; why: string }>;
  linkedToJobs: number;
  error?: string;
};

export async function importConnections(
  csv: string,
  opts: { windowDays?: number } = {}
): Promise<ImportResult> {
  const windowDays = opts.windowDays ?? 90;
  const parsedFile = parseConnectionsCsv(csv);
  const result: ImportResult = {
    parsed: parsedFile.rows.length,
    added: [],
    updated: 0,
    skippedOld: 0,
    unusable: parsedFile.skipped.slice(0, 10),
    linkedToJobs: 0,
    ...(parsedFile.error ? { error: parsedFile.error } : {}),
  };
  if (parsedFile.error || parsedFile.rows.length === 0) return result;

  const jobs = await getRecentJobs(200);
  const posters = postersByName(jobs);
  const cutoff = windowDays > 0 ? Date.now() - windowDays * 24 * 60 * 60 * 1000 : -Infinity;

  for (const row of parsedFile.rows) {
    const id = linkedInInviteId(row.name);
    const existing = await getLinkedInInvite(id);
    const job = posters.get(personKey(row.name));
    const relevant = +new Date(row.connectedOn) >= cutoff || Boolean(existing) || Boolean(job);
    if (!relevant) {
      result.skippedOld += 1;
      continue;
    }

    const now = new Date().toISOString();
    const wasAccepted = Boolean(existing?.acceptedAt);
    const invite: LinkedInInvite = {
      ...(existing ?? { id, createdAt: now }),
      id,
      name: existing?.name?.trim() ? existing.name : row.name,
      // The export's own profile URL is better than anything typed by hand.
      ...(row.profileUrl ? { profileUrl: row.profileUrl } : {}),
      ...(!existing?.note && (row.position || row.company)
        ? { note: [row.position, row.company].filter(Boolean).join(' · ') }
        : {}),
      // ⚠️ THE EXPORT'S DATE WINS OVER A HAND-MARKED ONE. "Mark accepted" stamps the moment
      // somebody pressed the button, which is whenever they noticed; the export states the day
      // it happened. It does NOT win over an earlier date from another source.
      acceptedAt:
        existing?.acceptedAt && existing.acceptedAt < row.connectedOn
          ? existing.acceptedAt
          : row.connectedOn,
      acceptedVia: existing?.acceptedVia === 'email' ? 'email' : 'export',
      ...(job && !existing?.jobId
        ? { jobId: job.id, jobLabel: `${job.title} · ${companyLabel(job)}` }
        : {}),
      updatedAt: now,
    };
    await saveLinkedInInvite(invite);
    if (wasAccepted) result.updated += 1;
    else result.added.push(invite.name);
    if (job) result.linkedToJobs += 1;
  }

  return result;
}

/** Exported for the check script: the shape a parsed file takes before storage sees it. */
export type { ConnectionRow };

/** Record an invitation the user says they sent. The only way a PENDING invite can be known. */
export async function logInvite(args: {
  name: string;
  profileUrl?: string;
  note?: string;
  invitedAt?: string;
}): Promise<LinkedInInvite> {
  const now = new Date().toISOString();
  const id = linkedInInviteId(args.name);
  const existing = await getLinkedInInvite(id);
  const jobs = await getRecentJobs(200);
  const job = postersByName(jobs).get(personKey(args.name));

  const invite: LinkedInInvite = {
    ...(existing ?? { id, createdAt: now }),
    id,
    name: args.name.trim(),
    ...(args.profileUrl ? { profileUrl: args.profileUrl.trim() } : {}),
    ...(args.note ? { note: args.note.trim() } : {}),
    // Kept if it was already there: re-logging is usually a correction to the name or the
    // note, not a claim that the invitation went out again today.
    invitedAt: existing?.invitedAt ?? args.invitedAt ?? now,
    ...(job && !existing?.jobId
      ? { jobId: job.id, jobLabel: `${job.title} · ${companyLabel(job)}` }
      : {}),
    updatedAt: now,
  };
  await saveLinkedInInvite(invite);
  return invite;
}

/**
 * Mark an invitation accepted by hand.
 *
 * ⚠️ NEEDED EVEN ONCE THE MAIL WORKS. LinkedIn's phrasings change and this parser only knows
 * the ones it has been taught (see ACCEPTED_PATTERNS); an unrecognised subject reads as
 * `other`, which loses a connection rather than inventing one. A human who can see the
 * acceptance on LinkedIn must always be able to say so.
 */
export async function markAccepted(id: string, at?: string): Promise<LinkedInInvite | null> {
  const existing = await getLinkedInInvite(id);
  if (!existing) return null;
  const now = new Date().toISOString();
  const invite: LinkedInInvite = {
    ...existing,
    acceptedAt: existing.acceptedAt ?? at ?? now,
    acceptedVia: existing.acceptedVia ?? 'manual',
    updatedAt: now,
  };
  await saveLinkedInInvite(invite);
  return invite;
}
