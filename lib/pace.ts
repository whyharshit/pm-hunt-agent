/**
 * Space outreach sends out in time instead of firing the whole batch in one burst.
 *
 * WHY: every email in a run used to carry the same timestamp, to the second, at a round
 * clock time. Three or four cold emails stamped 09:00:0x from one personal Gmail is a
 * machine signature, and it is the sort of pattern spam filters and humans both notice.
 * User's instruction 2026-08-09: "don't keep sending time of emails exact 9:00, send at like
 * 9:17 etc".
 *
 * WHAT THIS CAN AND CANNOT DO. Vercel Hobby fires a cron once a day and a function cannot
 * outlive its `maxDuration`, so the hour the batch STARTS is fixed by the schedule in
 * vercel.json (moved off the round half-hour to 03:47 UTC = 09:17 IST). What is randomised
 * here is everything after that: a random pause before the first send, so the batch does not
 * begin on the same second every morning, and a random gap between each one, so no two
 * founders receive mail with the same timestamp.
 *
 * The budget is a hard ceiling. Pacing is a nicety and a send is not: once the budget is
 * spent, the remaining messages go out back-to-back rather than being dropped or timing the
 * function out.
 */

/** Never less than this between two sends, or the spacing is not doing anything. */
const MIN_GAP_MS = 6_000;
/** Never more than this, however small the batch. Long enough to look human. */
const MAX_GAP_MS = 45_000;

export type Pacer = () => Promise<void>;

/**
 * A pacer for one batch. Call the returned function immediately BEFORE each send, including
 * the first — that first call is what varies the start time day to day.
 *
 * The gap ceiling is derived from the budget and the batch size, so a big batch paces itself
 * tighter rather than running out of time halfway and sending the tail in a burst.
 */
export function createPacer(opts: { budgetMs: number; count: number }): Pacer {
  const deadline = Date.now() + opts.budgetMs;
  const ceiling = Math.min(MAX_GAP_MS, Math.floor(opts.budgetMs / Math.max(1, opts.count)));

  return async function pause(): Promise<void> {
    const remaining = deadline - Date.now();
    if (remaining <= MIN_GAP_MS || ceiling <= MIN_GAP_MS) return;
    const gap = MIN_GAP_MS + Math.random() * (Math.min(ceiling, remaining) - MIN_GAP_MS);
    await new Promise((resolve) => setTimeout(resolve, gap));
  };
}

/** A pacer that never waits. For dry runs, which must report instantly and touch nothing. */
export const noPacing: Pacer = async () => {};
