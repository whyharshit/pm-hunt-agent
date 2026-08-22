import { deleteLinkedInRow, markLinkedInAccepted } from '@/lib/actions';
import { fmtDate, fmtStamp } from '@/lib/format';
import { getAgentRun, getJob, getLinkedInInvites, getOutreachSequences } from '@/lib/storage';
import { runDisplayState } from '@/lib/agents';
import { mailTimeline } from '@/lib/mail-timeline';
import { posterName } from '@/lib/postjob';
import { DeleteButton } from '../delete-button';
import {
  ImportConnectionsForm,
  LogInviteForm,
  MarkAcceptedButton,
  ScanLinkedInButton,
} from '../linkedin-form';
import { Nav } from '../nav';
import type { AgentRun, Job, LinkedInInvite, OutreachSequence } from '@/lib/types';

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
 * HOW ACCEPTANCE IS KNOWN, because it is the first question anyone asks and the first two
 * answers turned out to be wrong.
 *
 * There is no LinkedIn API for invitations — Connections and Invitations are closed to third
 * parties at every tier — so the plan was to read the "X accepted your invitation" email
 * (lib/linkedin-mail.ts). ⚠️ **THAT EMAIL COMES FOR SOME ACCEPTANCES AND NOT OTHERS.** Measured
 * on three real ones, 20–22 Aug 2026: two friends accepted and produced no mail anywhere, only
 * phone notifications; a third ("Kajol accepted your invitation, explore their network") did
 * arrive. Whatever decides that is not visible from here.
 *
 * A tracker on a partial signal under-reports, and under-reporting reads as "nobody accepted".
 * So the COMPLETE input is LinkedIn's own export: Settings → Data privacy → Get a copy of your
 * data → Connections, a CSV of every connection WITH THE DATE IT WAS MADE (lib/linkedin-csv.ts)
 * — the user's own data, no scraping, no cookie. The mail scan stays because it is real-time
 * and free; between them, the mail catches some the same day and the export catches everything.
 *
 * Hand-logging remains first-class: the export is direction-blind (it cannot say who invited
 * whom) and it says nothing about an invitation still pending, which only the person who
 * clicked Connect knows.
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
  job,
}: {
  invite: LinkedInInvite;
  /** The email thread with the same person, when this row is tied to a job they posted. */
  sequence?: OutreachSequence;
  /** The job row this person is matched to, read fresh so a wrong match can be inspected. */
  job?: Job;
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
                : invite.acceptedVia === 'export'
                  ? "from LinkedIn's own connections export — the date is the day it happened"
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

      {/* The payoff of matching by name: the connection and the application in one place.
          ⚠️ AND THE EVIDENCE FOR THE MATCH, because the match is a GUESS. It is made on a
          normalised name, and a notification often gives only a first name — "Kajol" matched a
          Euronet post by someone called Kajol, which may or may not be the same human. So the
          poster's name as the post recorded it, and a link to the post itself, sit right here:
          the claim and the way to check it in one line. */}
      {invite.jobLabel && (
        <p className="mt-2 rounded border border-zinc-200 bg-zinc-50 px-2 py-1.5 text-xs text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
          They posted <span className="font-medium">{invite.jobLabel}</span>
          {/* ⚠️ Each way the link can be missing SAYS SO. This box is the evidence for a match
              made on a name, and the first time the link silently failed to render, the cause
              (row gone? URL never captured?) was undiagnosable from a browser — which is the
              only place this page can be seen, since prod Redis is unreachable from a shell. */}
          {job ? (
            <>
              {' · posted by '}
              <span className="font-medium">{posterName(job.tags) || 'nobody named'}</span>
              {job.url ? (
                <>
                  {' · '}
                  <a
                    href={job.url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-indigo-600 underline hover:no-underline dark:text-indigo-400"
                  >
                    open the post to check it is them
                  </a>
                </>
              ) : (
                ' · the post’s URL was never captured, so there is nothing to open — check the poster name against their profile instead'
              )}
            </>
          ) : (
            ' · ⚠️ the job row is no longer stored (the label above is a copy kept at match time), so the post cannot be opened'
          )}
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
  let jobs = new Map<string, Job>();
  let error: string | null = null;
  try {
    [invites, run] = await Promise.all([getLinkedInInvites(300), getAgentRun('linkedin')]);
    const jobIds = [
      ...new Set(invites.map((i) => i.jobId).filter((id): id is string => Boolean(id))),
    ];
    if (jobIds.length > 0) {
      // Read fresh rather than trusting the label captured at link time: the point of showing
      // this is letting a human audit the match, and an audit against a stale copy is theatre.
      const [seqs, rows] = await Promise.all([
        getOutreachSequences(jobIds),
        Promise.all(jobIds.map((id) => getJob(id))),
      ]);
      sequences = seqs;
      jobs = new Map(rows.filter((j): j is Job => Boolean(j)).map((j) => [j.id, j]));
    }
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
            Who was invited, and who accepted. LinkedIn has no API for invitations, and it
            emails only some acceptances — of three in the last few days, one arrived by mail and
            two came through as phone notifications only. So the mail scan runs for what it
            catches, the export below fills in the rest, and a pending invitation exists here
            only because you logged it.
          </p>
        </header>

        {error && (
          <p className="mb-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        <ImportConnectionsForm />

        <LogInviteForm />

        {/* The scan's own report, read off its agent record rather than re-derived here — it is
            the same sentence the dashboard card shows, and it survives a reload. */}
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
          <ScanLinkedInButton />
          <span className="text-xs text-zinc-500 dark:text-zinc-400">
            {run?.summary
              ? `${run.summary}${run.finishedAt ? ` · ${fmtDate(run.finishedAt)}` : ''}`
              : 'Never scanned. LinkedIn is not emailing acceptances to this account — the import above is the reliable route. This stays wired in case those emails are ever switched on.'}
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
                job={invite.jobId ? jobs.get(invite.jobId) : undefined}
              />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
