/** Compact relative time: "just now", "5m ago", "3h ago", "2d ago", else a date. */
export function fmtDate(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const now = new Date();
  const diffMs = +now - +d;
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day}d ago`;
  return d.toLocaleDateString();
}

/**
 * The same idea pointed forwards: "due today", "due tomorrow", "due in 5d".
 *
 * `fmtDate` reads a future timestamp as a negative age and renders it as "just now", which on
 * a follow-up due date says the exact opposite of the truth.
 */
export function fmtDue(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const days = Math.round((+d - Date.now()) / 86400000);
  if (days < 0) return 'due now';
  if (days === 0) return 'due today';
  if (days === 1) return 'due tomorrow';
  return `due in ${days}d`;
}

/**
 * An absolute timestamp, in the user's own timezone: "18 Aug, 09:44".
 *
 * ⚠️ IST, NOT UTC, AND NOT THE SERVER'S IDEA OF LOCAL. The functions run in UTC on Vercel, so
 * a default `toLocaleString` would render 04:14 for an email the user watched leave at 09:44 —
 * and on a mail timeline the whole point is matching what Gmail shows them. The rest of the
 * project already reckons in IST (the cron is tuned to 09:17 IST, see lib/pace.ts).
 *
 * `fmtDate` stays the right choice for "how long ago" on a row; this is for a sequence of
 * events, where relative times ("3d ago" three times over) say nothing about the order.
 */
export function fmtStamp(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(+d)) return '(no date)';
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return u;
  }
}
