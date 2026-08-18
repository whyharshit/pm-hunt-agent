'use client';

import { useActionState } from 'react';
import { pasteHiringPost, type PasteState } from '@/lib/actions';

const initialState: PasteState = { ok: false, message: '' };

const field =
  'h-8 min-w-0 rounded border border-zinc-300 bg-white px-2 text-xs text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600';

/**
 * Paste a hiring post you found on LinkedIn yourself.
 *
 * Company is the only required field beside the post. It is not a formality: the email names
 * the company twice, and it is the sole key Hunter can resolve a domain by when the post
 * carries no address.
 */
export function PasteForm() {
  const [state, formAction, pending] = useActionState(pasteHiringPost, initialState);

  return (
    <div className="mb-6">
      <form action={formAction} className="flex flex-col gap-2">
        <textarea
          name="text"
          required
          rows={8}
          placeholder="Paste the whole post here, including any email address or 'DM me' line…"
          className="w-full rounded border border-zinc-300 bg-white p-2 text-xs leading-relaxed text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600"
        />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <input name="company" required placeholder="Company (required)" className={field} />
          <input name="poster" placeholder="Who posted it, e.g. Ananya Rao" className={field} />
          <input name="role" placeholder="Role (optional, overrides what's read from the post)" className={field} />
          <input name="url" placeholder="Link to the post (optional)" className={field} />
        </div>
        {/* The contact database (user's ask, 2026-08-18). These are the details no scraper can
            reach: plenty of posts put the address in an image, and a profile URL or phone
            number is worth keeping once found by hand even after the application has gone.
            A typed email LEADS the ones parsed out of the post and is stamped `added by hand`,
            which the unattended sender already trusts. */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <input
            name="email"
            type="email"
            placeholder="Email (if the post hides it)"
            className={field}
          />
          <input name="linkedin" placeholder="LinkedIn profile URL" className={field} />
          <input name="phone" placeholder="Phone" className={field} />
        </div>
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={pending}
            className="h-8 rounded border border-indigo-300 bg-indigo-50 px-3 text-xs font-medium text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-200 dark:hover:bg-indigo-900"
          >
            {pending ? 'Looking up…' : 'Find the email & draft'}
          </button>
          <span className="text-[11px] text-zinc-500 dark:text-zinc-400">
            Address in the post is used first, free. Only if there is none does this spend a
            Hunter credit.
          </span>
        </div>
      </form>
      {state.message && (
        <p
          className={`mt-2 text-[11px] ${
            state.ok ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-400'
          }`}
        >
          {state.message}
        </p>
      )}
    </div>
  );
}
