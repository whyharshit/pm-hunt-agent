'use client';

import { useFormStatus } from 'react-dom';

/**
 * Delete control for any row. Client-side because deletion has no undo and the native
 * confirm is the only thing between a stray click and a row plus all its artifacts going
 * away — a server action alone cannot ask.
 *
 * Deliberately quiet by default (grey, small) and only red on hover: it sits beside the
 * actions people actually want, so it should not compete with them.
 */
function Inner({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      title={label}
      className="h-7 rounded border border-zinc-200 bg-white px-2 text-xs font-medium text-zinc-400 hover:border-red-300 hover:bg-red-50 hover:text-red-600 disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-500 dark:hover:border-red-900 dark:hover:bg-red-950 dark:hover:text-red-400"
    >
      {pending ? 'Deleting…' : 'Delete'}
    </button>
  );
}

export function DeleteButton({
  id,
  action,
  what,
}: {
  id: string;
  /** The server action to post to. */
  action: (formData: FormData) => Promise<void>;
  /** Named in the confirm dialog so it is obvious WHICH row is about to go. */
  what: string;
}) {
  return (
    <form
      action={action}
      onSubmit={(e) => {
        if (!confirm(`Delete ${what}? This cannot be undone.`)) e.preventDefault();
      }}
    >
      <input type="hidden" name="id" value={id} />
      <Inner label={`Delete ${what}`} />
    </form>
  );
}
