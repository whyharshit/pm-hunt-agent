import type { Job } from '../types';

// LinkedIn via serper.dev (Google Search API) — never touches LinkedIn itself, so no
// account or ban risk (the standing no-AIHawk rule stays intact). Serper returns
// Google results for site:linkedin.com/jobs/view queries; we parse the result titles,
// which Google renders as "Company hiring Role in Location | LinkedIn".
//
// Requires SERPER_API_KEY (serper.dev, free tier ~2500 credits). Without it this
// source returns [] silently — an unset optional key must not put a daily error on
// the agent card.
const ENDPOINT = 'https://google.serper.dev/search';

// One query per goal field. qdr:w = past week — the cron runs daily, dedupe by
// job id handles the overlap, and a day-only window misses late-indexed posts.
const QUERIES = [
  'site:linkedin.com/jobs/view (intern OR internship) (product OR strategy OR operations OR "founder\'s office" OR "chief of staff") remote',
  'site:linkedin.com/jobs/view (intern OR internship) ("data analyst" OR "data science" OR analytics) remote',
  'site:linkedin.com/jobs/view (intern OR internship) ("venture capital" OR "investment analyst") remote',
  'site:linkedin.com/jobs/view (intern OR internship) ("artificial intelligence" OR "machine learning" OR GenAI) remote',
];

type SerperOrganic = { title?: string; link?: string; snippet?: string };

/** "Acme hiring Product Intern in Bengaluru, India | LinkedIn" → its three parts. */
function parseResultTitle(raw: string): { company: string; title: string; location: string } {
  const cleaned = raw.replace(/\s*\|\s*LinkedIn\s*$/i, '').trim();
  const m = cleaned.match(/^(.*?)\s+hiring\s+(.*?)(?:\s+in\s+(.+))?$/i);
  if (!m) return { company: 'Unknown', title: cleaned, location: 'Remote' };
  return { company: m[1].trim(), title: m[2].trim(), location: (m[3] ?? 'Remote').trim() };
}

/** Search Google for LinkedIn job posts via serper.dev. Returns [] when no key is set. */
export async function fetchLinkedInViaSerper(): Promise<Job[]> {
  const key = process.env.SERPER_API_KEY;
  if (!key) return [];

  const jobs: Job[] = [];
  const seen = new Set<string>();

  const responses = await Promise.all(
    QUERIES.map(async (q) => {
      const res = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ q, num: 20, gl: 'in', tbs: 'qdr:w' }),
        next: { revalidate: 0 },
      });
      if (!res.ok) throw new Error(`serper ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return (await res.json()) as { organic?: SerperOrganic[] };
    })
  );

  for (const r of responses) {
    for (const item of r.organic ?? []) {
      if (!item.link || !item.title) continue;
      const idMatch = item.link.match(/\/jobs\/view\/(?:[^/]*-)?(\d+)/);
      if (!idMatch) continue;
      const id = `linkedin:${idMatch[1]}`;
      if (seen.has(id)) continue;
      seen.add(id);

      const { company, title, location } = parseResultTitle(item.title);
      jobs.push({
        id,
        source: 'linkedin',
        title,
        company,
        location,
        url: item.link,
        // Google doesn't expose the post date reliably; the qdr:w window bounds it.
        postedAt: new Date(),
        tags: [],
        description: (item.snippet ?? '').slice(0, 600),
      });
    }
  }

  return jobs;
}
