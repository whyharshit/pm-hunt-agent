import { classifyUrl } from '../classify';
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
 *   APIFY_TOKENS           — comma-separated tokens, pooled; `APIFY_TOKEN` still works.
 *                            Unset means this source returns [] silently, like the rest.
 *   APIFY_POSTS_PER_RUN    — total posts one run may buy, ACROSS all lanes. Cap AND kill
 *                            switch: 0 = off
 *   APIFY_LANES            — which role families to run, e.g. `product,founders`. Default all
 *   APIFY_REQUIRE_CONTACT  — default true: keep only posts naming an address or a form
 *   APIFY_POST_QUERIES     — legacy single-list override; replaces the lanes when set
 *   APIFY_MINE_COMMENTS    — runs the fifth scraper, the comment miner (lib/sources/apify.ts)
 */
const ACTOR = 'harvestapi~linkedin-post-search';
const ENDPOINT = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items`;

/**
 * ONE SCRAPER PER ROLE FAMILY (user's instruction 2026-08-18: "1 for product, 1 for founders
 * office/strategy, 1 for data, 1 for SWE, 1 for mining comments").
 *
 * Why lanes rather than one longer query list: the actor caps posts PER QUERY, so a flat list
 * spends the budget wherever the queries happen to be densest. Product is the profile's best
 * fit and used to share a pot with everything else; splitting the budget by family makes each
 * family's depth a number that can be read and changed, and a lane that yields nothing can be
 * switched off without touching the ones that work.
 *
 * ⚠️ THE QUERIES ARE BIASED TOWARDS POSTS THAT NAME A WAY TO APPLY, which is the other half of
 * the same instruction ("focus on posts with emails or forms instead of normal linkedin
 * listings"). Filtering after the fact cannot save money — every post is billed whether it is
 * kept or not — so the phrasing that Indian hiring posts use when they want a direct
 * application ("share your resume", "drop your CV", "google form") has to be in the QUERY.
 *
 * ⚠️ DATA AND SWE ARE ASKED FOR REMOTE ON PURPOSE, and this is not a style choice. The
 * on-site-in-India allowance is PRODUCT-ONLY, in both `passes()` and the post matcher, so an
 * on-site Bangalore SWE post is dropped after being paid for. Until the user widens that
 * allowance those two lanes can only convert on remote posts, and asking for anything else
 * buys rows that are discarded downstream.
 */
export type PostLane = {
  key: 'product' | 'founders' | 'data' | 'swe' | 'custom';
  queries: string[];
};

export const POST_LANES: PostLane[] = [
  {
    key: 'product',
    queries: [
      'product intern india google form apply',
      'hiring product intern bangalore share your resume',
      'product management intern india drop your cv',
      'hiring product analyst intern india',
    ],
  },
  {
    key: 'founders',
    queries: [
      'startup founders office intern india mail your resume',
      "founder's office intern bangalore hiring",
      'chief of staff intern india hiring',
      'strategy intern india share your resume',
    ],
  },
  {
    key: 'data',
    queries: [
      'remote data analyst intern india share your resume',
      'remote data science intern hiring drop your cv',
      'analytics intern hiring remote google form',
    ],
  },
  {
    key: 'swe',
    queries: [
      'remote software engineer intern india share your resume',
      'remote sde intern hiring drop your cv',
      'backend intern hiring remote resume',
    ],
  },
];


/**
 * Lanes to run this pass. `APIFY_LANES=product,founders` narrows it; empty string = none.
 *
 * `APIFY_POST_QUERIES` predates the lanes and is still honoured as a single override lane,
 * because it is documented as a live switch and may be set in production — quietly ignoring a
 * variable somebody set to steer this source would be worse than not having it.
 */
function enabledLanes(): PostLane[] {
  const custom = process.env.APIFY_POST_QUERIES?.trim();
  if (custom) {
    const queries = custom.split(',').map((q) => q.trim()).filter(Boolean);
    if (queries.length > 0) return [{ key: 'custom', queries }];
  }

  const raw = process.env.APIFY_LANES;
  if (raw === undefined) return POST_LANES;
  const want = new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
  return POST_LANES.filter((l) => want.has(l.key));
}

/**
 * Apify tokens, pooled exactly like the Gemini and Hunter keys and for the same reason: the
 * free plan is $5 of usage per ACCOUNT, so two accounts are $10 and one account entered twice
 * is still $5. Lanes are handed tokens round-robin, so with four tokens each lane bills a
 * different account and one exhausted plan cannot stop the others.
 */
export function apifyTokens(): string[] {
  const raw = [process.env.APIFY_TOKENS ?? '', process.env.APIFY_TOKEN ?? ''].join(',');
  return [...new Set(raw.split(/[,\s]+/).map((t) => t.trim()).filter(Boolean))];
}

/**
 * Posts one run may buy, across ALL lanes. Default 40 = $0.08/day = ~$2.40/month, which fits
 * inside a single $5 free plan. The actor's cap is per-query, so this is divided by lane and
 * then by that lane's queries — raising it raises the bill linearly.
 */
function postBudget(): number {
  const raw = process.env.APIFY_POSTS_PER_RUN;
  if (raw === undefined || raw.trim() === '') return 40;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Keep only posts that name a way to apply directly — an address, a Google Form, or an ATS
 * link. ON by default (user's instruction), because a post whose only route is LinkedIn's own
 * Easy Apply is the same stale listing the boards already supply 119 of a day, and it can
 * never be emailed.
 *
 * `APIFY_REQUIRE_CONTACT=false` keeps everything, which is worth doing for one run if the
 * lanes ever go quiet: it distinguishes "the queries found nothing" from "this filter ate it".
 */
export function apifyRequireContact(): boolean {
  return !/^(0|false|no)$/i.test(process.env.APIFY_REQUIRE_CONTACT ?? 'true');
}

/**
 * How far back a lane looks. DEFAULT `week`, and that default is measured, not assumed:
 * the shipped queries returned 2 posts at `24h` and 18 at `week`, so the two move together.
 *
 * WARNING: IT IS ALSO THE BINDING CONSTRAINT ON NARROW QUERIES, measured 2026-08-18. Four
 * specific India-phrased queries returned **2 posts in total** at 24h, against 27 for the broad
 * lane queries - LinkedIn does not produce many posts matching "product intern india google
 * form apply" on any given day. So the choice is broad-and-recent (which buys global
 * virtual-internship spam) or narrow-with-a-wider-window.
 *
 * Widening costs money in a way that is easy to miss: `seen:ids` dedupes rows AFTER purchase,
 * so a 7d window on a daily cron re-buys the same posts up to seven times. Only widen
 * alongside a narrower query set, where the daily volume is small enough for that to be cheap.
 */
const POSTED_LIMITS = ['any', '1h', '24h', 'week', 'month'] as const;

function postedLimit(): string {
  const raw = process.env.APIFY_POSTED_LIMIT?.trim().toLowerCase();
  // The actor validates this server-side and rejects anything else with a 400, so an
  // unrecognised value must fall back rather than be sent. Learned by sending '7d' and having
  // the run refused: the allowed set is exactly the list above, not a duration expression.
  return raw && (POSTED_LIMITS as readonly string[]).includes(raw) ? raw : 'week';
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

/** Per-lane outcome, so a check script can show where the money went. */
export type LaneStat = {
  lane: PostLane['key'];
  /** Accounts walked before one answered. >1 means a plan ran dry and failover worked. */
  accountsWalked: number;
  bought: number;
  matched: number;
  /** Matched the role, but gave no address and no form — the `requireContact` drop. */
  noContact: number;
  error?: string;
};

/** One lane: buy its posts and turn the usable ones into rows. */
/**
 * Out of monthly usage, or the token is refused — either way, try the next account.
 *
 * Apify answers an exhausted plan with 402, and 401/403 for a revoked or wrong token. The
 * body check catches the same condition arriving as a 400 with prose, which is how the actor
 * reports it when the run is rejected before it starts.
 */
export function isTokenExhausted(status: number, body: string): boolean {
  // ⚠️ STATUS FIRST, AND 400 IS NEVER EXHAUSTION. The body check used to run on any status and
  // matched the word "limit" — which appears in the actor's own validation message for the
  // `postedLimit` field. One malformed input therefore looked like eight dead accounts and
  // walked the whole pool before reporting "every apify token exhausted", hiding the real
  // error. A 400 is our bug and repeats identically on every token.
  if (status === 400) return false;
  if (status === 401 || status === 402 || status === 403 || status === 429) return true;
  return /monthly usage|usage limit|exceeded|insufficient|out of credit|quota|payment required/i.test(
    body
  );
}

/**
 * One lane: buy its posts and turn the usable ones into rows.
 *
 * ⚠️ TAKES THE WHOLE TOKEN POOL, NOT ONE TOKEN. Round-robin assignment alone was fine while
 * tokens were scarce, but with 8 accounts and 4 lanes it would leave half the pool idle and
 * still fail the moment a lane's own account ran dry — the free plan is $5 per ACCOUNT, so an
 * unusable balance elsewhere in the pool is real money left on the table. Each lane STARTS at
 * its own offset so the lanes spread across accounts, then walks the rest on exhaustion.
 */
async function runLane(
  lane: PostLane,
  tokens: string[],
  startAt: number,
  laneBudget: number,
  stat: LaneStat
): Promise<Job[]> {
  // The actor caps per QUERY, so the lane budget is divided out. At least 1, or a lane with
  // many queries would silently round every one of them down to zero posts.
  const perQuery = Math.max(1, Math.floor(laneBudget / lane.queries.length));

  let res: Response | null = null;
  let lastError = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[(startAt + i) % tokens.length];
    const attempt = await fetch(`${ENDPOINT}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        searchQueries: lane.queries,
        maxPosts: perQuery,
        postedLimit: postedLimit(),
        // `date` rather than relevance: a week-old "relevant" post is a closed role.
        sortBy: 'date',
      }),
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      next: { revalidate: 0 },
    });
    if (attempt.ok) {
      res = attempt;
      stat.accountsWalked = i + 1;
      break;
    }
    const body = (await attempt.text()).slice(0, 200);
    lastError = `apify post-search ${attempt.status}: ${body}`;
    // A real fault — a bad actor name, a malformed input — repeats identically on every
    // token, so failing over would just spend the same error eight times.
    if (!isTokenExhausted(attempt.status, body)) throw new Error(lastError);
  }
  if (!res) throw new Error(`every apify token exhausted or refused · ${lastError}`);

  const items = (await res.json()) as ApifyPost[];
  if (!Array.isArray(items)) throw new Error('apify post-search returned a non-array dataset');
  stat.bought = items.length;

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

    // A DIRECT WAY TO APPLY, which is what separates these rows from the 119 board listings a
    // day. `classifyUrl` already ranks apply targets for the WhatsApp bridge: green is a
    // Google Form, yellow an ATS, red everything else — including a link back to LinkedIn's
    // own listing, which is precisely the thing this source exists NOT to collect.
    const forms = m.urls.filter((u) => classifyUrl(u) !== 'red');
    if (m.emails.length === 0 && forms.length === 0) {
      stat.noContact += 1;
      if (apifyRequireContact()) continue;
    }
    stat.matched += 1;

    // A form beats any other link: it is the thing the poster wants filled in, and it is what
    // the tailoring pipeline can prefill. Falling back to the first URL keeps the old
    // behaviour for posts whose route is an ATS page this classifier has not learned.
    const applyUrl = forms[0] ?? m.urls[0];
    jobs.push({
      id,
      source: 'apify',
      title,
      company: post.author?.name?.trim() || 'Unknown',
      location: locationOf(content),
      url,
      ...(applyUrl ? { applyUrl } : {}),
      postedAt: post.postedAt?.date ? new Date(post.postedAt.date) : new Date(),
      // The emails go in tags exactly as the comment miner does it, and they are read back out
      // by lib/job-contact.ts: an address the poster themselves wrote into the post is the best
      // contact this project can ever have, and it costs nothing. The poster's NAME rides along
      // the same way, because it is who the draft will greet. The lane is tagged too, so a
      // dashboard row says which scraper paid for it.
      tags: [
        posterTag(post.author?.name, post.author?.type),
        post.author?.info,
        `lane:${lane.key}`,
        ...m.emails,
      ].filter((t): t is string => Boolean(t)),
      description: content.slice(0, 600),
    });
  }

  return jobs;
}

/**
 * Search LinkedIn posts for hiring posts matching this profile, one lane per role family.
 * [] when unconfigured.
 *
 * Lanes run in PARALLEL. Discover is already at its 60s ceiling with unstop measured at ~59.9s
 * locally, so four sequential 45s actor runs would take the whole cron down; in parallel the
 * source still costs one run's wall-clock. `stats` is an optional sink so a check script can
 * report where the budget went without this function having to log.
 */
export async function fetchLinkedInPostSearch(stats?: LaneStat[]): Promise<Job[]> {
  const tokens = apifyTokens();
  const budget = postBudget();
  const lanes = enabledLanes();
  if (tokens.length === 0 || budget === 0 || lanes.length === 0) return [];

  const perLane = Math.max(1, Math.floor(budget / lanes.length));

  const settled = await Promise.allSettled(
    lanes.map((lane, i) => {
      const stat: LaneStat = { lane: lane.key, accountsWalked: 0, bought: 0, matched: 0, noContact: 0 };
      stats?.push(stat);
      // Each lane starts on a different account and fails over through the rest, so N tokens
      // are N × $5 of real budget rather than N labels on the same spend.
      return runLane(lane, tokens, i, perLane, stat).catch((e) => {
        stat.error = (e as Error).message;
        throw e;
      });
    })
  );

  // One lane failing must not lose the others. A lane that threw is recorded in its stat and
  // surfaces through the check script; Discover's own `safe()` wrapper only sees a throw if
  // EVERY lane fails, which is the case that really is a source outage.
  const jobs = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
  if (jobs.length === 0 && settled.every((r) => r.status === 'rejected')) {
    throw new Error(
      settled
        .map((r) => (r.status === 'rejected' ? (r.reason as Error).message : ''))
        .filter(Boolean)
        .join(' · ')
    );
  }

  // The same post can be bought by two lanes ("product intern" and "founder's office intern"
  // overlap constantly), and two rows for one post would be two applications.
  const byId = new Map<string, Job>();
  for (const j of jobs) if (!byId.has(j.id)) byId.set(j.id, j);
  return [...byId.values()];
}
