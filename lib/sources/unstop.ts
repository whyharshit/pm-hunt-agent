import { htmlToText } from '../html';
import type { Job } from '../types';

// Unstop (ex-Dare2Compete) — India's student-opportunity board, and the only source
// assessed so far that hands us a clean public JSON API instead of HTML to scrape.
// No key, no auth, no cookies.
//
// The API's own filters are unreliable: `jobType=remote` is silently IGNORED (it
// returns the full 862-row unfiltered set), and `searchTerm` is a loose relevance
// match — "venture capital" happily returns "Capital Engineering". So we search by
// goal field to narrow the fetch, then let the title-anchored filters in lib/filters.ts
// make every real accept/reject call. The search terms are a net, not a filter.
const ENDPOINT = 'https://unstop.com/api/public/opportunity/search-result';

// One search per goal field, mirroring the Discover role banks.
const SEARCHES = [
  'product management',
  'founder office',
  'operations',
  'data analytics',
  'venture capital',
  'artificial intelligence',
  'business analyst',
  'strategy',
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

type UnstopJobDetail = {
  type?: string; // 'wfh' | 'hybrid' | 'in_office'
  paid_unpaid?: string; // 'paid' | 'unpaid'
  min_salary?: number | null;
  max_salary?: number | null;
  pay_in?: string | null;
  not_disclosed?: boolean;
  locations?: string[];
};

type UnstopItem = {
  id?: number;
  title?: string;
  seo_url?: string;
  public_url?: string;
  details?: string;
  approved_date?: string;
  updated_at?: string;
  organisation?: { name?: string };
  jobDetail?: UnstopJobDetail;
  required_skills?: { skill_name?: string; skill?: string }[];
  locations?: { city?: string }[];
};

type UnstopResponse = { data?: { data?: UnstopItem[]; total?: number } };

// Unstop sends the period as an adverb ("monthly"). Chopping a trailing "ly" turns
// "daily" into "dai" — map the known ones and fall back to the raw word.
const PAY_PERIOD: Record<string, string> = {
  hourly: 'hour',
  daily: 'day',
  weekly: 'week',
  monthly: 'month',
  yearly: 'year',
  annually: 'year',
};

/** "₹15,000/month" from the structured salary fields. Empty when not disclosed. */
function formatStipend(d: UnstopJobDetail): string {
  if (d.not_disclosed) return '';
  const min = d.min_salary ?? 0;
  const max = d.max_salary ?? 0;
  if (!min && !max) return '';
  const fmt = (n: number) => `₹${n.toLocaleString('en-IN')}`;
  const range = !min || !max || min === max ? fmt(max || min) : `${fmt(min)}–${fmt(max)}`;
  if (!d.pay_in) return range;
  const period = PAY_PERIOD[d.pay_in.toLowerCase()] ?? d.pay_in;
  return `${range}/${period}`;
}

/** approved_date → updated_at → now. Both Unstop shapes parse natively; guard anyway. */
function parsePostedAt(item: UnstopItem): Date {
  for (const raw of [item.approved_date, item.updated_at]) {
    if (!raw) continue;
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return new Date();
}

/** Fetch Unstop's public internship API across the goal fields. No key, no LLM. */
export async function fetchUnstop(): Promise<Job[]> {
  const jobs: Job[] = [];
  const seen = new Set<string>();
  const failures: string[] = [];

  const responses = await Promise.all(
    SEARCHES.map(async (term) => {
      const url =
        `${ENDPOINT}?opportunity=internships&page=1&per_page=30&oppstatus=open` +
        `&searchTerm=${encodeURIComponent(term)}`;
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': UA, accept: 'application/json' },
          next: { revalidate: 0 },
        });
        if (!res.ok) throw new Error(`${res.status}`);
        return (await res.json()) as UnstopResponse;
      } catch (e) {
        failures.push(`${term}: ${(e as Error).message}`);
        return null;
      }
    })
  );

  for (const r of responses) {
    for (const item of r?.data?.data ?? []) {
      const url = item.seo_url || (item.public_url ? `https://unstop.com/${item.public_url}` : '');
      if (!item.id || !item.title || !url) continue;

      const id = `unstop:${item.id}`;
      if (seen.has(id)) continue; // the same listing surfaces under several search terms

      const detail = item.jobDetail ?? {};

      // The user wants PAID internships. NOTE: the top-level `isPaid` flag is Unstop's
      // *registration fee* marker, not the stipend — a ₹15k/month listing carries
      // `isPaid:false`. `jobDetail.paid_unpaid` is the stipend field. Don't swap these.
      if (detail.paid_unpaid === 'unpaid') continue;

      // Remote-only, decided at the source rather than downstream. Two reasons: it keeps
      // the fetch honest (in-office India is most of this board and would be dropped
      // anyway), and — the real one — `isRemote` scans the DESCRIPTION too, so an
      // in-office listing whose blurb says "work from home allowed on Fridays" would
      // slip through the gate. The structured work-type is the trustworthy signal.
      // Hybrid is excluded with in-office: it is city-bound, and the standing gate is remote.
      if (detail.type !== 'wfh') continue;

      seen.add(id);

      const skills = (item.required_skills ?? [])
        .map((s) => s.skill_name || s.skill || '')
        .filter(Boolean);
      const stipend = formatStipend(detail);

      // Unstop titles are mostly already "<Role> Internship", but not all are — and every
      // row here has subtype `internships`, so append the word the title-anchored intern
      // filter needs when the poster left it out. Same treatment as Internshala.
      const title = /\bintern(ship)?\b/i.test(item.title)
        ? item.title
        : `${item.title} Internship`;

      jobs.push({
        id,
        source: 'unstop',
        title,
        company: item.organisation?.name?.trim() || 'Unknown',
        // Every row reaching here is work-from-home; say so in the words the remote
        // gate reads, rather than the listing's nominal head-office city.
        location: 'Work From Home',
        url,
        postedAt: parsePostedAt(item),
        tags: [stipend, ...skills].filter(Boolean),
        description: htmlToText(item.details ?? '').slice(0, 600),
        ...(stipend ? { salary: stipend } : {}),
      });
    }
  }

  // Every search failing means the API changed or blocked us — surface it so the run
  // summary says so. Partial failure just yields fewer jobs.
  if (jobs.length === 0 && failures.length === SEARCHES.length) {
    throw new Error(`all searches failed: ${failures.join('; ')}`);
  }

  return jobs;
}
