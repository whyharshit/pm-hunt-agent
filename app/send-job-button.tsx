'use client';

import { useFormStatus } from 'react-dom';
import { sendJobEmail } from '@/lib/actions';

/**
 * Send one application, from the dashboard.
 *
 * Client-side for the confirm, and the confirm names the ADDRESS and the GREETING rather than
 * asking "are you sure". A cold email cannot be recalled, and the specific mistake worth
 * catching here is not a stray click but a right-click on the wrong row: an email opening
 * "Hi Ananya," going to `hr@` reads as a botched mail-merge and burns the contact. Putting
 * both halves in the dialog makes that mismatch impossible to miss.
 */
function Inner({ warn }: { warn: boolean }) {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className={
        warn
          ? 'h-7 rounded border border-amber-300 bg-amber-50 px-2 text-xs font-medium text-amber-800 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200'
          : 'h-7 rounded border border-emerald-300 bg-emerald-50 px-2 text-xs font-medium text-emerald-800 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-800 dark:bg-emerald-950 dark:text-emerald-200'
      }
    >
      {pending ? 'Sending…' : warn ? 'Send anyway' : 'Send'}
    </button>
  );
}

export function SendJobButton({
  id,
  to,
  greeted,
  company,
  warn,
}: {
  id: string;
  to: string;
  /** The name the draft opens with, so the confirm can show it beside the address. */
  greeted: string;
  /**
   * How the row reads, for the confirm. May be a "posted by <name>" label rather than a
   * company: a LinkedIn post that never named its employer has no company name, and inventing
   * one here would misreport what the email about to go out actually says.
   */
  company: string;
  /** True when the address is a shared inbox or does not match the greeting. */
  warn?: boolean;
}) {
  return (
    <form
      action={sendJobEmail}
      onSubmit={(e) => {
        const opens = greeted ? `It opens "Hi ${greeted},".` : 'It has no greeting.';
        const row = company ? `\n\nRow: ${company}` : '';
        if (!confirm(`Send this application to ${to}?${row}\n\n${opens}\n\nThis cannot be undone.`)) {
          e.preventDefault();
        }
      }}
    >
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="to" value={to} />
      <Inner warn={Boolean(warn)} />
    </form>
  );
}
