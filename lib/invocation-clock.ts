/**
 * One wall clock, shared by every pass inside one serverless invocation.
 *
 * WHY: `/api/funding` runs six passes back to back and each one declared its budget in
 * isolation — 100s of funding prepare (40 enrich + 60 draft), 70s of cold-send pacing, 70s of
 * follow-up pacing plus an IMAP session, 20s of job prepare, and up to 120s of job-send
 * pacing. That is **380s of budget inside a 300s function**, before the funding scan or a
 * single SMTP round trip. No individual number was wrong. They were simply never added up.
 *
 * ⚠️ THE PASS THE PLATFORM KILLS IS THE LAST ONE, AND IT DIES WITHOUT SAYING SO. Sends that
 * already happened are recorded per iteration (`saveJobOutreach` + `updateJobStatus` +
 * `recordInitialSend` all sit inside the send loop), so nothing double-sends on the next
 * fire — the batch just stops mid-way, no result is written, and the dashboard is left with a
 * card that pulses "running" forever. See `runDisplayState` in lib/agents.ts for the other
 * half of that story.
 *
 * So a budget stops being an independent constant and becomes a REQUEST. A pass asks for the
 * time it wants; the clock hands back what this invocation can still afford. A pass that
 * cannot afford its own floor returns `outOfTime` instead of running a token version of
 * itself — which matters most for the senders, where "no budget left" would otherwise mean
 * "fire the whole batch back to back with identical timestamps", the exact machine signature
 * lib/pace.ts exists to remove.
 *
 * ⚠️ ORDER IS PRIORITY NOW. Whichever pass runs first gets its full ask and the last one gets
 * the remainder, so the route's ordering is a decision about which pipeline matters, not a
 * matter of taste. The internship pipeline runs first; see the route.
 */

/** Must match `maxDuration` in app/api/funding/route.ts. */
export const FUNDING_INVOCATION_MS = 300_000;

/**
 * Time never handed out, kept back for the work that is not pacing: the final SMTP round
 * trip, the Redis writes that record it, the IMAP teardown, and serialising the response. A
 * pass overruns its pacing budget by whatever its network calls cost, and the platform kill
 * is unconditional — the reserve is what stands between "the last send is recorded" and "the
 * last send happened but nothing knows it did".
 */
const RESERVE_MS = 25_000;

export type InvocationClock = {
  /** Time left to hand out, never negative. Excludes the reserve. */
  remainingMs(): number;
  /** Since the clock was created — i.e. roughly since the invocation began. */
  elapsedMs(): number;
  /** What a pass asking for `wantMs` actually gets. */
  grant(wantMs: number): number;
  /** `Date.now()` plus `grant(wantMs)`, for the passes that carry a deadline. */
  deadlineFor(wantMs: number): number;
  /** Is there enough left for a pass whose floor is `minMs` to be worth starting? */
  canAfford(minMs: number): boolean;
};

/**
 * `startedAt` is a parameter so a check script can pin the arithmetic without sleeping, and
 * so a caller that has already burnt time before creating the clock can say so.
 */
export function createInvocationClock(opts: {
  totalMs: number;
  reserveMs?: number;
  startedAt?: number;
}): InvocationClock {
  const startedAt = opts.startedAt ?? Date.now();
  const reserve = opts.reserveMs ?? RESERVE_MS;
  const spendableEnd = startedAt + Math.max(0, opts.totalMs - reserve);

  const remainingMs = () => Math.max(0, spendableEnd - Date.now());
  const grant = (wantMs: number) => Math.max(0, Math.min(wantMs, remainingMs()));

  return {
    remainingMs,
    elapsedMs: () => Date.now() - startedAt,
    grant,
    deadlineFor: (wantMs: number) => Date.now() + grant(wantMs),
    canAfford: (minMs: number) => remainingMs() >= minMs,
  };
}

/**
 * A clock that never runs out, for the callers that own their whole request: the dashboard
 * buttons, `/api/admin`, a check script. They are not sharing the invocation with five other
 * passes, and their own `maxDuration` is the only ceiling that applies.
 *
 * Passing this is the same as passing nothing; it exists so a call site can say "unbounded on
 * purpose" out loud rather than by omission.
 */
export const unboundedClock: InvocationClock = {
  remainingMs: () => Number.POSITIVE_INFINITY,
  elapsedMs: () => 0,
  grant: (wantMs) => wantMs,
  deadlineFor: (wantMs) => Date.now() + wantMs,
  canAfford: () => true,
};
