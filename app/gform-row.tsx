import { prefillGformTracked } from '@/lib/actions';
import type { GformPrefill, TrackedUrl } from '@/lib/types';

/**
 * Green-tier (Google Form) row actions. Generates a pre-filled link the user opens,
 * reviews, and submits themselves — we never submit. Shows what was filled vs left blank
 * so nothing goes out unseen.
 */
export function GformRow({
  tracked,
  prefill,
  answersReady,
}: {
  tracked: TrackedUrl;
  prefill: GformPrefill | undefined;
  answersReady: boolean;
}) {
  return (
    <div className="flex flex-col gap-2 sm:pl-9">
      <div className="flex flex-wrap items-center gap-2">
        <form action={prefillGformTracked}>
          <input type="hidden" name="id" value={tracked.id} />
          <button
            type="submit"
            className="h-7 rounded border border-emerald-300 bg-emerald-50 px-2 text-xs font-medium text-emerald-700 hover:bg-emerald-100 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200 dark:hover:bg-emerald-900"
          >
            {prefill ? 'Re-generate pre-fill' : 'Pre-fill form'}
          </button>
        </form>

        {prefill && (
          <a
            href={prefill.prefillUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex h-7 items-center rounded border border-indigo-300 bg-indigo-50 px-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-200 dark:hover:bg-indigo-900"
          >
            Open pre-filled form ↗
          </a>
        )}
        {prefill && (
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
            {prefill.filled.length}/{prefill.fieldCount} filled
          </span>
        )}
        {tracked.tailorError && (
          <span className="text-xs text-red-600 dark:text-red-400" title={tracked.tailorError}>
            ⚠ {tracked.tailorError}
          </span>
        )}
      </div>

      {!answersReady && (
        <p className="text-[11px] text-amber-700 dark:text-amber-400">
          Fill <code>profile/answers.json</code> first — the pre-filler has nothing to draw from yet.
        </p>
      )}

      {prefill && (
        <div className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-[11px] dark:border-zinc-800 dark:bg-zinc-900">
          <p className="font-medium text-zinc-600 dark:text-zinc-300">{prefill.formTitle}</p>
          {prefill.filled.length > 0 && (
            <p className="mt-1 text-green-700 dark:text-green-400">
              Filled: {prefill.filled.map((f) => f.title).join(' · ')}
            </p>
          )}
          {prefill.skipped.length > 0 && (
            <p className="mt-1 text-amber-700 dark:text-amber-400">
              You fill by hand: {prefill.skipped.map((s) => s.title).join(' · ')}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
