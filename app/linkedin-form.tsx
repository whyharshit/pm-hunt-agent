'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { logLinkedInInvite, scanLinkedInMailNow, type LinkedInFormState } from '@/lib/actions';

const initial: LinkedInFormState = { ok: false, message: '' };

/**
 * Log an invitation by hand.
 *
 * ⚠️ THIS IS NOT A CONVENIENCE, IT IS THE ONLY SOURCE FOR "INVITED, WAITING". LinkedIn emails
 * an acceptance and emails nothing when an invitation is sent, and there is no API for either —
 * so a pending invite exists in this system only if the person who clicked Connect says so.
 */
export function LogInviteForm() {
  const [state, formAction, pending] = useActionState(logLinkedInInvite, initial);

  return (
    <div className="mb-4 rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <form action={formAction} className="flex flex-wrap items-center gap-2">
        <input
          name="name"
          required
          placeholder="Name, exactly as LinkedIn spells it"
          className="h-8 min-w-[14rem] flex-1 rounded border border-zinc-300 bg-white px-2 text-xs text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600"
        />
        <input
          name="profileUrl"
          placeholder="linkedin.com/in/… (optional)"
          className="h-8 min-w-[12rem] flex-1 rounded border border-zinc-300 bg-white px-2 text-xs text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600"
        />
        <input
          name="note"
          placeholder="Company or why (optional)"
          className="h-8 min-w-[10rem] flex-1 rounded border border-zinc-300 bg-white px-2 text-xs text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600"
        />
        <button
          type="submit"
          disabled={pending}
          className="h-8 rounded border border-indigo-300 bg-indigo-50 px-3 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-200 dark:hover:bg-indigo-900"
        >
          {pending ? 'Logging…' : 'Log invitation sent'}
        </button>
      </form>
      <p className="mt-1.5 text-[11px] text-zinc-400 dark:text-zinc-500">
        The name is what an acceptance email is matched on, so spell it as LinkedIn does. If they
        posted a job this project has seen, the row links itself to it.
      </p>
      {state.message && (
        <p
          className={`mt-1 text-[11px] ${
            state.ok ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'
          }`}
        >
          {state.message}
        </p>
      )}
    </div>
  );
}

function ScanInner() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-7 rounded border border-zinc-300 bg-white px-2.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
    >
      {pending ? 'Reading the mailbox…' : 'Scan LinkedIn mail now'}
    </button>
  );
}

/**
 * Client-side only for the pending state: the scan opens an IMAP session and reads a month of
 * mail, which is a few seconds of looking inert.
 */
export function ScanLinkedInButton() {
  return (
    <form action={scanLinkedInMailNow}>
      <ScanInner />
    </form>
  );
}

function MarkInner() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="h-7 rounded border border-emerald-300 bg-emerald-50 px-2 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200 dark:hover:bg-emerald-900"
    >
      {pending ? 'Saving…' : 'Mark accepted'}
    </button>
  );
}

/**
 * Always offered, even once the mail works.
 *
 * The parser only knows the acceptance phrasings it has been taught, and an unrecognised one
 * reads as "not a connection" — which loses a row rather than inventing one. A human looking at
 * LinkedIn must be able to overrule that.
 */
export function MarkAcceptedButton({
  id,
  action,
}: {
  id: string;
  action: (formData: FormData) => Promise<void>;
}) {
  return (
    <form action={action}>
      <input type="hidden" name="id" value={id} />
      <MarkInner />
    </form>
  );
}
