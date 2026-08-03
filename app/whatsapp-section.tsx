import { setWhatsappLeadStatus } from '@/lib/actions';
import { fmtDate } from '@/lib/format';
import { CopyButton } from './copy-button';
import type { WhatsappLead } from '@/lib/types';

const STATUSES: WhatsappLead['status'][] = ['new', 'contacted', 'skipped'];

const STATUS_CLASS: Record<WhatsappLead['status'], string> = {
  new: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  contacted: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  skipped: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500',
};

/**
 * Matched group posts that carry no application URL — "mail your CV to hr@x.com" or
 * "DM me". They can't enter the URL-keyed tracker (nothing to scrape or tailor
 * against), so they live here as leads you act on by hand.
 */
export function WhatsappSection({ leads }: { leads: WhatsappLead[] }) {
  if (leads.length === 0) return null;

  return (
    <section className="mb-12">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
        WhatsApp leads · {leads.length}
      </h2>
      <p className="mb-3 text-xs text-zinc-500 dark:text-zinc-400">
        Matched group posts with no application link — reply by email or DM yourself. Posts that
        did carry a link are in Tracked URLs above.
      </p>
      <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
        {leads.map((l) => (
          <li key={l.id} className="flex flex-col gap-2 px-4 py-3">
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                  {l.matchedRole || l.roleLine}
                </div>
                <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                  {l.group}
                  {l.sender ? ` · ${l.sender}` : ''} · {fmtDate(l.postedAt)}
                </div>
              </div>
              <span
                className={`inline-flex h-6 items-center rounded-full px-2 text-xs font-medium ${STATUS_CLASS[l.status]}`}
              >
                {l.status}
              </span>
              <form action={setWhatsappLeadStatus} className="flex items-center gap-2">
                <input type="hidden" name="id" value={l.id} />
                <select
                  name="status"
                  defaultValue={l.status}
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
            </div>

            <div className="flex flex-wrap items-center gap-2 text-xs">
              {l.emails.map((e) => (
                <a
                  key={e}
                  href={`mailto:${e}`}
                  className="rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-[11px] text-emerald-800 hover:underline dark:bg-emerald-900/40 dark:text-emerald-200"
                >
                  {e}
                </a>
              ))}
              {l.emails.length === 0 && l.hasDmAsk && (
                <span className="text-[11px] text-amber-700 dark:text-amber-400">
                  DM the poster in the group — no address given
                </span>
              )}
              {l.emails.length === 0 && !l.hasDmAsk && (
                <span className="text-[11px] text-amber-700 dark:text-amber-400">
                  No apply route in the post
                </span>
              )}
              <CopyButton text={l.text} label="Copy post" />
            </div>

            <details className="text-xs text-zinc-500 dark:text-zinc-400">
              <summary className="cursor-pointer select-none hover:text-zinc-700 dark:hover:text-zinc-200">
                Original post
              </summary>
              <pre className="mt-2 whitespace-pre-wrap break-words rounded border border-zinc-200 bg-zinc-50 p-2 font-sans text-[11px] leading-relaxed dark:border-zinc-800 dark:bg-zinc-900">
                {l.text}
              </pre>
            </details>
          </li>
        ))}
      </ul>
    </section>
  );
}
