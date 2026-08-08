import { getRecentJobs } from '@/lib/storage';
import { deleteJobRow } from '@/lib/actions';
import { fmtDate } from '@/lib/format';
import { DeleteButton } from '../delete-button';
import { Nav } from '../nav';
import type { Job } from '@/lib/types';

export const dynamic = 'force-dynamic';

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
  let error: string | null = null;
  try {
    jobs = await getRecentJobs(300);
  } catch (e) {
    error = (e as Error).message;
  }

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
        <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
          Matched by the daily Discover cron across 13 sources.
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
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
