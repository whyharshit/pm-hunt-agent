import Link from 'next/link';

/**
 * The dashboard outgrew one page: ~150 discovered jobs and ~100 funding rows on `/` meant
 * scrolling past everything to reach anything. Each section is its own route now, and this
 * is the shared switcher.
 */
export function Nav({ current }: { current: 'home' | 'funding' | 'jobs' }) {
  const tab = (href: string, key: typeof current, label: string) => (
    <Link
      key={key}
      href={href}
      className={
        current === key
          ? 'rounded border border-zinc-900 bg-zinc-900 px-3 py-1.5 text-xs font-semibold text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
          : 'rounded border border-zinc-300 bg-white px-3 py-1.5 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800'
      }
    >
      {label}
    </Link>
  );

  return (
    <nav className="mb-6 flex flex-wrap gap-2">
      {tab('/', 'home', 'Agents & applications')}
      {tab('/funding', 'funding', 'Funding outreach')}
      {tab('/jobs', 'jobs', 'Discovered jobs')}
    </nav>
  );
}
