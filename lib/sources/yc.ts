import { decodeEntities } from '../html';
import type { Job } from '../types';

// Y Combinator's public job board (ycombinator.com/jobs).
//
// workatastartup.com — the board YC actually applies through — returns 406 to any
// non-browser client and gates listings behind a login, so it is not scrapable. But
// ycombinator.com/jobs is a server-rendered Inertia.js page: the whole listing payload
// ships inside a `data-page` attribute on the root div as HTML-escaped JSON. No API key,
// no cookies, no headless browser — just parse the attribute.
//
// Role pages serve a curated ~38-posting set with no pagination, so we fetch per role
// and per India sub-page and dedupe by posting id.
const BASE = 'https://www.ycombinator.com';

// YC's role slugs, narrowed to this profile's fields. Engineering/design/sales pages are
// deliberately not fetched — the title-anchored hard-rejects would drop all of them.
const PAGES = [
  '/jobs/role/product-manager',
  '/jobs/role/operations',
  '/jobs/role/science',
  '/jobs/role/product-manager/india',
  '/jobs/role/operations/india',
  '/jobs/location/india',
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// YC states work authorisation per posting. "US citizen/visa only" is unreachable for
// this user and is NOT caught by the remote gate — a "US / Remote (US)" listing reads as
// remote while still requiring US work authorisation. That combination is precisely the
// false positive the title-anchored filters were tightened to kill, so it dies here.
// Flip this if the user ever gains US work authorisation.
const UNREACHABLE_VISA = 'us citizen/visa only';

type YcPosting = {
  id?: number;
  title?: string;
  url?: string;
  applyUrl?: string;
  location?: string;
  type?: string;
  salaryRange?: string;
  equityRange?: string;
  minExperience?: string;
  visa?: string;
  skills?: string[];
  companyName?: string;
  companyBatchName?: string;
  companyOneLiner?: string;
  createdAt?: string;
};

type YcPage = { props?: { jobPostings?: YcPosting[] } };

/** Pull the Inertia `data-page` JSON blob out of a YC page. */
function extractInertiaPage(html: string): YcPage | null {
  const m = html.match(/data-page="([\s\S]*?)"\s*>/);
  if (!m) return null;
  try {
    // decodeEntities, NOT htmlToText: company blurbs inside this payload contain literal
    // markup, and htmlToText's `<[^>]+>` strip would eat it and corrupt the JSON. Entity
    // order matters too — &amp; must resolve last, which decodeEntities already does.
    return JSON.parse(decodeEntities(m[1])) as YcPage;
  } catch {
    return null;
  }
}

/** YC ships relative ages ("11 months", "3 days"). Unknown shapes fall back to now. */
function parsePostedAt(text: string | undefined): Date {
  const t = (text ?? '').trim().toLowerCase();
  const now = Date.now();
  const m = t.match(/(\d+)\s*(day|week|month|year|hour)/);
  if (!m) return new Date(now);
  const n = Number(m[1]);
  const days: Record<string, number> = {
    hour: 1 / 24,
    day: 1,
    week: 7,
    month: 30,
    year: 365,
  };
  return new Date(now - n * (days[m[2]] ?? 1) * 24 * 60 * 60 * 1000);
}

/** Fetch YC's public job board via its embedded Inertia payload. No key, no LLM. */
export async function fetchYc(): Promise<Job[]> {
  const jobs: Job[] = [];
  const seen = new Set<string>();
  const failures: string[] = [];

  const pages = await Promise.all(
    PAGES.map(async (path) => {
      try {
        const res = await fetch(`${BASE}${path}`, {
          headers: { 'user-agent': UA, accept: 'text/html' },
          next: { revalidate: 0 },
        });
        if (!res.ok) throw new Error(`${res.status}`);
        return extractInertiaPage(await res.text());
      } catch (e) {
        failures.push(`${path}: ${(e as Error).message}`);
        return null;
      }
    })
  );

  for (const page of pages) {
    for (const p of page?.props?.jobPostings ?? []) {
      if (!p.id || !p.title || !p.url) continue;

      const id = `yc:${p.id}`;
      if (seen.has(id)) continue; // role pages and the India pages overlap heavily
      if ((p.visa ?? '').trim().toLowerCase() === UNREACHABLE_VISA) continue;
      seen.add(id);

      // Only stamp the word onto postings YC itself typed as internships; this board is
      // mostly senior full-time, so a blanket append would forge an intern signal.
      // Full-time rows still reach the filters, where "founder's office" / "chief of
      // staff" / "APM" can pass on their own merits.
      const title =
        p.type === 'Internship' && !/\bintern(ship)?\b/i.test(p.title)
          ? `${p.title} Internship`
          : p.title;

      jobs.push({
        id,
        source: 'yc',
        title,
        company: p.companyName?.trim() || 'Unknown',
        location: p.location?.trim() || 'Unknown',
        url: new URL(p.url, BASE).toString(),
        ...(p.applyUrl ? { applyUrl: p.applyUrl } : {}),
        postedAt: parsePostedAt(p.createdAt),
        tags: [
          p.type,
          p.companyBatchName ? `YC ${p.companyBatchName}` : '',
          p.minExperience,
          p.visa,
          ...(p.skills ?? []),
        ].filter((t): t is string => Boolean(t)),
        description: (p.companyOneLiner ?? '').slice(0, 600),
        ...(p.salaryRange ? { salary: p.salaryRange } : {}),
      });
    }
  }

  // Every page failing means YC changed the markup or blocked us — surface it so the run
  // summary says so. Partial failure just yields fewer jobs.
  if (jobs.length === 0 && failures.length === PAGES.length) {
    throw new Error(`all pages failed: ${failures.join('; ')}`);
  }

  return jobs;
}
