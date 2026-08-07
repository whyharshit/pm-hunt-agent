import { geoReachable } from '../geo';
import type { Job } from '../types';

/**
 * Firecrawl-rendered pages for the two boards that block plain fetches:
 *
 *   - wellfound.com          — DataDome 403 to any non-browser client
 *   - workatastartup.com     — 406 to non-browser clients
 *
 * Both verdicts of "unscrapeable, stays dead" were re-tested through Firecrawl on
 * 2026-08-07 and both pages render fully with the basic proxy (1 credit/page — stealth's
 * 5-credit mode was NOT needed; don't add it without re-checking cost).
 *
 *   FIRECRAWL_API_KEY — unset returns [] silently: an unconfigured optional source must
 *   not put a daily error on the agent card. Same contract as SERPER_API_KEY. The key
 *   currently lives in .env.local only — it must be added to Vercel prod
 *   (`vercel env add FIRECRAWL_API_KEY production --value <key>`) before this source
 *   contributes to the live cron.
 *
 * 💰 COST: PAGES.length credits per run = 4/day ≈ 120/month against ~1,400 credits per
 * billing period. Check the Firecrawl dashboard first if this source starts erroring.
 *
 * ⏱ The 60s Hobby cron ceiling is the real constraint. Firecrawl is the slow source
 * (10–30s per page). Pages are fetched in parallel and each scrape is hard-bounded, so
 * this source's wall-clock is one page, never the sum — and a page that blows the bound
 * is dropped alone (allSettled), leaving the rest of the run intact.
 */
const SCRAPE_TIMEOUT_MS = 35_000;

type PageSpec = {
  url: string;
  kind: 'waas' | 'wellfound';
};

// Page choice mirrors the target functions: product + SWE + ops on WaaS, product on
// Wellfound. Every added page is +1 credit/day and more markdown inside the same
// wall-clock bound — grow this list deliberately, not casually.
const PAGES: PageSpec[] = [
  { url: 'https://www.workatastartup.com/jobs/l/product-manager', kind: 'waas' },
  { url: 'https://www.workatastartup.com/jobs/l/software-engineer', kind: 'waas' },
  { url: 'https://www.workatastartup.com/jobs/l/operations', kind: 'waas' },
  { url: 'https://wellfound.com/role/r/product-manager', kind: 'wellfound' },
];

async function scrape(url: string, key: string): Promise<string> {
  const res = await fetch('https://api.firecrawl.dev/v2/scrape', {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    // maxAge: Firecrawl v2 serves its own cache by default (~2 days) — observed live: a
    // re-scrape 10 minutes after a cold one returned in 3s. Left at the default, a DAILY
    // cron would get a stale page every other run. 8h keeps every cron run fresh while
    // still letting back-to-back local tests hit the cache instead of burning wall-clock.
    body: JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true,
      maxAge: 8 * 3600 * 1000,
    }),
    signal: AbortSignal.timeout(SCRAPE_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`firecrawl ${res.status} for ${url}`);
  const body = (await res.json()) as { success?: boolean; data?: { markdown?: string } };
  if (!body.success || !body.data?.markdown) throw new Error(`firecrawl empty for ${url}`);
  return body.data.markdown;
}

/** First currency symbol splits a WaaS meta line into location | salary. */
const CURRENCY_SPLIT_RE = /[$€£₹]/;

/**
 * workatastartup markdown (verified live 2026-08-07):
 *
 *   [Hive (S14)•Marketing automation for event promoters](…/companies/hive)
 *   [Head of Product](…/jobs/97336)
 *   FulltimeCA / US / Remote (CA; US)$190K - $220K CAD
 *   [Apply](account.ycombinator.com auth wrapper — a login redirect, NOT an apply link)
 *
 * The employment type is GLUED to the location, and the salary is glued to that. The
 * company line's • separates name+batch from the blurb, with a NBSP inside the name.
 */
const WAAS_COMPANY_RE = /^\[([^\]]+)\]\(https:\/\/www\.workatastartup\.com\/companies\/[^)]+\)/;
const WAAS_JOB_RE = /^\[([^\]]+)\]\((https:\/\/www\.workatastartup\.com\/jobs\/(\d+))\)/;
const WAAS_META_RE = /^(Fulltime|Intern|Contract|Part-?time)(.*)$/;

function parseWaas(markdown: string): Job[] {
  const lines = markdown.split('\n').map((l) => l.replace(/\u00a0/g, ' ').trim());
  const jobs: Job[] = [];
  let company = 'Unknown';

  for (let i = 0; i < lines.length; i++) {
    const companyMatch = lines[i].match(WAAS_COMPANY_RE);
    if (companyMatch) {
      company = companyMatch[1].split('•')[0].trim();
      continue;
    }

    const jobMatch = lines[i].match(WAAS_JOB_RE);
    if (!jobMatch) continue;
    let title = jobMatch[1].trim();

    // The meta line is the next non-empty line. Absent meta (layout drift) keeps the row
    // with unknown location — the downstream remote gate will judge it.
    let location = '';
    let salary: string | undefined;
    let isInternType = false;
    const meta = lines.slice(i + 1, i + 4).find((l) => l.length > 0) ?? '';
    const metaMatch = meta.match(WAAS_META_RE);
    if (metaMatch) {
      isInternType = metaMatch[1] === 'Intern';
      const rest = metaMatch[2];
      const cut = rest.search(CURRENCY_SPLIT_RE);
      location = (cut >= 0 ? rest.slice(0, cut) : rest).trim();
      if (cut >= 0) salary = rest.slice(cut).trim();
    }

    if (!geoReachable(location)) continue;

    // Same rule as yc.ts: "Internship" is appended ONLY to rows the board itself typed as
    // Intern, so no intern signal is ever forged onto a full-time role.
    if (isInternType && !/\bintern(ship)?\b/i.test(title)) title = `${title} Internship`;

    jobs.push({
      id: `waas:${jobMatch[3]}`,
      source: 'waas',
      title,
      company,
      location: location || 'Unknown',
      url: jobMatch[2],
      // No date on the listing page; YC listings are long-lived by nature anyway.
      postedAt: new Date(),
      tags: metaMatch ? [metaMatch[1]] : [],
      ...(salary ? { salary } : {}),
    });
  }
  return jobs;
}

/**
 * Wellfound markdown (verified live 2026-08-07):
 *
 *   [**Check**](https://wellfound.com/company/checkhq)
 *   [Product Manager](https://wellfound.com/jobs/4450695-product-manager) Full-time
 *   $228k – $264k
 *   Remote • United States
 *   4 weeks ago
 *
 * A company block carries 1..n job lines; salary/location follow each job line.
 */
const WF_COMPANY_RE = /^\[\*\*(.+?)\*\*\]\(https:\/\/wellfound\.com\/company\/[^)]+\)/;
const WF_JOB_RE = /^\[([^\]]+)\]\((https:\/\/wellfound\.com\/jobs\/(\d+)[^)]*)\)\s*(.*)$/;

function parseWellfound(markdown: string): Job[] {
  const lines = markdown.split('\n').map((l) => l.replace(/\u00a0/g, ' ').trim());
  const jobs: Job[] = [];
  let company = 'Unknown';

  for (let i = 0; i < lines.length; i++) {
    const companyMatch = lines[i].match(WF_COMPANY_RE);
    if (companyMatch) {
      company = companyMatch[1].trim();
      continue;
    }

    const jobMatch = lines[i].match(WF_JOB_RE);
    if (!jobMatch) continue;

    // Salary and location sit in the few lines after the job link, before the next link.
    let salary: string | undefined;
    let location = '';
    for (const l of lines.slice(i + 1, i + 6)) {
      if (l.startsWith('[')) break;
      if (!salary && /^[$€£₹]/.test(l)) salary = l;
      else if (!location && /•/.test(l)) location = l.replace(/\s*•\s*/g, ' • ');
    }

    if (!geoReachable(location)) continue;

    jobs.push({
      id: `wellfound:${jobMatch[3]}`,
      source: 'wellfound',
      title: jobMatch[1].trim(),
      company,
      location: location || 'Unknown',
      url: jobMatch[2],
      postedAt: new Date(),
      tags: jobMatch[4] ? [jobMatch[4].trim()] : [],
      ...(salary ? { salary } : {}),
    });
  }
  return jobs;
}

/** Render Wellfound + workatastartup through Firecrawl. [] until FIRECRAWL_API_KEY is set. */
export async function fetchViaFirecrawl(): Promise<Job[]> {
  const key = process.env.FIRECRAWL_API_KEY;
  if (!key) return [];

  const settled = await Promise.allSettled(
    PAGES.map(async (p) => {
      const md = await scrape(p.url, key);
      return p.kind === 'waas' ? parseWaas(md) : parseWellfound(md);
    })
  );

  const jobs = settled.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));

  // The WaaS function pages are disjoint, but belt-and-braces against a repeated row.
  const seen = new Set<string>();
  return jobs.filter((j) => (seen.has(j.id) ? false : (seen.add(j.id), true)));
}
