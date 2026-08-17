import { getJobContacts, getJobOutreaches, getRecentJobs } from '@/lib/storage';
import { deleteJobRow } from '@/lib/actions';
import { fmtDate } from '@/lib/format';
import { isGenericEmail } from '@/lib/contact';
import { DeleteButton } from '../delete-button';
import { Nav } from '../nav';
import type { Job, JobContact, JobOutreach } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * The outreach state of one row, in one line.
 *
 * Provenance is printed, not just the address. Before this project mails a stranger a human
 * must be able to see WHERE the address came from — "the job post itself" and
 * "hunter.io (89% confidence)" carry very different weight, and the funding pipeline learned
 * that the expensive way when five drafts greeting founders by name were queued to shared
 * inboxes.
 */
function OutreachLine({ contact, draft }: { contact?: JobContact; draft?: JobOutreach }) {
  if (draft?.sentAt) {
    return (
      <p className="mt-1 text-xs text-emerald-700 dark:text-emerald-400">
        ✓ applied {fmtDate(draft.sentAt)} · {draft.sentTo}
      </p>
    );
  }

  const person = contact?.emails.find((e) => e.person && !isGenericEmail(e.address));
  if (person) {
    return (
      <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
        ✉ {person.person} · {person.address}{' '}
        <span className="text-zinc-400 dark:text-zinc-500">({person.foundOn})</span>
        {draft ? '' : ' · no draft yet'}
      </p>
    );
  }

  const shared = contact?.emails[0];
  if (shared) {
    return (
      <p className="mt-1 text-xs text-amber-700 dark:text-amber-500">
        ⚠ only {shared.address} — a shared inbox, so the agent will not send a named greeting to
        it. Yours to send by hand.
      </p>
    );
  }

  if (contact?.note) {
    return <p className="mt-1 text-xs text-zinc-400 dark:text-zinc-500">{contact.note}</p>;
  }
  return null;
}

/**
 * Discovered jobs, on their own route. Also answers "why is everything Internshala?" —
 * the per-source counts are rendered, so a source that has quietly stopped contributing is
 * visible instead of being buried in a 150-row list.
 */
export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string }>;
}) {
  const { source } = await searchParams;

  let jobs: Job[] = [];
  let contacts = new Map<string, JobContact>();
  let drafts = new Map<string, JobOutreach>();
  let error: string | null = null;
  try {
    jobs = await getRecentJobs(300);
    const ids = jobs.map((j) => j.id);
    [contacts, drafts] = await Promise.all([getJobContacts(ids), getJobOutreaches(ids)]);
  } catch (e) {
    error = (e as Error).message;
  }

  // What the unattended sender can and cannot act on, counted where it is visible. "0 sent"
  // and "0 sent, 14 rows one decision away" are very different states of the world, and the
  // difference used to be invisible without reading a dry run's JSON.
  const sent = jobs.filter((j) => drafts.get(j.id)?.sentAt).length;
  const reachable = jobs.filter((j) =>
    contacts.get(j.id)?.emails.some((e) => e.person && !isGenericEmail(e.address))
  ).length;
  const sharedOnly = jobs.filter((j) => {
    const emails = contacts.get(j.id)?.emails ?? [];
    return emails.length > 0 && emails.every((e) => isGenericEmail(e.address));
  }).length;

  const bySource = new Map<string, number>();
  for (const j of jobs) bySource.set(j.source, (bySource.get(j.source) ?? 0) + 1);
  const sources = [...bySource.entries()].sort((a, b) => b[1] - a[1]);

  const shown = source ? jobs.filter((j) => j.source === source) : jobs;

  return (
    <div className="min-h-screen bg-zinc-50 px-4 py-8 dark:bg-zinc-950 sm:px-8">
      <main className="mx-auto max-w-4xl">
        <Nav current="jobs" />

        <h1 className="mb-1 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Discovered Jobs · {jobs.length}
        </h1>
        <p className="mb-1 text-xs text-zinc-500 dark:text-zinc-400">
          Matched by the daily Discover cron. Remote anywhere, plus on-site product roles in India.
        </p>
        <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
          <span className="font-medium text-zinc-700 dark:text-zinc-300">{sent} applied</span> ·{' '}
          {reachable} reachable by name · {sharedOnly} shared inbox only (a person has to send those)
        </p>

        {error && (
          <p className="mb-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        {sources.length > 0 && (
          <div className="mb-4 flex flex-wrap gap-1.5">
            <a
              href="/jobs"
              className={
                source
                  ? 'rounded border border-zinc-300 bg-white px-2 py-1 text-[11px] text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
                  : 'rounded border border-zinc-900 bg-zinc-900 px-2 py-1 text-[11px] font-semibold text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
              }
            >
              all {jobs.length}
            </a>
            {sources.map(([s, n]) => (
              <a
                key={s}
                href={`/jobs?source=${encodeURIComponent(s)}`}
                className={
                  source === s
                    ? 'rounded border border-zinc-900 bg-zinc-900 px-2 py-1 text-[11px] font-semibold text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
                    : 'rounded border border-zinc-300 bg-white px-2 py-1 text-[11px] text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
                }
              >
                {s} {n}
              </a>
            ))}
          </div>
        )}

        {shown.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No jobs here yet. The daily cron populates this once a match clears the filters.
          </p>
        ) : (
          <ul className="divide-y divide-zinc-200 rounded-lg border border-zinc-200 bg-white dark:divide-zinc-800 dark:border-zinc-800 dark:bg-zinc-950">
            {shown.map((j) => (
              <li key={j.id} className="px-4 py-3">
                <a
                  href={j.url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="block text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                >
                  {j.title}
                </a>
                <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400">
                  <span>
                    {j.company} · {j.location || 'remote'} · <span className="italic">{j.source}</span>
                    {j.salary ? ` · ${j.salary}` : ''} · {fmtDate(j.postedAt)}
                  </span>
                  <DeleteButton id={j.id} action={deleteJobRow} what={`“${j.title}”`} />
                </div>
                <OutreachLine contact={contacts.get(j.id)} draft={drafts.get(j.id)} />
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
