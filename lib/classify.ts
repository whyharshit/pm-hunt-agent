export type Tier = 'green' | 'yellow' | 'red';

export const TIER_EMOJI: Record<Tier, string> = {
  green: '🟢',
  yellow: '🟡',
  red: '🔴',
};

const YELLOW_HOSTS = [
  'lever.co',
  'greenhouse.io',
  'boards.greenhouse.io',
  'jobs.lever.co',
  'ashbyhq.com',
  'jobs.ashbyhq.com',
  'workable.com',
  'apply.workable.com',
  'jobs.workable.com',
];

export function classifyUrl(url: string): Tier {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'red';
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  if (host === 'docs.google.com' && path.startsWith('/forms/')) return 'green';
  if (host === 'forms.gle') return 'green';
  if (YELLOW_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return 'yellow';
  return 'red';
}

export function extractUrls(text: string): string[] {
  if (!text) return [];
  const re = /https?:\/\/[^\s<>"']+/g;
  const matches = text.match(re) ?? [];
  return Array.from(new Set(matches.map((u) => u.replace(/[.,;:)\]]+$/, ''))));
}
