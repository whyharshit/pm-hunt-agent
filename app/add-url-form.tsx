'use client';

import { useActionState } from 'react';
import { addTrackedUrl, type AddUrlState } from '@/lib/actions';

const initialState: AddUrlState = { ok: false, message: '' };

export function AddUrlForm() {
  const [state, formAction, pending] = useActionState(addTrackedUrl, initialState);

  return (
    <div className="mb-4">
      <form action={formAction} className="flex flex-wrap items-center gap-2">
        <input
          name="url"
          type="text"
          required
          placeholder="Paste a job URL (lever, greenhouse, ashby, workable, Google Form…)"
          className="h-8 min-w-0 flex-1 rounded border border-zinc-300 bg-white px-2 text-xs text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600"
        />
        <button
          type="submit"
          disabled={pending}
          className="h-8 rounded border border-indigo-300 bg-indigo-50 px-3 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-200 dark:hover:bg-indigo-900"
        >
          {pending ? 'Adding…' : 'Add URL'}
        </button>
      </form>
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
