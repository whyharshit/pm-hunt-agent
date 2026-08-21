/**
 * Spec for the shared invocation clock (lib/invocation-clock.ts), for the drift between it and
 * the route it governs, and for what a killed run looks like on the dashboard
 * (lib/agents.ts `runDisplayState`). Free — no network, no Redis.
 *   npx tsx scripts/check-invocation-clock.mts
 *
 * THE FAILURE THIS PINS, measured by reading the code on 2026-08-21. `/api/funding` runs six
 * passes back to back inside `maxDuration = 300`, and each declared its own budget as if it
 * were alone:
 *
 *   runFundingScan   unbounded
 *   runPrepare       40s enrich + 60s draft
 *   runAutoSend      70s pacing
 *   runFollowUps     70s pacing + an IMAP session
 *   runJobPrepare    20s
 *   runJobAutoSend   up to 120s at cap 20
 *
 * 380s of budget inside a 300s function. Every number was defensible on its own; nobody added
 * them up. The platform then killed the LAST pass — `runJobAutoSend`, the one that mails
 * internship applications, the point of the project — and killed it silently, because the
 * statement that records a result is the last one in the pass.
 *
 * So two properties are pinned here, and they are the two halves of the same bug:
 *   1. a pass can no longer be granted time the invocation does not have, and
 *   2. a run that was killed no longer renders as a run that is healthy.
 */
import { readFileSync } from 'node:fs';
import { RUN_DEAD_AFTER_MS, runDisplayState } from '../lib/agents';
import {
  FUNDING_INVOCATION_MS,
  createInvocationClock,
  unboundedClock,
} from '../lib/invocation-clock';
import type { AgentRun } from '../lib/types';

let bad = 0;
const check = (label: string, ok: boolean) => {
  if (!ok) {
    console.log(`✗ ${label}`);
    bad++;
  }
};

// --- The clock hands out what is left, not what is asked for -------------------------------
// `startedAt` in the past is how a check script fast-forwards without sleeping.
const RESERVE_MS = 25_000; // the reserve lib/invocation-clock.ts keeps back
const at = (elapsedMs: number) =>
  createInvocationClock({ totalMs: FUNDING_INVOCATION_MS, startedAt: Date.now() - elapsedMs });

const fresh = at(0);
check(
  'a fresh clock grants a 70s ask in full',
  fresh.grant(70_000) === 70_000
);
check(
  'a fresh clock keeps the reserve back',
  Math.abs(fresh.remainingMs() - (FUNDING_INVOCATION_MS - RESERVE_MS)) < 1_000
);

// 200s in, 275s spendable: 75s left, so the 120s ask the job sender makes at cap 20 is cut.
const late = at(200_000);
check('at 200s a 120s ask is cut to what remains', late.grant(120_000) < 80_000);
check('at 200s a 120s ask is not negative or padded', late.grant(120_000) > 60_000);

// ⚠️ THE PROPERTY THE OLD CODE BROKE, simulated: five passes each ask for their old
// stand-alone budget and each spends what it is granted. The clock is a WALL clock, not a
// token bucket — a grant costs nothing until the pass actually burns it — so the simulation
// advances the start time by each grant, which is what a real pass does by running.
const asks = [20_000, 120_000, 100_000, 70_000, 70_000];
let elapsed = 0;
const granted: number[] = [];
for (const ask of asks) {
  const g = at(elapsed).grant(ask);
  granted.push(g);
  elapsed += g;
}
const handedOut = granted.reduce((a, b) => a + b, 0);
check(
  `five passes asking ${asks.reduce((a, b) => a + b, 0) / 1000}s are granted at most the invocation`,
  handedOut <= FUNDING_INVOCATION_MS
);
check(
  'the grants stop at the spendable end, reserve intact',
  Math.abs(handedOut - (FUNDING_INVOCATION_MS - RESERVE_MS)) < 2_000
);
// ⚠️ THIS IS THE WHOLE REASON ORDER IS PRIORITY. The pass at the front of the queue got its
// full 20s ask; the pass at the back got nothing at all. That was `runJobAutoSend`.
check('the first pass in the queue gets its full ask', granted[0] === asks[0]);
check('the LAST pass in the queue gets nothing', granted[granted.length - 1] === 0);

// Past the end, a pass is offered nothing rather than a negative deadline it would read as
// expired-in-the-past — and `canAfford` is what makes it decline instead of run a token
// version of itself.
const spent = at(FUNDING_INVOCATION_MS + 10_000);
check('a spent clock grants 0, never a negative', spent.grant(70_000) === 0);
check('a spent clock remains at 0', spent.remainingMs() === 0);
check('a spent clock cannot afford a 12s send floor', !spent.canAfford(12_000));
check('a fresh clock can afford a 12s send floor', fresh.canAfford(12_000));
check('a fresh clock cannot afford more than the invocation', !fresh.canAfford(FUNDING_INVOCATION_MS));

// `deadlineFor` is the same arithmetic in absolute form, for the passes that carry a deadline
// through a loop rather than a pacing budget.
const deadline = late.deadlineFor(120_000);
check('deadlineFor lands inside what remains', deadline - Date.now() <= late.remainingMs() + 1_000);
check('deadlineFor on a spent clock is now, i.e. already expired', spent.deadlineFor(60_000) - Date.now() < 1_000);

// The dashboard buttons and /api/admin own their whole request; passing nothing means this.
check('the unbounded clock grants any ask', unboundedClock.grant(999_000) === 999_000);
check('the unbounded clock can afford anything', unboundedClock.canAfford(999_000));

// --- The clock's total must match the platform ceiling it stands in for --------------------
// ⚠️ If these two drift apart the clock hands out time the function does not have, and the
// oversubscription is back with an extra layer of indirection on top.
const route = readFileSync(new URL('../app/api/funding/route.ts', import.meta.url), 'utf8');
const declared = /export const maxDuration = (\d+)/.exec(route)?.[1];
check(
  `route maxDuration (${declared}s) matches FUNDING_INVOCATION_MS (${FUNDING_INVOCATION_MS / 1000}s)`,
  declared !== undefined && Number(declared) * 1000 === FUNDING_INVOCATION_MS
);

// --- Order is priority now, so the order is a spec ----------------------------------------
// ⚠️ THE INTERNSHIP PIPELINE IS THE GOAL AND IT USED TO BE SCHEDULED LAST OF SIX. With one
// shared clock, whichever pass runs first gets its full ask and the last one gets the
// remainder — so moving a call in this route is a decision about which pipeline gets mailed on
// a slow morning, not a tidy-up.
const order = (needle: string) => route.indexOf(needle);
check('runJobPrepare is called', order('runJobPrepare(') > 0);
check('runJobAutoSend is called', order('runJobAutoSend(') > 0);
check('job prepare runs before job send', order('runJobPrepare(') < order('runJobAutoSend('));
for (const later of ['runFundingScan(', 'runPrepare(', 'runAutoSend(', 'runFollowUps(']) {
  check(`the job sender runs BEFORE ${later.replace('(', '')}`, order('runJobAutoSend(') < order(later));
}
check('funding prepare still runs before the founder sender', order('runPrepare(') < order('runAutoSend('));
// Every pass that can be starved must be handed the clock, or it silently keeps its old
// stand-alone budget and the sum goes back over 300s.
for (const call of [
  'runJobPrepare({ dryRun: jobsDry, manual: prepareJobsOnly, clock })',
  'runJobAutoSend({ dryRun: jobsDry, clock })',
  'runPrepare({ dryRun: prepare === \'dry\', clock })',
  'runAutoSend({ dryRun: autosend === \'dry\', clock })',
  'runFollowUps({ dryRun: followups === \'dry\', clock })',
]) {
  check(`the clock is threaded into ${call.split('(')[0]}`, route.includes(call));
}

// --- A killed run must not look like a healthy one ----------------------------------------
const running = (agoMs: number): AgentRun => ({
  agentId: 'job-mailer',
  state: 'running',
  startedAt: new Date(Date.now() - agoMs).toISOString(),
});

check('no record at all reads as idle', runDisplayState(undefined) === 'idle');
check('a run that started seconds ago is running', runDisplayState(running(5_000)) === 'running');
check(
  'a run still "running" one invocation later is running (grace for clock skew)',
  runDisplayState(running(FUNDING_INVOCATION_MS - 10_000)) === 'running'
);
check(
  'a run still "running" past the ceiling is DEAD, not running',
  runDisplayState(running(RUN_DEAD_AFTER_MS + 60_000)) === 'dead'
);
check(
  'a run still "running" a day later is DEAD — this is the card that pulsed for ever',
  runDisplayState(running(24 * 60 * 60 * 1000)) === 'dead'
);
// Aging is the only test applied. A finished run is reported exactly as it recorded itself,
// however old it is: an `ok` from last week is still what happened.
check(
  'an old ok stays ok',
  runDisplayState({ agentId: 'x', state: 'ok', finishedAt: new Date(0).toISOString() }) === 'ok'
);
check(
  'an old error stays error',
  runDisplayState({ agentId: 'x', state: 'error', error: 'boom' }) === 'error'
);
check('idle stays idle', runDisplayState({ agentId: 'x', state: 'idle' }) === 'idle');
check(
  'running with no startedAt cannot be confirmed alive, so it reads dead',
  runDisplayState({ agentId: 'x', state: 'running' }) === 'dead'
);
check(
  'running with an unparseable startedAt reads dead',
  runDisplayState({ agentId: 'x', state: 'running', startedAt: 'not a date' }) === 'dead'
);

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} CHECKS FAILED`);
process.exit(bad === 0 ? 0 : 1);
