import * as cheerio from 'cheerio';
import type { Job } from '../types';

/**
 * LinkedIn's own PUBLIC job-search endpoint — the one the logged-out jobs page calls to
 * paginate its results. Added 2026-08-17.
 *
 * WHY THIS EXISTS ALONGSIDE lib/sources/linkedin.ts
 * That source asks GOOGLE (via serper.dev) for pages that happen to be LinkedIn job posts.
 * Measured the day this was written: 27 rows, mostly US (Amtrak, TikTok, US private equity),
 * and **17 of them with `company: "Unknown"`** because a Google result title only sometimes
 * carries the "X hiring Y" shape. A row with no company can never be enriched into an
 * address, so it can never be mailed — it is a link on a dashboard and nothing more.
 *
 * This endpoint returns LinkedIn's own rendered cards, so every row has a real company, a
 * real location and a real posting date, and the whole search can be pinned to India. That is
 * what makes these rows usable by the outreach pipeline rather than merely visible.
 *
 * ⚠️ NO ACCOUNT, NO COOKIES, NO LOGIN. This is the logged-out endpoint, fetched exactly as a
 * signed-out browser fetches it. That is deliberate and non-negotiable: the standing
 * no-AIHawk rule bans anything that drives or authenticates a LinkedIn account, because the
 * risk it carries is a ban on the user's real profile. Nothing here touches an account.
 *
 * ⚠️ It is UNOFFICIAL and it rate-limits. Rapid sequential requests get the connection reset
 * (measured: 2 of 8 requests died with ECONNRESET at ~0s spacing). Hence the pacing, the
 * single retry, and the fact that a failed page is skipped rather than throwing.
 */
const ENDPOINT = 'https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * One query per target function, mirroring lib/filters.ts. `location: India` is the whole
 * point of this source — it is the only one that can ask for Indian jobs directly, and since
 * 2026-08-17 an on-site product internship in India passes the filters.
 *
 * Keywords are deliberately NOT suffixed with "remote": the filters decide that, and asking
 * for it here is precisely what made the serper source return US-only rows.
 */
const QUERIES = [
  'product management intern',
  'product intern',
  'associate product manager',
  'software engineer intern',
  'data analyst intern',
  'machine learning intern',
  "founder's office",
];

/** Past week. The cron is daily and ids dedupe, so a wider window only recovers late posts. */
const POSTED_WINDOW = 'r604800';

/**
 * Pages per query. Each returns ~10 cards, and page 2 was measurably still full — but every
 * page is another request against an endpoint that resets connections, and this source shares
 * the Discover cron's 60s ceiling with twelve others. Two is the honest compromise; raise it
 * only alongside the deadline below.
 */
const PAGES_PER_QUERY = 2;
const PAGE_SIZE = 25;

/** Gap between requests. At zero spacing 2 of 8 requests came back ECONNRESET. */
const PACE_MS = 1_200;

/**
 * Wall-clock ceiling. Discover runs all thirteen sources under one `Promise.all` inside a
 * 60s function, so this source's budget is what it may add to the SLOWEST path, not what is
 * left over. Stopping early costs a few rows; overrunning kills the whole discovery run.
 */
const DEADLINE_MS = 30_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One page of cards, or null if LinkedIn refused it. Never throws — a dead page is normal. */
async function fetchPage(keywords: string, start: number): Promise<string | null> {
  const url =
    `${ENDPOINT}?keywords=${encodeURIComponent(keywords)}` +
    `&location=India&f_TPR=${POSTED_WINDOW}&start=${start}`;

  // One retry, because the failure mode here is a reset connection rather than a refusal:
  // the same URL that dies at 0s spacing succeeds a second later.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'user-agent': UA, accept: 'text/html' },
        signal: AbortSignal.timeout(10_000),
        next: { revalidate: 0 },
      });
      // 429 means we are being throttled; retrying immediately makes it worse.
      if (res.status === 429) return null;
      if (!res.ok) return null;
      return await res.text();
    } catch {
      if (attempt === 0) await sleep(PACE_MS);
    }
  }
  return null;
}

/** Collapse LinkedIn's heavily whitespaced card text. */
const clean = (s: string) => s.replace(/\s+/g, ' ').trim();

function parseCards(html: string, into: Map<string, Job>): void {
  const $ = cheerio.load(html);

  $('div.base-card').each((_, el) => {
    const card = $(el);
    const urn = card.attr('data-entity-urn') ?? '';
    const jobId = urn.match(/jobPosting:(\d+)/)?.[1];
    if (!jobId) return;

    // Shared id space with lib/sources/linkedin.ts on purpose: the serper source keys the
    // same postings as `linkedin:<jobId>`, so a job both sources see is ONE row, not two.
    const id = `linkedin:${jobId}`;
    if (into.has(id)) return;

    const title = clean(card.find('.base-search-card__title').first().text());
    const company = clean(card.find('.base-search-card__subtitle').first().text());
    const location = clean(card.find('.job-search-card__location').first().text());
    const href = card.find('a.base-card__full-link').first().attr('href') ?? '';
    if (!title || !href) return;

    // The tracking query string is longer than the URL and changes every fetch, which would
    // make the same posting look different run to run in any log that records the link.
    const url = href.split('?')[0];
    const datetime = card.find('time[datetime]').first().attr('datetime');

    into.set(id, {
      id,
      source: 'linkedin',
      title,
      company: company || 'Unknown',
      location: location || 'India',
      url,
      postedAt: datetime ? new Date(datetime) : new Date(),
      tags: [],
    });
  });
}

/**
 * Fetch Indian job postings straight from LinkedIn's logged-out search. Returns whatever it
 * managed to read; throws only if LinkedIn refused every single request, which is the one
 * case worth a red mark on the agent card (the endpoint is unofficial and could vanish).
 */
export async function fetchLinkedInGuest(): Promise<Job[]> {
  const deadline = Date.now() + DEADLINE_MS;
  const jobs = new Map<string, Job>();
  let attempted = 0;
  let refused = 0;

  for (const q of QUERIES) {
    for (let page = 0; page < PAGES_PER_QUERY; page += 1) {
      if (Date.now() > deadline) {
        // Out of time, not out of results. Returning what we have beats taking the whole
        // Discover run down with us.
        return [...jobs.values()];
      }

      attempted += 1;
      const html = await fetchPage(q, page * PAGE_SIZE);
      if (html === null) {
        refused += 1;
      } else {
        const before = jobs.size;
        parseCards(html, jobs);
        // An empty page means this query is spent; the next page will be empty too.
        if (jobs.size === before && page > 0) break;
      }
      await sleep(PACE_MS);
    }
  }

  if (jobs.size === 0 && refused === attempted && attempted > 0) {
    throw new Error(`linkedin guest endpoint refused all ${attempted} requests`);
  }

  return [...jobs.values()];
}
