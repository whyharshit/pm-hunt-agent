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
    description: 'Pulls remote intern roles (product/ops/data/VC/AI) from RemoteOK + We Work Remotely + HN Who\'s Hiring + Internshala + LinkedIn-via-Serper, filters them, and saves new matches.',
    kind: 'cron',
    cadence: 'daily 09:00 UTC',
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
    cadence: 'daily 09:30 UTC',
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
];

export const LIVE_AGENT_IDS = AGENTS.filter((a) => a.status === 'live').map((a) => a.id);
