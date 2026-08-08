import * as cheerio from 'cheerio';
import { urlId } from '../storage';

/**
 * TechCrunch funding announcements.
 *
 * ⚠️ `/tag/funding/feed/` — the original single source here — is effectively DEAD.
 * Measured 2026-08-08: 20 items spanning 17 months (2025-02 → 2026-07), newest a month
 * old. TechCrunch stopped tagging posts with it, so the daily cron was scanning a feed
 * that produced roughly one new item a month while reporting "ok". The whole point of the
 * agent is congratulating founders on a RECENT raise, so a stale feed doesn't degrade the
 * output, it invalidates it — you cannot congratulate someone on a round from March 2025.
 *
 * The live replacements are the CATEGORY feeds (same date, measured):
 *   category/venture/feed/   → 18 items over ~2 weeks, funding-dense
 *   category/startups/feed/  → 19 items over ~3 days, broader
 * `category/fundings-exits/feed/` is a 404 — don't reach for it.
 *
 * Both category feeds carry non-funding posts (Disrupt ticket promos, opinion pieces,
 * acquisitions, VC-firm news), so the raise gate below runs BEFORE the rows are handed to
 * Gemini. That ordering matters: the mis-extracted rows sitting in prod — "North America",
 * "Bono", "NEA", "Amazon's Alexa Fund" — are all Gemini being asked "which company raised
 * money?" about an article where nobody did. Gate first, extract second.
 */
const FEED_URLS = [
  'https://techcrunch.com/category/venture/feed/',
  'https://techcrunch.com/category/startups/feed/',
  // Kept for continuity: near-dead, but it costs one request and occasionally carries a
  // funding post the category feeds missed. Its stale items die on the recency gate.
  'https://techcrunch.com/tag/funding/feed/',
];

const FEED_TIMEOUT_MS = 12_000;

/**
 * "Recently funded" is the entire premise of the outreach, so age is a hard gate, not a
 * sort key. 45 days is generous enough to survive a quiet fortnight in the feed while
 * keeping every draft honest.
 */
export const MAX_AGE_DAYS = 45;

/** A startup taking money. Requires the money too — "raises awareness" is not a round. */
const RAISE_RE =
  /\b(raise[sd]?|raising|secure[sd]?|land[sd]?|nab[sd]?|closes?|closed|bags?|pockets?|backs?|invests?\s+in|funding|funded|round|seed|series\s+[a-k]\b|pre-seed)\b/i;

/** The amount, a valuation, or an explicitly named round — filters out "raises questions". */
const MONEY_RE =
  /([$€£₹]\s?\d|\b\d+(\.\d+)?\s?(million|billion|crore|lakh)\b|\b(pre-seed|seed|series\s+[a-k])\b)/i;

/**
 * Not a startup raising money. Three classes, all seen live in these feeds:
 *  - VC firms raising their OWN funds ("Index Ventures raises $2B across three funds") —
 *    a fund is not a company that hires interns, and its "founder" is a GP.
 *  - Acquisitions and exits ("Klaviyo acquires…", "Bending Spoons to buy Airtable").
 *  - TechCrunch's own event marketing, which floods the startups feed.
 */
const NOT_A_STARTUP_RAISE_RE = new RegExp(
  [
    // VC firms / funds — the subject raising is an investor, not a portfolio company.
    String.raw`\b(ventures?|capital|partners|fund|funds|lp|limited\s+partners)\s+(raise[sd]?|closes?|closed|launch(es|ed)?)`,
    // `.` not `[^.]` here: amounts carry decimal points ("closes on $6.2B across two
    // funds"), and excluding them stopped the rule reaching the word it keys on.
    String.raw`\b(raises?|closes?|launch(es|ed)?)\s+.{0,40}\b(fund|funds)\b`,
    String.raw`\backs?\s+(a\s+)?(new\s+)?fund\b`,
    // An investor name sitting next to the word "fund" — "Anicut Capital, Chennai Angels
    // Partner for ₹175 Crore Seed Fund" has no raise verb at all, so the rules above
    // never fire, yet "Seed" + "₹175 Crore" is enough to look like a round.
    String.raw`\b(capital|ventures?|partners|angels|lp)\b.{0,60}\bfunds?\b`,
    String.raw`\bfunds?\b.{0,60}\b(capital|ventures?|partners|angels|lp)\b`,
    // Not raised yet. Congratulating a founder on a round that is still a rumour is worse
    // than staying quiet — "Zanskar In Talks To Raise $6 Mn", "reportedly raising".
    String.raw`\b(in\s+talks\s+to|plans\s+to|planning\s+to|set\s+to|looking\s+to|aims?\s+to|seeks?\s+to|to)\s+raise\b`,
    String.raw`\breportedly\s+(raising|in\s+talks|seeking)\b`,
    // Exits / M&A.
    String.raw`\b(acquires?|acquisition|to\s+buy|buys|merges?|merger|ipo|goes?\s+public|spac)\b`,
    // TechCrunch house ads.
    String.raw`\b(disrupt|side\s+event|founder\s+summit|ticket|exhibit|battlefield|apply\s+to\s+run)\b`,
  ].join('|'),
  'i'
);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export type FundingRaw = {
  sourceId: string;
  title: string;
  summary: string;
  url: string;
  postedAt: string;
};

function clean(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#8217;|&#8216;|&#039;|&apos;/g, "'")
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&#8211;|&#8212;/g, '–')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Is this item a startup announcing a raise? Judged on the TITLE, with the summary used
 * only to supply a missing amount — the same title-anchored discipline as lib/filters.ts,
 * because a body paragraph mentioning "$40M" says nothing about what the article is about.
 */
export function isStartupRaise(title: string, summary: string): boolean {
  if (NOT_A_STARTUP_RAISE_RE.test(title)) return false;
  if (!RAISE_RE.test(title)) return false;
  return MONEY_RE.test(title) || MONEY_RE.test(summary);
}

function parseFeed(xml: string): FundingRaw[] {
  const $ = cheerio.load(xml, { xmlMode: true });
  const items: FundingRaw[] = [];

  $('item').each((_, el) => {
    const item = $(el);
    const title = clean(item.find('title').first().text());
    const link = item.find('link').first().text().trim() || item.find('guid').first().text().trim();
    const pub = item.find('pubDate').first().text().trim();
    const summary = clean(item.find('description').first().text()).slice(0, 600);
    if (!title || !link) return;
    const postedAt = pub ? new Date(pub).toISOString() : new Date().toISOString();
    items.push({ sourceId: urlId(link), title, summary, url: link, postedAt });
  });

  return items;
}

async function fetchFeed(url: string): Promise<FundingRaw[]> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/rss+xml,application/xml,text/xml' },
    signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return parseFeed(await res.text());
}

export type FundingFetchStats = {
  fetched: number;
  afterRaiseGate: number;
  afterAgeGate: number;
  perFeed: Record<string, number>;
  errors: string[];
};

/**
 * Fetch every feed in parallel, keep only fresh startup raises, dedupe by URL.
 * One dead feed never takes the run down — a feed that throws contributes nothing and is
 * reported in `errors`, exactly like the Discover sources.
 */
export async function fetchTechCrunchFundingDetailed(): Promise<{
  items: FundingRaw[];
  stats: FundingFetchStats;
}> {
  const settled = await Promise.allSettled(FEED_URLS.map((u) => fetchFeed(u)));

  const perFeed: Record<string, number> = {};
  const errors: string[] = [];
  const all: FundingRaw[] = [];

  settled.forEach((r, i) => {
    const name = FEED_URLS[i].replace('https://techcrunch.com/', '').replace(/\/feed\/$/, '');
    if (r.status === 'fulfilled') {
      perFeed[name] = r.value.length;
      all.push(...r.value);
    } else {
      perFeed[name] = 0;
      errors.push(`${name}: ${(r.reason as Error).message}`);
    }
  });

  const byId = new Map<string, FundingRaw>();
  for (const item of all) if (!byId.has(item.sourceId)) byId.set(item.sourceId, item);
  const deduped = [...byId.values()];

  const raises = deduped.filter((r) => isStartupRaise(r.title, r.summary));

  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const fresh = raises.filter((r) => {
    const t = Date.parse(r.postedAt);
    return Number.isNaN(t) ? true : t >= cutoff;
  });

  fresh.sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));

  return {
    items: fresh,
    stats: {
      fetched: deduped.length,
      afterRaiseGate: raises.length,
      afterAgeGate: fresh.length,
      perFeed,
      errors,
    },
  };
}

export async function fetchTechCrunchFunding(): Promise<FundingRaw[]> {
  const { items } = await fetchTechCrunchFundingDetailed();
  return items;
}
