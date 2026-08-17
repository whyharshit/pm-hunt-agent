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
//
// ⚠️ PLAIN KEYWORDS ONLY — NO `site:`, NO "QUOTED PHRASES".
// serper.dev's FREE tier rejects both with HTTP 400 "Query pattern not allowed for free
// accounts" (verified query by query, 2026-08-09). Every query here used both, and because
// they ran under one Promise.all a single 400 rejected the lot: this source returned ZERO
// rows every single day while looking perfectly configured, its error swallowed into the
// digest's error line. Re-introducing either operator silently kills the source again.
//
// A bare `linkedin.com/jobs/view` token still steers Google to job posts (measured: ~5 of 10
// results), and the /jobs/view/<id> match below discards everything that is not one, so the
// looser query costs no precision. If Serper is ever upgraded to a paid plan, `site:` works
// and is worth restoring.
//
// ⚠️ THE `remote` TOKEN IS NOT FREE. Every query below used to end in it, and Google obliged
// by returning US remote postings — measured 2026-08-17, 27 rows of which most were American
// (Amtrak, TikTok, US private equity) despite `gl: 'in'`. The India queries added that day
// exist because on-site product internships in India now pass the filters (see
// `isOnsiteAllowed` in lib/filters.ts), and no query here was asking for one.
//
// For structured Indian rows prefer lib/sources/linkedin-guest.ts, which asks LinkedIn
// directly and always knows the company. This source stays because Google indexes postings
// that the guest search does not surface, and the two share an id space so overlap collapses.
const QUERIES = [
  'linkedin.com/jobs/view internship product management strategy operations remote',
  'linkedin.com/jobs/view internship data analyst analytics remote',
  'linkedin.com/jobs/view internship venture capital investment analyst remote',
  'linkedin.com/jobs/view internship artificial intelligence machine learning remote',
  // Software engineering (2026-08-09), closing the same gap as the Internshala categories:
  // SWE became a target function on 2026-08-07 with no source ever pointed at it.
  'linkedin.com/jobs/view internship software engineer developer remote',
  // India (2026-08-17). Cities rather than the bare word "India": Google treats a city as a
  // strong locality signal where a country name mostly reorders the same global results.
  'linkedin.com/jobs/view product management internship bangalore india',
  'linkedin.com/jobs/view product internship gurgaon mumbai hyderabad',
  'linkedin.com/jobs/view associate product manager intern india',
];

type SerperOrganic = { title?: string; link?: string; snippet?: string };

/**
 * "Acme hiring Product Intern in Bengaluru, India | LinkedIn" → its three parts.
 *
 * ⚠️ An unparseable title yields an EMPTY location, never "Remote". It used to claim Remote,
 * which was a guess dressed as a fact — and since 2026-08-17 it is a consequential one: a
 * row labelled Remote enters `passes()` through the remote branch and skips the India +
 * product-only conditions the on-site allowance is deliberately narrowed by. Google's snippet
 * rides along in `description`, so a genuinely remote posting still says so and still matches.
 */
function parseResultTitle(raw: string): { company: string; title: string; location: string } {
  const cleaned = raw.replace(/\s*\|\s*LinkedIn\s*$/i, '').trim();
  const m = cleaned.match(/^(.*?)\s+hiring\s+(.*?)(?:\s+in\s+(.+))?$/i);
  if (!m) return { company: 'Unknown', title: cleaned, location: '' };
  return { company: m[1].trim(), title: m[2].trim(), location: (m[3] ?? '').trim() };
}

/** Search Google for LinkedIn job posts via serper.dev. Returns [] when no key is set. */
export async function fetchLinkedInViaSerper(): Promise<Job[]> {
  const key = process.env.SERPER_API_KEY;
  if (!key) return [];

  const jobs: Job[] = [];
  const seen = new Set<string>();
  const failures: string[] = [];

  // Per-query isolation, matching the other multi-page sources. Under a bare Promise.all one
  // rejected query took the whole source down with it, which is exactly how the `site:` 400
  // stayed invisible for so long.
  const responses = await Promise.all(
    QUERIES.map(async (q) => {
      try {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'X-API-KEY': key, 'Content-Type': 'application/json' },
          body: JSON.stringify({ q, num: 20, gl: 'in', tbs: 'qdr:w' }),
          next: { revalidate: 0 },
        });
        if (!res.ok) throw new Error(`serper ${res.status}: ${(await res.text()).slice(0, 120)}`);
        return (await res.json()) as { organic?: SerperOrganic[] };
      } catch (e) {
        failures.push(`${q.slice(0, 40)}…: ${(e as Error).message}`);
        return null;
      }
    })
  );

  for (const r of responses) {
    for (const item of r?.organic ?? []) {
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

  // Only a total wipe-out is a source failure worth reporting. One query rejected while the
  // rest returned rows is not something to put a red mark on the agent card for.
  if (jobs.length === 0 && failures.length === QUERIES.length) {
    throw new Error(`all queries failed: ${failures.join('; ')}`);
  }

  return jobs;
}
