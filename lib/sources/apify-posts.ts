import { headline, locationOf, posterTag, titleSurvives } from '../postjob';
import { matchWhatsappPost } from '../whatsapp/match';
import type { Job } from '../types';

/**
 * LinkedIn FEED POSTS by keyword search — the thing the user actually reads by hand.
 * Added 2026-08-17, on their instruction, after the diagnosis below.
 *
 * WHAT WAS WRONG
 * `lib/sources/apify.ts` reaches recruiter posts INDIRECTLY: it scrapes the comment feeds of
 * four job-aggregator profiles, on the theory that those aggregators comment on the original
 * posts. It works, and it is a clever trick, but measured 2026-08-17 the whole source yielded
 * **2 posts in a day** — 60 comments mined, 2 of them attached to a hiring post this profile
 * wants. Meanwhile the user opens LinkedIn, searches, and sees dozens.
 *
 * This asks LinkedIn's post search directly, which is the same query the user types.
 *
 * ⚠️ STILL NO COOKIES AND NO ACCOUNT. `harvestapi/linkedin-post-search` is the no-cookies
 * sibling of the actor lib/sources/apify.ts already uses. Cookie-based actors put the account
 * whose cookies they carry at risk of a ban, which is the standing no-AIHawk rule; nothing
 * here authenticates as anybody.
 *
 * 💰 THE BUDGET IS THE DESIGN, AND IT IS ALREADY TIGHT (measured 2026-08-17)
 * Apify FREE is $5/month and the account had **$3.56 of it spent** with $1.44 left. Posts
 * bill $0.002 each, exactly like comments. So this source cannot simply be ADDED to the
 * comment miner — together they would blow the plan in the first week.
 *
 * Therefore: **post search replaces comment mining by default.** `APIFY_MINE_COMMENTS=true`
 * puts the old source back (see lib/discover.ts). Post search is strictly the better half of
 * that trade — same price per item, but each item is a hiring post rather than a comment that
 * might lead to one.
 *
 * ENV
 *   APIFY_TOKEN            — required; unset means this source returns [] silently, like the rest
 *   APIFY_POSTS_PER_RUN    — total posts one run may buy. Cap AND kill switch: 0 = off
 *   APIFY_POST_QUERIES     — comma-separated search queries, overriding DEFAULT_QUERIES
 */
const ACTOR = 'harvestapi~linkedin-post-search';
const ENDPOINT = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items`;

/**
 * What the user types into LinkedIn's search bar, near enough. Kept few and broad: the actor
 * bills per POST returned, so the budget is spent on queries, and a fifth near-duplicate query
 * mostly buys the same posts twice.
 */
const DEFAULT_QUERIES = [
  'hiring product intern',
  'product management internship india',
  "founder's office intern hiring",
  'hiring intern bangalore',
];

/**
 * Posts one run may buy, across ALL queries. Default 40 = $0.08/day = ~$2.40/month, which
 * fits inside the $5 free plan with room for the odd manual run. The actor's own cap is
 * per-query, so this is divided out below — raising it raises the bill linearly.
 */
function postBudget(): number {
  const raw = process.env.APIFY_POSTS_PER_RUN;
  if (raw === undefined || raw.trim() === '') return 40;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

function queries(): string[] {
  const raw = process.env.APIFY_POST_QUERIES?.trim();
  if (!raw) return DEFAULT_QUERIES;
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

/** The Discover cron dies at 60s; a sync Apify run that hangs would take it down. */
const RUN_TIMEOUT_MS = 45_000;

/** Unpaid internships are out (the user wants paid, same rule Internshala's scraper applies). */
const UNPAID_RE = /\bunpaid\b|\bno stipend\b|\bstipend\s*[:\-]?\s*(0|nil|none|unpaid)\b/i;

/**
 * The shape harvestapi returns, verified against a real 5-post run on 2026-08-17 rather than
 * read off the docs — the Hunter domain-finder episode cost a debugging round to exactly that
 * mistake. Items ARE posts here, unlike the comments actor where the post is nested.
 */
type ApifyPost = {
  id?: string;
  linkedinUrl?: string;
  content?: string;
  author?: {
    name?: string;
    info?: string;
    linkedinUrl?: string;
    type?: string;
    website?: string | null;
  };
  postedAt?: { timestamp?: number; date?: string };
};

/** Search LinkedIn posts for hiring posts matching this profile. [] when unconfigured. */
export async function fetchLinkedInPostSearch(): Promise<Job[]> {
  const token = process.env.APIFY_TOKEN;
  const budget = postBudget();
  const qs = queries();
  if (!token || budget === 0 || qs.length === 0) return [];

  // The actor caps per QUERY, so the run-wide budget is divided out. At least 1, or a large
  // query list would silently round every query down to zero posts.
  const perQuery = Math.max(1, Math.floor(budget / qs.length));

  const res = await fetch(`${ENDPOINT}?token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      searchQueries: qs,
      maxPosts: perQuery,
      // The cron is daily, so anything older has already been seen — and `sortBy: date`
      // rather than relevance, because a week-old "relevant" post is a closed role.
      postedLimit: '24h',
      sortBy: 'date',
    }),
    signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
    next: { revalidate: 0 },
  });
  if (!res.ok) {
    throw new Error(`apify post-search ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }

  const items = (await res.json()) as ApifyPost[];
  if (!Array.isArray(items)) throw new Error('apify post-search returned a non-array dataset');

  const jobs: Job[] = [];
  const seen = new Set<string>();

  for (const post of items) {
    const content = post.content?.trim();
    const url = post.linkedinUrl;
    if (!content || !url) continue;
    if (UNPAID_RE.test(content)) continue;

    // Same matcher as the WhatsApp groups and the comment miner. One definition of "what
    // counts as a target role", by rule: two divergent copies is how the Chief-of-Staff bug
    // survived in two places at once.
    const m = matchWhatsappPost(content);
    if (!m.matched || !m.matchedRole) continue;

    const id = `apify:${post.id ?? url}`;
    if (seen.has(id)) continue; // the same post can answer two queries
    seen.add(id);

    const title = headline(m.roleLine, m.matchedRole);
    if (!titleSurvives(title)) continue;

    const applyUrl = m.urls[0];
    jobs.push({
      id,
      source: 'apify',
      title,
      company: post.author?.name?.trim() || 'Unknown',
      location: locationOf(content),
      url,
      ...(applyUrl ? { applyUrl } : {}),
      postedAt: post.postedAt?.date ? new Date(post.postedAt.date) : new Date(),
      // The emails go in tags exactly as the comment miner does it, and since 2026-08-17 they
      // are read back out by lib/job-contact.ts: an address the poster themselves wrote into
      // the post is the best contact this project can ever have, and it costs nothing. The
      // poster's NAME rides along the same way, because it is who the draft will greet.
      tags: [
        posterTag(post.author?.name, post.author?.type),
        post.author?.info,
        ...m.emails,
      ].filter((t): t is string => Boolean(t)),
      description: content.slice(0, 600),
    });
  }

  return jobs;
}
