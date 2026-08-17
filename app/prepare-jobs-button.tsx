'use client';

import { useFormStatus } from 'react-dom';
import { runJobPreparePass } from '@/lib/actions';

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
