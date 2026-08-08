import { prefillGformTracked } from '@/lib/actions';
import { buildFormFillPrompt } from '@/lib/form-prompt';
import { CopyButton } from './copy-button';
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
  const formPrompt = buildFormFillPrompt(tracked);
  // The one condition the pre-filler can never overcome; matched on the message fetchForm
  // writes so the UI and lib/gform.ts cannot drift apart on wording.
  const signInRestricted = /requires Google sign-in/i.test(tracked.tailorError ?? '');

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
        {/* A sign-in-restricted form is not a failure, it is a property of the form: Google
            401s the view itself, so no server anywhere can read its fields. Rendering that
            as a red ⚠ next to working rows made the whole section look broken. It gets an
            informational note plus the only action that helps — open it signed in. */}
        {tracked.tailorError && !signInRestricted && (
          <span className="text-xs text-red-600 dark:text-red-400" title={tracked.tailorError}>
            ⚠ {tracked.tailorError}
          </span>
        )}
      </div>

      {signInRestricted && (
        <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          <div className="font-medium">This form is restricted to signed-in Google accounts.</div>
          <div className="mt-0.5">
            Google refuses to serve the questions to anyone who isn’t logged in, so no
            pre-filled link can be built for it — by anyone, not just this agent. Open it in
            your signed-in browser and paste your saved answers.
          </div>
          <a
            href={tracked.url}
            target="_blank"
            rel="noreferrer noopener"
            className="mt-1.5 inline-flex h-6 items-center rounded border border-amber-400 bg-white px-2 font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-900 dark:text-amber-100"
          >
            Open form signed in ↗
          </a>
        </div>
      )}

      {/* Works where the server-side pre-filler cannot: sign-in-restricted Google Forms,
          and every non-Google form (Melento, Lever, Internshala). */}
      <div className="flex flex-wrap items-center gap-2">
        <CopyButton text={formPrompt} label="Copy form-filling prompt" />
        <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
          paste into Claude in Chrome with the form open. It fills, you submit.
        </span>
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
