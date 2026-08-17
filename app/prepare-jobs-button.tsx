'use client';

import { useFormStatus } from 'react-dom';
import { runJobPreparePass, sendEligibleJobs } from '@/lib/actions';

/**
 * Runs the contact-and-draft pass on demand.
 *
 * Client-side purely for the pending state: the pass has a 20s budget and spends a Hunter
 * credit, so a button that looks inert for twenty seconds invites a second click, and a
 * second click is a second credit.
 */
function Inner() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-7 rounded border border-indigo-300 bg-indigo-50 px-2.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-200 dark:hover:bg-indigo-900"
    >
      {pending ? 'Looking up contacts…' : 'Find contacts & draft'}
    </button>
  );
}

export function PrepareJobsButton() {
  return (
    <form action={runJobPreparePass}>
      <Inner />
    </form>
  );
}

function SendInner({ count }: { count: number }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending || count === 0}
      className="h-7 rounded border border-emerald-300 bg-emerald-50 px-2.5 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-40 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200 dark:hover:bg-emerald-900"
    >
      {pending ? 'Sending…' : `Send all ${count} now`}
    </button>
  );
}

/**
 * Send the eligible batch without waiting for tomorrow's cron.
 *
 * The confirm states the COUNT and that it cannot be undone, because unlike the per-row button
 * there is no single address to name — this is the one control here that mails several
 * strangers on one click.
 */
export function SendEligibleJobsButton({ count }: { count: number }) {
  return (
    <form
      action={sendEligibleJobs}
      onSubmit={(e) => {
        if (
          !confirm(
            `Send ${count} job application${count === 1 ? '' : 's'} now?\n\n` +
              `They go from your Gmail, spaced a few seconds apart, and each one starts a ` +
              `3-follow-up sequence that stops if they reply.\n\nThis cannot be undone.`
          )
        ) {
          e.preventDefault();
        }
      }}
    >
      <SendInner count={count} />
    </form>
  );
}
