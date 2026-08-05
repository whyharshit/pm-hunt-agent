import { HARD_REJECT_TITLE_PATTERNS, INTERN_PATTERNS, ROLE_PATTERNS } from '../filters';
import { matchWhatsappPost } from '../whatsapp/match';
import type { Job } from '../types';

// LinkedIn recruiter posts, mined indirectly through job-aggregator COMMENT feeds.
//
// The idea (the user's): the big Indian job aggregators run paid dashboards, but they
// find their listings by commenting "added to our dashboard" on recruiters' ORIGINAL
// posts. Scraping an aggregator's comment feed therefore surfaces the original posts —
// the same leads, at the source, for free.
//
// Actor: harvestapi/linkedin-profile-comments. Chosen specifically because it needs NO
// cookies and no LinkedIn account — cookie-based actors put the account whose cookies
// they use at risk, and the standing no-AIHawk / no-account-risk rule still holds. We
// never authenticate to LinkedIn; we read public pages through Apify.
//
// Requires BOTH env vars. Missing either returns [] silently — an unset optional source
// must not put a daily error on the agent card.
//   APIFY_TOKEN               — apify.com API token
//   APIFY_LINKEDIN_PROFILES   — comma-separated aggregator profile URLs
const ACTOR = 'harvestapi~linkedin-profile-comments';
const ENDPOINT = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items`;

// Cost control, and it is tight. The actor bills $0.002 per comment and the free plan
// carries $5/month, so the daily cron costs `profiles × MAX_ITEMS × $0.06` per month:
// 4 profiles × 15 = $3.60/month, which fits. At 20 it would be $4.80 — inside the plan
// on paper, but with no headroom for a re-run or a fifth profile. Raise only alongside
// the plan, and check here first if Apify credit runs out unexpectedly.
const MAX_ITEMS_PER_PROFILE = 15;

// A dashboard row needs a headline, not a paragraph.
const MAX_TITLE_CHARS = 110;

// The Discover cron runs on Vercel Hobby, where a function is killed at 60s. A sync
// Apify run that hangs would take the whole cron down with it, so it is bounded well
// short of that; safe() in runDiscovery turns a timeout into one line in the summary.
const RUN_TIMEOUT_MS = 45_000;

type ApifyComment = {
  createdAt?: string;
  post?: {
    linkedinUrl?: string;
    content?: string;
    author?: { name?: string; info?: string; linkedinUrl?: string };
  };
};

const isIntern = (s: string) => INTERN_PATTERNS.some((re) => re.test(s));
const isRole = (s: string) => ROLE_PATTERNS.some((re) => re.test(s));
const isRejected = (s: string) => HARD_REJECT_TITLE_PATTERNS.some((re) => re.test(s));

/**
 * Pick a headline for the dashboard.
 *
 * matchWhatsappPost tests the whole reconstructed role line before its split parts, so
 * when that whole line carries both signals it is returned verbatim — which for a chatty
 * LinkedIn post is a three-line paragraph, useless as a row title. Narrow it back down to
 * the shortest self-sufficient fragment, then fall back through progressively looser
 * options. Whatever comes out must still satisfy Discover's title-anchored `passes()`,
 * which re-tests the title alone, so a fragment is only accepted when it carries the
 * signals by itself.
 */
function headline(roleLine: string, matchedRole: string): string {
  const fragments = roleLine
    .split(/\s+·\s+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const selfSufficient = fragments
    .filter((f) => isIntern(f) && isRole(f) && !isRejected(f))
    .sort((a, b) => a.length - b.length)[0];

  const chosen = selfSufficient ?? matchedRole;
  return chosen.length > MAX_TITLE_CHARS ? `${chosen.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…` : chosen;
}

function profiles(): string[] {
  return (process.env.APIFY_LINKEDIN_PROFILES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Mine aggregator comment feeds for the recruiter posts underneath. [] when unconfigured. */
export async function fetchLinkedInPostsViaApify(): Promise<Job[]> {
  const token = process.env.APIFY_TOKEN;
  const profileUrls = profiles();
  if (!token || profileUrls.length === 0) return [];

  const res = await fetch(`${ENDPOINT}?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ profiles: profileUrls, maxItems: MAX_ITEMS_PER_PROFILE }),
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    next: { revalidate: 0 },
  });
  if (!res.ok) {
    throw new Error(`apify ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const items = (await res.json()) as ApifyComment[];
  if (!Array.isArray(items)) throw new Error('apify returned a non-array dataset');

  const jobs: Job[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const post = item.post;
    const content = post?.content?.trim();
    const url = post?.linkedinUrl;
    if (!content || !url) continue;

    // A LinkedIn post has no title field, exactly like a WhatsApp group post — so it
    // goes through the same matcher rather than a second, divergent copy of "what
    // counts as a target role". That shared-bank discipline is what kept the
    // Chief-of-Staff bug from surviving in two places.
    const m = matchWhatsappPost(content);
    if (!m.matched || !m.matchedRole) continue;

    const id = `apify:${url.match(/activity[:-](\d+)/)?.[1] ?? url}`;
    if (seen.has(id)) continue; // several aggregators comment on the same post
    seen.add(id);

    const title = headline(m.roleLine, m.matchedRole);
    // Guard the contract with Discover: `passes()` re-tests the title on its own, so a
    // headline that lost a signal during narrowing would be silently dropped downstream.
    if (!isIntern(title) || !isRole(title) || isRejected(title)) continue;

    const applyUrl = m.urls[0];
    jobs.push({
      id,
      source: 'apify',
      title,
      company: post?.author?.name?.trim() || 'Unknown',
      // The matcher already confirmed a remote signal in the body; naming it here keeps
      // the Discover remote gate agreeing with the decision that got us this far.
      location: 'Remote',
      url,
      ...(applyUrl ? { applyUrl } : {}),
      postedAt: item.createdAt ? new Date(item.createdAt) : new Date(),
      tags: [post?.author?.info, ...m.emails].filter((t): t is string => Boolean(t)),
      description: content.slice(0, 600),
    });
  }

  return jobs;
}
