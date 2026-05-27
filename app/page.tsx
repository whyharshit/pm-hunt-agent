import { getRecentJobs, getRecentTracked } from '@/lib/storage';
import { TIER_EMOJI } from '@/lib/classify';
import { setTrackedStatus } from '@/lib/actions';
import type { TrackedUrl } from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

const STATUSES: TrackedUrl['status'][] = ['new', 'drafted', 'submitted', 'rejected', 'skipped'];

const STATUS_CLASS: Record<TrackedUrl['status'], string> = {
  new: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  drafted: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200',
  submitted: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  rejected: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 line-through',
  skipped: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500',
};

function fmtDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const now = new Date();
  const diffMs = +now - +d;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString();
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
}

async function loadData() {
  try {
    const [tracked, jobs] = await Promise.all([getRecentTracked(50), getRecentJobs(50)]);
    return { tracked, jobs, error: null as string | null };
  } catch (e) {
    return { tracked: [], jobs: [], error: (e as Error).message };
  }
}

export default async function Home() {
  const { tracked, jobs, error } = await loadData();

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black text-zinc-900 dark:text-zinc-100 font-sans">
      <main className="mx-auto max-w-5xl px-6 py-10 sm:py-14">
        <header className="mb-10 flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">PM Hunt Agent</h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              Tracked URLs and discovered roles, freshest first.
            </p>
          </div>
          <div className="text-xs text-zinc-400 dark:text-zinc-500 tabular-nums">
            {tracked.length} tracked · {jobs.length} discovered
          </div>
        </header>

        {error && (
          <div className="mb-8 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            Couldn&apos;t load data: {error}
          </div>
        )}

        <section className="mb-12">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Tracked URLs · {tracked.length}
          </h2>
          {tracked.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Nothing tracked yet. DM the Telegram bot a job URL to start.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
              {tracked.map((t) => (
                <li key={t.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
                  <span className="text-xl leading-none" title={t.tier}>{TIER_EMOJI[t.tier]}</span>
                  <div className="min-w-0 flex-1">
                    <a
                      href={t.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="block truncate text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                    >
                      {hostOf(t.url)}
                      <span className="ml-2 text-xs font-normal text-zinc-500 dark:text-zinc-400">{t.url}</span>
                    </a>
                    <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                      added {fmtDate(t.addedAt)}
                    </div>
                  </div>
                  <span
                    className={`inline-flex h-6 items-center rounded-full px-2 text-xs font-medium ${STATUS_CLASS[t.status]}`}
                  >
                    {t.status}
                  </span>
                  <form action={setTrackedStatus} className="flex items-center gap-2">
                    <input type="hidden" name="id" value={t.id} />
                    <select
                      name="status"
                      defaultValue={t.status}
                      className="h-7 rounded border border-zinc-300 bg-white px-2 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      className="h-7 rounded border border-zinc-300 bg-zinc-100 px-2 text-xs font-medium text-zinc-700 hover:bg-zinc-200 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                    >
                      Save
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Discovered Jobs · {jobs.length}
          </h2>
          {jobs.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No jobs saved yet. The daily cron will populate this once a match clears the filters.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
              {jobs.map((j) => (
                <li key={j.id} className="px-4 py-3">
                  <a
                    href={j.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="block text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                  >
                    {j.title}
                  </a>
                  <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    {j.company} · {j.location || 'remote'} · <span className="italic">{j.source}</span>
                    {j.salary ? ` · ${j.salary}` : ''} · {fmtDate(j.postedAt)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
