import { resetJobDraft, updateJobDraft } from '@/lib/actions';
import {
  JOB_TEMPLATE_VERSION,
  isEditedJobDraft,
  isPitchDraft,
  isStaleJobDraft,
} from '@/lib/job-outreach-template';
import type { JobOutreach } from '@/lib/types';

/**
 * The application, on the row, before anybody mails it.
 *
 * ⚠️ THIS EXISTS BECAUSE A DRAFT NOBODY CAN READ IS A DRAFT NOBODY CAN CHECK. Until this was
 * shared, the body was rendered only on /paste, and /paste lists only PASTED rows — so a
 * DISCOVERED row showed one line (`✉ name · address`) and a Send button, and the only way to
 * learn what it actually said was to receive it. That is precisely how an application about
 * "Prompt Engineer roles at Fathima Sajid" reached Fathima Sajid, who is a recruiter and not a
 * company: every automated check passed, and the one check that would have caught it — a human
 * reading the sentence — had nothing to read.
 *
 * So it lives here, in one component, used by both routes. A second copy would be a second
 * thing to keep in step, and the copy on the route that mails strangers unattended is the one
 * that would fall behind.
 */
export function JobDraftBlock({
  id,
  draft,
  greeted,
  summary,
}: {
  id: string;
  draft: JobOutreach;
  greeted: string | null;
  /** What the closed disclosure says. Defaults to a review prompt, not an edit prompt. */
  summary?: string;
}) {
  const edited = isEditedJobDraft(draft.model);
  // A machine-written draft from an OLDER template. THE SAME PREDICATE THE SENDERS USE, on
  // purpose: they re-render these themselves before sending (they stopped trusting the prepare
  // pass to have reached every row), so the text below is NOT what would go out. A badge that
  // computed staleness its own way could call a row fine while the sender rewrote it.
  const stale = isStaleJobDraft(draft.model);

  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
        {summary ?? 'Read the email before it goes'}
        {isPitchDraft(draft.model) && (
          <span className="ml-2 text-zinc-400 dark:text-zinc-500">· pitch, not an application</span>
        )}
        {edited && (
          <span className="ml-2 text-amber-700 dark:text-amber-400">· edited by hand</span>
        )}
        {stale && (
          <span className="ml-2 text-amber-700 dark:text-amber-400">
            · stale ({draft.model.replace(/^template:/, '')})
          </span>
        )}
      </summary>
      <JobDraftEditor id={id} draft={draft} greeted={greeted} edited={edited} stale={stale} />
    </details>
  );
}

/**
 * Edit an application before sending it. Same shape as the funding pipeline's editor
 * (app/funding-section.tsx) because it is the same job, and a second layout for it would be a
 * second thing to keep in step.
 *
 * ⚠️ THE GREETING LINE IS LOAD-BEARING AND EASY TO EDIT BY ACCIDENT. Every send path checks
 * that the draft opens with the recipient's name (or "Hi team," for a shared inbox); the
 * unattended sender REFUSES a hand-edited draft whose greeting no longer matches rather than
 * rewriting it, because rewriting would throw away the edit. So the opener is stated here
 * rather than left to be rediscovered from a failure message three days later.
 *
 * ⚠️ SAVING A STALE DRAFT PINS IT. Save stamps the row `+edited`, and `+edited` is exactly the
 * flag that tells every re-render to leave the row alone — so pressing Save on old copy does
 * not preserve a draft, it adopts one, and the fix that was going to replace it never lands.
 * Hence the warning and the re-render button below, which are shown for a stale row whether or
 * not it has been touched by hand.
 */
function JobDraftEditor({
  id,
  draft,
  greeted,
  edited,
  stale,
}: {
  id: string;
  draft: JobOutreach;
  greeted: string | null;
  edited: boolean;
  stale: boolean;
}) {
  return (
    <form action={updateJobDraft} className="mt-2 space-y-1">
      <input type="hidden" name="id" value={id} />

      {stale && (
        <p className="rounded border border-amber-300 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-300">
          Written by an older template, so this is not what would be sent — the sender re-renders
          it to {JOB_TEMPLATE_VERSION} on its way out. Read it here and it may still name the
          poster as the employer. <strong>Do not press Save to keep it:</strong> saving marks the
          row hand-edited, which is what stops the re-render. Press “Re-render” to see the real
          text.
        </p>
      )}

      <input
        type="text"
        name="subject"
        defaultValue={draft.subject ?? ''}
        placeholder="Subject"
        className="w-full rounded border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
      />
      <textarea
        name="text"
        defaultValue={draft.text}
        // Tall enough for the whole template, so editing does not happen down a peephole.
        rows={18}
        className="w-full resize-y rounded border border-zinc-200 bg-white px-3 py-2 font-mono text-xs leading-relaxed text-zinc-700 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300"
      />
      {greeted && (
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          Keep the opener as “Hi {greeted},” — every send path checks the greeting against the
          address, and a hand-edited draft is refused rather than silently rewritten.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          className="h-7 rounded border border-zinc-300 bg-white px-2 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          Save draft
        </button>
        {edited && (
          <span className="text-[11px] text-amber-700 dark:text-amber-400">
            edited by hand · bulk re-drafts skip this row
          </span>
        )}
        {/* Reset is offered for a STALE row too, not just a hand-edited one. It is the same
            action either way — re-render from the current template — and for a stale row it is
            the only way to read the copy that would actually be sent. */}
        {(edited || stale) && (
          <button
            type="submit"
            formAction={resetJobDraft}
            className="h-7 rounded border border-zinc-300 bg-white px-2 text-[11px] text-zinc-500 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
          >
            {stale ? `Re-render with ${JOB_TEMPLATE_VERSION}` : 'Reset to template'}
          </button>
        )}
      </div>
    </form>
  );
}
