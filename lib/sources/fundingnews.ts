import * as cheerio from 'cheerio';
import { urlId } from '../storage';
import { isStartupRaise, type FundingRaw } from './techcrunch';

/**
 * Two more funding feeds beyond TechCrunch, both aimed at the raises that actually suit an
 * intern ask: early-stage and India-heavy. TechCrunch skews to mega-rounds — a $1.37B
 * defense raise is a worse cold-outreach target than a ₹8 Cr seed round.
 *
 *   googlenews — free, no key. Google News RSS search.
 *   serper     — needs SERPER_API_KEY (serper.dev free tier). [] until set, silently,
 *                same contract as every other optional key in this repo.
 *
 * ⚠️ GOOGLE NEWS LINKS DO NOT RESOLVE SERVER-SIDE. The RSS `<link>` is a
 * `news.google.com/rss/articles/CBMi…` interstitial that only redirects via JavaScript —
 * verified 2026-08-08: fetching it returns 200 and 598KB of Angular, no target URL in the
 * HTML, and the id is no longer a plain base64 of the article URL. Recovering it needs
 * Google's private `batchexecute` endpoint, which is the same reverse-engineer-a-bundle
 * work this repo rejected for AICTE. The link opens correctly in a BROWSER, which is what
 * the user needs, so it is stored as-is — but `findContact` cannot scrape it, and
 * lib/contact.ts short-circuits those rows instead of burning a Gemini call on Angular.
 * Serper rows carry real publisher URLs and go through the full contact pipeline.
 */

const GOOGLE_NEWS = 'https://news.google.com/rss/search';
const SERPER_ENDPOINT = 'https://google.serper.dev/news';
const TIMEOUT_MS = 12_000;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * `when:7d` bounds each query to the past week at Google's end, so the age gate downstream
 * has little left to do. India first — that is where a remote intern ask actually lands —
 * then a global early-stage sweep.
 */
const NEWS_QUERIES = [
  'Indian startup raises seed OR "pre-seed" funding when:7d',
  'India startup raises "series A" funding when:7d',
  'startup raises seed round when:7d',
];

/**
 * ⚠️ PLAIN KEYWORDS ONLY. Serper's free tier rejects search operators with
 * `400 "Query pattern not allowed for free accounts"` — quoted phrases and `OR` both
 * trip it (measured 2026-08-08: `"raises" "series A" startup funding announcement` was
 * refused while the same words unquoted worked). Every query below was verified live to
 * return 10 results with 100% direct publisher URLs.
 *
 * 💰 One credit per query = 5/run ≈ 150/month against the free tier's ~2,500.
 */
const SERPER_QUERIES = [
  'startup raises seed funding',
  'Indian startup raises funding round',
  'startup raises series A funding',
  'startup raises pre-seed funding India',
  'startup secures seed round India',
];

/** Google News appends " - Publisher" to every headline; the raise gate keys on the title. */
function stripPublisher(title: string, publisher: string): string {
  if (publisher && title.endsWith(` - ${publisher}`)) {
    return title.slice(0, -(publisher.length + 3)).trim();
  }
  return title.replace(/\s+-\s+[^-]{2,40}$/, '').trim();
}

function decode(s: string): string {
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
 * Words that appear before a company name in funding headlines and are never the name
 * itself. Without these, "Legal AI startup NYAI raises…" keys on "startup".
 */
const DESCRIPTOR_WORDS = new Set([
  'a', 'an', 'the', 'this', 'its', 'new', 'india', 'indian', 'us', 'uk', 'saudi', 'bulgarian',
  'startup', 'startups', 'company', 'platform', 'firm', 'venture', 'brand', 'maker', 'group',
  'ai', 'genai', 'ml', 'saas', 'fintech', 'healthtech', 'edtech', 'deeptech', 'agritech',
  'insurtech', 'legaltech', 'proptech', 'cleantech', 'foodtech', 'spacetech', 'biotech',
  'legal', 'tech', 'technology', 'technologies', 'defense', 'defence', 'mobility', 'logistics',
  'based', 'led', 'backed', 'focused', 'native', 'first', 'powered', 'driven', 'enabled',
  'funding', 'alert', 'exclusive', 'breaking', 'report', 'startup’s',
]);

const RAISE_VERB_SPLIT_RE =
  /\b(raises?|raised|raising|secures?|secured|lands?|landed|nabs?|bags?|closes?|closed|pockets?)\b/i;

/**
 * A stable key for "which raise is this", so the same round reported by five outlets
 * becomes one row. Measured 2026-08-08: Google News returned NYAI five times, Hulp four,
 * Vingo four — deduping by URL keeps all of them, and every duplicate would cost 2 Gemini
 * calls out of a 20/day quota plus a duplicate cold email to the same founder.
 *
 * Heuristic, deliberately: the company name is the last meaningful token before the raise
 * verb. Amounts are excluded from the key on purpose — the same round is reported as both
 * "$1.2 million" and "Rs 10 crore". When the heuristic can't find a name it falls back to
 * the whole title, which simply means that row doesn't collapse with anything.
 */
export function storyKey(title: string): string {
  const [before] = title.split(RAISE_VERB_SPLIT_RE);
  const tokens = (before ?? '')
    .replace(/[^\p{L}\p{N}\s'’-]/gu, ' ')
    .split(/\s+/)
    .map((t) => t.replace(/['’]s$/, '').toLowerCase())
    .filter((t) => t.length > 1 && !DESCRIPTOR_WORDS.has(t));

  const name = tokens[tokens.length - 1];
  if (!name) return title.toLowerCase().replace(/\s+/g, ' ').trim();
  return name.replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * A link no server can follow to the article: Google News RSS interstitials, and the
 * `google.com/goto?url=<opaque blob>` wrappers Serper sometimes returns instead of the
 * publisher URL (seen live 2026-08-08 — same query, some results direct, some wrapped).
 * Both render only in a browser, so the contact pipeline must skip them rather than scrape
 * a redirect shell.
 */
export function isUnresolvableNewsLink(url: string): boolean {
  return /(^|\/\/)news\.google\.com\//i.test(url) || /google\.com\/goto\?/i.test(url);
}

/** Aggregate weekly/daily round-ups name no single company, so Gemini would invent one. */
function isRoundup(title: string): boolean {
  return /\b\d+\s+(indian\s+)?startups\b|\bstartups\s+(raised|raise)\b|\bweekly\s+funding\b|\bfunding\s+round-?up\b|\b(daily|weekly)\s+round-?up\b|\b(deals?|funding|startup)\s+digest\b|^digest\b|\bthis\s+week\b|\bfunding\s+(drops?|falls?|rises?)\b/i.test(
    title
  );
}

/**
 * Serper's news results date as "3 days ago" / "1 hour ago", which `Date.parse` cannot
 * read. Converting it matters: the age gate is a hard gate, and stamping everything as
 * "now" would let a month-old article pass as fresh.
 */
function parseRelativeDate(rel: string | undefined): string {
  if (!rel) return new Date().toISOString();
  const m = rel.match(/(\d+)\s*(minute|hour|day|week|month|year)s?\s+ago/i);
  if (!m) return new Date().toISOString();
  const n = Number(m[1]);
  const unit = m[2].toLowerCase();
  const ms: Record<string, number> = {
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_592_000_000,
    year: 31_536_000_000,
  };
  return new Date(Date.now() - n * (ms[unit] ?? 0)).toISOString();
}

async function fetchNewsQuery(q: string): Promise<FundingRaw[]> {
  const url = `${GOOGLE_NEWS}?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'application/rss+xml,application/xml,text/xml' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(`google-news ${res.status}`);

  const $ = cheerio.load(await res.text(), { xmlMode: true });
  const out: FundingRaw[] = [];

  $('item').each((_, el) => {
    const item = $(el);
    const publisher = item.find('source').first().text().trim();
    const title = stripPublisher(decode(item.find('title').first().text()), publisher);
    const link = item.find('link').first().text().trim();
    const pub = item.find('pubDate').first().text().trim();
    if (!title || !link) return;

    // Aggregator round-ups ("14 Indian startups raised over $80 million this week") pass
    // the raise gate but name no single company, so Gemini would invent one. Kill them on
    // the plural subject, which is the only reliable tell.
    if (
      /\b\d+\s+(indian\s+)?startups\b|\bstartups\s+(raised|raise)\b|\bweekly\s+funding\b|\bfunding\s+round-?up\b|\b(deals?|funding|startup)\s+digest\b|^digest\b/i.test(
        title
      )
    ) {
      return;
    }

    out.push({
      sourceId: urlId(link),
      title,
      summary: publisher ? `${title} (${publisher})` : title,
      url: link,
      postedAt: pub ? new Date(pub).toISOString() : new Date().toISOString(),
    });
  });

  return out;
}

/**
 * Serper's NEWS endpoint, not /search. Measured 2026-08-08: `/search` for these queries
 * returned one organic result and it was an SEO directory page, while `/news` returned ten
 * real funding announcements per query with **direct publisher URLs** — entrackr.com,
 * economictimes, inc42, businesswire. Those URLs are the entire point of paying Serper any
 * attention: they are scrapeable, so the existing contact pipeline can read the article and
 * name the founder, which the Google News rows can never do.
 */
async function fetchSerperQuery(q: string, key: string): Promise<FundingRaw[]> {
  const res = await fetch(SERPER_ENDPOINT, {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    // qdr:w — past week, matching the news queries. gl:in biases to Indian coverage.
    body: JSON.stringify({ q, num: 20, gl: 'in', tbs: 'qdr:w' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(`serper ${res.status}: ${(await res.text()).slice(0, 120)}`);

  const body = (await res.json()) as {
    news?: Array<{ title?: string; link?: string; snippet?: string; date?: string; source?: string }>;
  };

  const out: FundingRaw[] = [];
  for (const r of body.news ?? []) {
    if (!r.link || !r.title) continue;
    if (isUnresolvableNewsLink(r.link)) continue;
    const title = decode(r.title);
    if (isRoundup(title)) continue;
    out.push({
      sourceId: urlId(r.link),
      title,
      summary: decode(r.snippet ?? title),
      url: r.link,
      postedAt: parseRelativeDate(r.date),
    });
  }
  return out;
}

/**
 * Company name → its official domain, via a Serper web search.
 *
 * Exists because Hunter's domain-finder cannot disambiguate small startups: "Hulp" returns
 * hulp.chat / hulp.work / hulp.nl / hulp.in, "Vingo" returns five country TLDs, and picking
 * one is a coin flip (lib/enrich.ts refuses to guess, which left 41 of 83 fresh rows stuck).
 * A search engine resolves exactly this, and the Serper key is already paid for.
 *
 * Returns null rather than a guess when the top results are all press coverage — a wrong
 * domain leads to a wrong person, and eventually a cold email to a stranger.
 */
export async function resolveDomainViaSearch(company: string): Promise<string | null> {
  const key = process.env.SERPER_API_KEY;
  if (!key || company.trim().length < 3) return null;

  const res = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
    // Plain keywords: the free tier rejects quoted phrases and OR operators.
    body: JSON.stringify({ q: `${company.trim()} startup official website`, num: 10, gl: 'in' }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`serper domain ${res.status}`);

  const body = (await res.json()) as { organic?: Array<{ link?: string; title?: string }> };
  const target = company.toLowerCase().replace(/[^a-z0-9]/g, '');

  for (const r of body.organic ?? []) {
    if (!r.link) continue;
    let host: string;
    try {
      host = new URL(r.link).hostname.replace(/^www\./, '').toLowerCase();
    } catch {
      continue;
    }
    // Press, directories and social profiles dominate these results and are never the
    // company's own site.
    if (NON_COMPANY_RE.test(host)) continue;

    // The domain must actually relate to the company name, or the top organic result for
    // an obscure startup is just whoever ranks for that word.
    const label = host.split('.')[0].replace(/[^a-z0-9]/g, '');
    const flat = host.replace(/[^a-z0-9]/g, '');
    if (label === target || flat.startsWith(target) || target.startsWith(label)) return host;
  }

  return null;
}

/** Hosts that are never a startup's own site. */
const NON_COMPANY_RE =
  /(^|\.)(techcrunch|entrackr|inc42|yourstory|economictimes|indiatimes|business-standard|businesswire|prnewswire|globenewswire|crunchbase|pitchbook|tracxn|linkedin|twitter|x|facebook|instagram|youtube|medium|substack|wikipedia|glassdoor|indeed|ambitionbox|zaubacorp|google|apple|amazon|bloomberg|reuters|forbes|wamda|dealroom|failory|f6s|angel|wellfound)\./;

export type NewsFundingResult = {
  items: FundingRaw[];
  perSource: Record<string, number>;
  /** Articles collapsed into an existing raise. High is healthy — it is quota saved. */
  duplicateStories: number;
  errors: string[];
};

/**
 * Both feeds, every query in parallel, gated by the same `isStartupRaise` bank TechCrunch
 * uses — one definition of "a startup raised money", not three.
 */
export async function fetchFundingNews(): Promise<NewsFundingResult> {
  const serperKey = process.env.SERPER_API_KEY;

  const tasks: Array<{ source: string; run: () => Promise<FundingRaw[]> }> = [
    ...NEWS_QUERIES.map((q) => ({ source: 'googlenews', run: () => fetchNewsQuery(q) })),
    ...(serperKey
      ? SERPER_QUERIES.map((q) => ({ source: 'serper', run: () => fetchSerperQuery(q, serperKey) }))
      : []),
  ];

  const settled = await Promise.allSettled(tasks.map((t) => t.run()));

  const perSource: Record<string, number> = { googlenews: 0, serper: 0 };
  const errors: string[] = [];
  const byId = new Map<string, FundingRaw>();
  // One entry per RAISE, not per article. A Serper row wins a tie over a Google News row
  // because its URL is a real article the contact lookup can actually read.
  const byStory = new Map<string, { item: FundingRaw; resolvable: boolean }>();
  let duplicateStories = 0;

  settled.forEach((r, i) => {
    const { source } = tasks[i];
    if (r.status === 'rejected') {
      errors.push(`${source}: ${(r.reason as Error).message}`);
      return;
    }
    for (const item of r.value) {
      if (!isStartupRaise(item.title, item.summary)) continue;
      if (byId.has(item.sourceId)) continue;
      byId.set(item.sourceId, item);
      perSource[source]++;

      const key = storyKey(item.title);
      const resolvable = !isUnresolvableNewsLink(item.url);
      const held = byStory.get(key);
      if (!held) {
        byStory.set(key, { item, resolvable });
      } else {
        duplicateStories++;
        // Prefer a scrapeable article; failing that, the earliest report of the round.
        const better =
          (resolvable && !held.resolvable) ||
          (resolvable === held.resolvable && Date.parse(item.postedAt) < Date.parse(held.item.postedAt));
        if (better) byStory.set(key, { item, resolvable });
      }
    }
  });

  return {
    items: [...byStory.values()].map((v) => v.item),
    perSource,
    duplicateStories,
    errors,
  };
}
