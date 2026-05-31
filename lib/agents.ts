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
    description: 'Pulls remote intern/PM roles from job boards, filters them, and saves new matches.',
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
    description: 'Watch newly funded startups and surface them for cold outreach.',
    kind: 'cron',
    status: 'planned',
  },
  {
    id: 'hn',
    name: "HN Who's Hiring",
    description: 'Parse the monthly "Ask HN: Who is hiring?" thread for remote roles.',
    kind: 'cron',
    status: 'planned',
  },
  {
    id: 'mailer',
    name: 'Mailing Agent',
    description: 'Send tailored applications and outreach via email (Resend/Sendgrid).',
    kind: 'pipeline',
    status: 'planned',
  },
];

export const LIVE_AGENT_IDS = AGENTS.filter((a) => a.status === 'live').map((a) => a.id);
