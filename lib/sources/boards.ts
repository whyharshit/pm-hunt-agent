import { geoReachable, remoteLocation } from '../geo';
import { decodeEntities, stripTags } from '../html';
import type { Job } from '../types';

/**
 * The three free remote-job boards with public JSON APIs — Himalayas, Remotive, Jobicy.
 * One file, three adapters: they are structurally the same fetch-and-map with different
 * field names, and three near-identical files would just be three places to fix a bug.
 *
 * No keys, no auth. Expect low yield honestly: these are generic remote boards, the exact
 * class that produced ~0 for this profile before (RemoteOK/WWR), and they skew senior/US.
 * They are here because the standing instruction is "don't drop any free source" — the
 * title-anchored banks in lib/filters.ts still make every real accept/reject.
 *
 * ⚖️ Remotive and Jobicy both REQUIRE crediting them with a link back to the original job
 * URL. `job.url` is that link and the dashboard renders it — do not "clean up" job.url to
 * point anywhere else.
 */

const FETCH_TIMEOUT_MS = 15_000;
const UA = 'pm-hunt-agent/1.0 (contact: hello@lovingroom.co)';

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(`${new URL(url).hostname} fetch failed: ${res.status}`);
  return (await res.json()) as T;
}

// ---------------------------------------------------------------------------------------
// Himalayas — https://himalayas.app/jobs/api
// ---------------------------------------------------------------------------------------

type HimalayasJob = {
  title?: string;
  excerpt?: string;
  description?: string;
  companyName?: string;
  applicationLink?: string;
  guid?: string;
  /** Epoch SECONDS (verified live 2026-08-07), not an ISO string despite the RSS-ish name. */
  pubDate?: number;
  employmentType?: string;
  seniority?: string[];
  locationRestrictions?: string[];
  categories?: string[];
  minSalary?: number | null;
  maxSalary?: number | null;
};

// Himalayas is the only source that states seniority STRUCTURALLY, so a row titled
// "Product Associate" that the board itself files as Senior can be dropped even though
// the title banks would never catch it. Only an all-senior row dies; anything mixed or
// unlabelled falls through to the title filters as usual.
const SENIOR_TIER_RE = /^(senior|manager|director|vp|executive|principal|staff|lead)/i;

export async function fetchHimalayas(): Promise<Job[]> {
  // The API silently caps a page at 20 rows no matter what `limit` asks for (verified
  // live 2026-08-07: limit=100 returns 20). Coverage comes from `offset` pagination —
  // 5 parallel pages ≈ the ~100-row window the other boards get.
  const pages = await Promise.all(
    [0, 20, 40, 60, 80].map((offset) =>
      getJson<{ jobs?: HimalayasJob[] }>(
        `https://himalayas.app/jobs/api?limit=20&offset=${offset}`
      ).then((p) => p.jobs ?? [])
    )
  );

  const out: Job[] = [];
  for (const j of pages.flat()) {
    const url = j.guid ?? j.applicationLink;
    if (!j.title || !url) continue;

    const seniority = j.seniority ?? [];
    if (seniority.length > 0 && seniority.every((s) => SENIOR_TIER_RE.test(s))) continue;
    if (!geoReachable((j.locationRestrictions ?? []).join(', '))) continue;

    out.push({
      id: `himalayas:${url}`,
      source: 'himalayas',
      title: decodeEntities(j.title),
      company: decodeEntities(j.companyName ?? 'Unknown'),
      location: remoteLocation((j.locationRestrictions ?? []).join(', ')),
      url,
      ...(j.applicationLink && j.applicationLink !== url ? { applyUrl: j.applicationLink } : {}),
      postedAt: j.pubDate ? new Date(j.pubDate * 1000) : new Date(),
      tags: [...seniority, ...(j.employmentType ? [j.employmentType] : []), ...(j.categories ?? [])],
      description: stripTags(j.excerpt ?? j.description ?? '').slice(0, 600),
      ...(j.minSalary && j.maxSalary
        ? { salary: `$${j.minSalary.toLocaleString()}–$${j.maxSalary.toLocaleString()}` }
        : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Remotive — https://remotive.com/api/remote-jobs
// ---------------------------------------------------------------------------------------

type RemotiveJob = {
  id?: number;
  url?: string;
  title?: string;
  company_name?: string;
  category?: string;
  tags?: string[];
  job_type?: string;
  publication_date?: string;
  candidate_required_location?: string;
  salary?: string;
  description?: string;
};

export async function fetchRemotive(): Promise<Job[]> {
  const { jobs } = await getJson<{ jobs?: RemotiveJob[] }>(
    'https://remotive.com/api/remote-jobs?limit=100'
  );

  const out: Job[] = [];
  for (const j of jobs ?? []) {
    if (!j.title || !j.url || !j.id) continue;
    if (!geoReachable(j.candidate_required_location)) continue;

    out.push({
      id: `remotive:${j.id}`,
      source: 'remotive',
      title: decodeEntities(j.title),
      company: decodeEntities(j.company_name ?? 'Unknown'),
      location: remoteLocation(j.candidate_required_location),
      url: j.url,
      postedAt: j.publication_date ? new Date(j.publication_date) : new Date(),
      tags: [...(j.tags ?? []), ...(j.category ? [j.category] : []), ...(j.job_type ? [j.job_type] : [])],
      description: stripTags(j.description ?? '').slice(0, 600),
      ...(j.salary?.trim() ? { salary: j.salary.trim() } : {}),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Jobicy — https://jobicy.com/api/v2/remote-jobs
// ---------------------------------------------------------------------------------------

type JobicyJob = {
  id?: number;
  url?: string;
  jobTitle?: string;
  companyName?: string;
  jobIndustry?: string[];
  jobType?: string[];
  jobGeo?: string;
  jobLevel?: string;
  jobExcerpt?: string;
  jobDescription?: string;
  pubDate?: string;
  /** Text fields arrive entity-encoded ("Customer Support &amp; Success"). */
  annualSalaryMin?: number | null;
  annualSalaryMax?: number | null;
  salaryCurrency?: string | null;
};

export async function fetchJobicy(): Promise<Job[]> {
  const { jobs } = await getJson<{ jobs?: JobicyJob[] }>(
    'https://jobicy.com/api/v2/remote-jobs?count=50'
  );

  const out: Job[] = [];
  for (const j of jobs ?? []) {
    if (!j.jobTitle || !j.url || !j.id) continue;
    if (!geoReachable(j.jobGeo)) continue;

    out.push({
      id: `jobicy:${j.id}`,
      source: 'jobicy',
      title: decodeEntities(j.jobTitle),
      company: decodeEntities(j.companyName ?? 'Unknown'),
      location: remoteLocation(j.jobGeo),
      url: j.url,
      postedAt: j.pubDate ? new Date(j.pubDate) : new Date(),
      tags: [
        ...(j.jobLevel ? [j.jobLevel] : []),
        ...(j.jobType ?? []),
        ...(j.jobIndustry ?? []).map(decodeEntities),
      ],
      description: stripTags(j.jobExcerpt ?? j.jobDescription ?? '').slice(0, 600),
      ...(j.annualSalaryMin && j.annualSalaryMax
        ? {
            salary: `${j.salaryCurrency ?? ''}${j.annualSalaryMin.toLocaleString()}–${j.annualSalaryMax.toLocaleString()}`,
          }
        : {}),
    });
  }
  return out;
}
