import type { AgentRun } from './types';

export type AgentKind = 'cron' | 'webhook' | 'pipeline';

export type AgentMeta = {
  id: string;
  name: string;
  description: string;
  kind: AgentKind;
  cadence?: string;
  status: 'live' | 'planned';
  /** Whether the dashboard shows a "Run now" button (handled by runAgent in actions.ts). */
  runnable?: boolean;
};

/**
 * The agent control-center registry. Live agents report run-state into Redis
 * (key `agent:<id>`); planned agents render as greyed roadmap cards. Add a new
 * agent by appending an entry here and calling recordAgentRun from its code.
 */
export const AGENTS: AgentMeta[] = [
  {
    id: 'discover',
    name: 'Discover',
    description: "Pulls intern roles (product/ops/data/VC/AI/SWE) from RemoteOK + We Work Remotely + HN Who's Hiring + Internshala + Unstop + YC + LinkedIn (guest job search, Serper, and Apify post search), filters them, and saves new matches. Remote everywhere, plus on-site product roles in India.",
    kind: 'cron',
    // ⚠️ READ OFF vercel.json, NOT CHOSEN HERE. These cards said 09:00 and 09:30 UTC while the
    // crons fired at 03:00 and 03:47 UTC — six hours out, for as long as anyone had been
    // reading the dashboard to work out whether a run had happened yet. IST because that is
    // the clock the schedule was tuned against (see the 09:17 note in lib/pace.ts).
    cadence: 'daily 08:30 IST',
    status: 'live',
    runnable: true,
  },
  {
    id: 'intake',
    name: 'Telegram Intake',
    description: 'Ingests job URLs you DM the bot and tier-classifies them (🟢 form · 🟡 ATS · 🔴 manual).',
    kind: 'webhook',
    cadence: 'on DM',
    status: 'live',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp Watcher',
    description:
      'A linked-device bridge reads your allowlisted job groups; matching posts become tracked URLs or leads. Prepares only — never applies for you.',
    kind: 'webhook',
    cadence: 'on group message',
    status: 'live',
  },
  {
    id: 'tailorer',
    name: 'Resume Tailorer',
    description: 'Per tracked URL: scrape JD → tailor bullets → render PDF → write a cold blurb.',
    kind: 'pipeline',
    cadence: 'per tracked URL',
    status: 'live',
  },
  {
    id: 'funding',
    name: 'Funding Tracker',
    description: 'Watch newly funded startups (TechCrunch) and draft per-company cold outreach.',
    kind: 'cron',
    // Same invocation as the job-mailer card below, hence the same time: Hobby allows two
    // crons and both are taken, so job outreach rides this one. If these two ever disagree,
    // one of them is lying.
    cadence: 'daily 09:17 IST',
    status: 'live',
    runnable: true,
  },
  {
    id: 'formfiller',
    name: 'Form Pre-filler',
    description: 'For a Google Form (🟢), build a pre-filled link from your saved answers. You review and submit — never auto-submitted.',
    kind: 'pipeline',
    cadence: 'per green form',
    status: 'live',
  },
  {
    id: 'mailer',
    name: 'Mailing Agent',
    description: 'Send a funding cold-outreach email to a founder — one explicit send per click, never a batch.',
    kind: 'pipeline',
    cadence: 'per outreach',
    status: 'live',
  },
  {
    id: 'job-mailer',
    name: 'Job Applications',
    description:
      'Finds who posted a discovered job (the address in the post first, Hunter second), drafts the application email, and sends it unattended. Only ever to a named person whose address matches the greeting.',
    kind: 'cron',
    cadence: 'daily 09:17 IST',
    status: 'live',
  },
];

export const LIVE_AGENT_IDS = AGENTS.filter((a) => a.status === 'live').map((a) => a.id);

/**
 * How long a card may claim to be running before it is not believable.
 *
 * ⚠️ A DEAD RUN AND A LIVE ONE USED TO LOOK IDENTICAL, PERMANENTLY. `setAgentRunning` writes
 * `state: 'running'` with no TTL and the matching `recordAgentRun` is the LAST statement in
 * every pass — so a pass the platform kills at its `maxDuration` never records anything, and
 * the card pulses amber for ever. That is the same class of failure as "the cron mailed nobody
 * for four days while reporting ok: true": the dashboard showed a state that could not be
 * distinguished from a healthy one.
 *
 * The ceiling is the longest invocation in the project (`/api/funding`, 300s) plus grace for
 * the gap between the function's clock and the page render's. Past that, no live function is
 * still holding the key, so the run is reported as dead rather than as running. Deliberately
 * generous: calling a live run dead is the worse error of the two, and the next successful run
 * overwrites the record anyway.
 */
const MAX_INVOCATION_MS = 300_000;
const SKEW_GRACE_MS = 120_000;
export const RUN_DEAD_AFTER_MS = MAX_INVOCATION_MS + SKEW_GRACE_MS;

/** `dead`: the record says running, but nothing can still be running it. */
export type RunDisplayState = AgentRun['state'] | 'dead';

export function runDisplayState(run: AgentRun | undefined, now = Date.now()): RunDisplayState {
  if (!run) return 'idle';
  if (run.state !== 'running') return run.state;
  const startedAt = run.startedAt ? Date.parse(run.startedAt) : NaN;
  // A running record with no usable start time cannot be aged, and every writer stamps one —
  // so this is a legacy or hand-written record, and "cannot confirm it is alive" is closer to
  // the truth than a pulsing dot.
  if (Number.isNaN(startedAt)) return 'dead';
  return now - startedAt > RUN_DEAD_AFTER_MS ? 'dead' : 'running';
}
