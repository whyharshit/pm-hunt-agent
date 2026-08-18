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

/**
 * Addresses written into a free-text post.
 *
 * Lives here rather than in lib/whatsapp/match.ts because lib/filters.ts needs it for the
 * internship-pitch path, and match.ts imports filters — putting it there would be a cycle.
 * This module imports nothing, which is exactly why it is the right home for an extractor.
 */
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

export function extractEmails(text: string): string[] {
  return Array.from(new Set(text.match(EMAIL_RE) ?? [])).map((e) => e.toLowerCase());
}
