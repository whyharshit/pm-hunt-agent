import { deleteLinkedInRow, markLinkedInAccepted } from '@/lib/actions';
import { fmtDate, fmtStamp } from '@/lib/format';
import { getAgentRun, getLinkedInInvites, getOutreachSequences } from '@/lib/storage';
import { runDisplayState } from '@/lib/agents';
import { mailTimeline } from '@/lib/mail-timeline';
import { DeleteButton } from '../delete-button';
import { LogInviteForm, MarkAcceptedButton, ScanLinkedInButton } from '../linkedin-form';
import { Nav } from '../nav';
import type { AgentRun, LinkedInInvite, OutreachSequence } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * ⚠️ REQUIRED. The "Scan LinkedIn mail now" action runs on this route and opens an IMAP session
 * plus a month of envelope reads. Without this export it inherits Vercel's default timeout,
 * which is shorter, and gets killed part-way through — which looks exactly like "there was no
 * LinkedIn mail", the wrong diagnosis. Same reason /jobs carries one.
 */
export const maxDuration = 60;

/**
 * The LinkedIn tracker.
 *
 * HOW ACCEPTANCE IS KNOWN AT ALL, because it is the first question anyone asks. There is no
 * LinkedIn API for invitations — the Connections and Invitations endpoints are closed to third
 * parties at every tier — and a pending invitation appears nowhere but LinkedIn's own Sent page.
 * The one machine-readable signal is the email LinkedIn sends the account owner when somebody
 * accepts, so this reads that over the IMAP session the follow-up pass already uses, with an
 * allowlist of acceptance phrasings (lib/linkedin-mail.ts).
 *
 * ⚠️ AND IT IS NOT ARRIVING YET. Measured 2026-08-21: 120 days of INBOX and All Mail hold ZERO
 * messages from linkedin.com, so LinkedIn is notifying a different address. Until those are
 * forwarded here the automatic half finds nothing and the page runs on hand-logged rows — which
 * is why logging and "mark accepted" are first-class controls and not a fallback.
 *
 * The third option, scraping with a session cookie, is deliberately not built: it breaks the
 * moment LinkedIn rotates the cookie and it is against their terms.
 */

function daysBetween(from: string, to: string): number | null {
  const a = +new Date(from);
  const b = +new Date(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

function InviteCard({
  invite,
  sequence,
}: {
  invite: LinkedInInvite;
  /** The email thread with the same person, when this row is tied to a job they posted. */
  sequence?: OutreachSequence;
}) {
  const accepted = Boolean(invite.acceptedAt);
  const waited =
    invite.invitedAt && invite.acceptedAt ? daysBetween(invite.invitedAt, invite.acceptedAt) : null;

  return (
    <li
      className={`rounded-lg border p-4 ${
        accepted
          ? 'border-emerald-300 bg-emerald-50/40 dark:border-emerald-800 dark:bg-emerald-950/20'
          : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950'
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">{invite.name}</span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${
            accepted
              ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200'
              : 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200'
          }`}
        >
          {accepted ? 'connected' : 'invited, waiting'}
        </span>
        {accepted && (
          <span
            className="text-[10px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500"
            title={
              invite.acceptedVia === 'email'
                ? 'read from a LinkedIn notification email'
                : 'marked by hand'
            }
          >
            via {invite.acceptedVia ?? 'manual'}
          </span>
        )}
        {invite.profileUrl && (
          <a
            href={invite.profileUrl}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-indigo-600 underline hover:no-underline dark:text-indigo-400"
          >
            profile
          </a>
        )}
      </div>

      {invite.note && (
        <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">{invite.note}</p>
      )}

      <ol className="mt-2 space-y-1 text-xs">
        {invite.invitedAt && (
          <li className="flex flex-wrap items-baseline gap-x-2 text-zinc-700 dark:text-zinc-300">
            <span className="w-4 shrink-0 text-center">→</span>
            <span className="tabular-nums text-zinc-400 dark:text-zinc-500">
              {fmtStamp(invite.invitedAt)}
            </span>
            <span>invitation sent</span>
          </li>
        )}
        {invite.acceptedAt ? (
          <li className="flex flex-wrap items-baseline gap-x-2 font-semibold text-emerald-700 dark:text-emerald-400">
            <span className="w-4 shrink-0 text-center">🤝</span>
            <span className="tabular-nums font-normal text-zinc-400 dark:text-zinc-500">
              {fmtStamp(invite.acceptedAt)}
            </span>
            <span>
              accepted
              {waited !== null ? ` · ${waited === 0 ? 'same day' : `after ${waited}d`}` : ''}
            </span>
          </li>
        ) : (
          <li className="flex flex-wrap items-baseline gap-x-2 text-zinc-400 dark:text-zinc-500">
            <span className="w-4 shrink-0 text-center">·</span>
            <span>
              no acceptance seen
              {invite.invitedAt ? ` · ${fmtDate(invite.invitedAt)}` : ''}
            </span>
          </li>
        )}
      </ol>

      {/* The payoff of matching by name: the connection and the application in one place. */}
      {invite.jobLabel && (
        <p className="mt-2 rounded border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          They posted <span className="font-medium">{invite.jobLabel}</span>
          {sequence
            ? (() => {
                const events = mailTimeline(sequence).filter((e) => e.kind !== 'due');
                const last = events.at(-1);
                return last ? ` · email: ${last.label} ${fmtDate(last.at)}` : '';
              })()
            : ' · no email thread with them'}
        </p>
      )}

      <div className="mt-2 flex flex-wrap items-center gap-2">
        {!accepted && <MarkAcceptedButton id={invite.id} action={markLinkedInAccepted} />}
        <DeleteButton id={invite.id} action={deleteLinkedInRow} what={`the row for ${invite.name}`} />
      </div>
    </li>
  );
}

export default async function LinkedInPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const { state } = await searchParams;

  let invites: LinkedInInvite[] = [];
  let run: AgentRun | null = null;
  let sequences = new Map<string, OutreachSequence>();
  let error: string | null = null;
  try {
    [invites, run] = await Promise.all([getLinkedInInvites(300), getAgentRun('linkedin')]);
    const jobIds = invites.map((i) => i.jobId).filter((id): id is string => Boolean(id));
    if (jobIds.length > 0) sequences = await getOutreachSequences(jobIds);
  } catch (e) {
    error = (e as Error).message;
  }

  const counts = {
    all: invites.length,
    accepted: invites.filter((i) => i.acceptedAt).length,
    waiting: invites.filter((i) => !i.acceptedAt).length,
    linked: invites.filter((i) => i.jobId).length,
  };

  const shown =
    state === 'accepted'
      ? invites.filter((i) => i.acceptedAt)
      : state === 'waiting'
        ? invites.filter((i) => !i.acceptedAt)
        : state === 'linked'
          ? invites.filter((i) => i.jobId)
          : invites;

  const tab = (key: string, label: string, n: number) => (
    <a
      key={key}
      href={`/linkedin?state=${key}`}
      className={
        (state ?? 'all') === key
          ? 'rounded border border-zinc-900 bg-zinc-900 px-2 py-1 text-[11px] font-semibold text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
          : 'rounded border border-zinc-300 bg-white px-2 py-1 text-[11px] text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
      }
    >
      {label} {n}
    </a>
  );

  const scanState = runDisplayState(run ?? undefined);

  return (
    <div className="min-h-screen bg-zinc-50 px-4 py-8 dark:bg-zinc-950 sm:px-8">
      <main className="mx-auto max-w-4xl">
        <Nav current="linkedin" />

        <header className="mb-4">
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">LinkedIn</h1>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Who was invited, and who accepted. LinkedIn has no API for invitations, so an
            acceptance is read from the notification email it sends you; a pending invitation
            exists here only because you logged it.
          </p>
        </header>

        {error && (
          <p className="mb-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        <LogInviteForm />

        {/* The scan's own report, read off its agent record rather than re-derived here — it is
            the same sentence the dashboard card shows, and it survives a reload. */}
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
          <ScanLinkedInButton />
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {run?.summary
              ? `${run.summary}${run.finishedAt ? ` · ${fmtDate(run.finishedAt)}` : ''}`
              : 'Never scanned. LinkedIn mail is not reaching this mailbox yet — forward it here and this starts filling itself in.'}
          </span>
          {scanState === 'error' && run?.error && (
            <span className="text-xs text-red-600 dark:text-red-400">⚠ {run.error}</span>
          )}
        </div>

        <div className="mb-4 flex flex-wrap gap-1.5">
          {tab('accepted', 'connected', counts.accepted)}
          {tab('waiting', 'invited, waiting', counts.waiting)}
          {tab('linked', 'posted a job we saw', counts.linked)}
          {tab('all', 'all', counts.all)}
        </div>

        {shown.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
            {error
              ? 'Storage could not be read, so nothing can be shown.'
              : counts.all === 0
                ? 'Nothing tracked yet. Log an invitation above, or scan the mailbox once LinkedIn notifications reach it.'
                : 'Nothing in this state.'}
          </p>
        ) : (
          <ul className="space-y-3">
            {shown.map((invite) => (
              <InviteCard
                key={invite.id}
                invite={invite}
                sequence={invite.jobId ? sequences.get(invite.jobId) : undefined}
              />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
