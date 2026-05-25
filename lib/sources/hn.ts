import type { Job } from '../types';

type HnHit = {
  objectID: string;
  author: string;
  comment_text?: string;
  story_id: number;
  created_at: string;
  created_at_i: number;
};

// HN "Who's Hiring" — pull recent intern-related comments.
// We query Algolia for comments mentioning "intern" + "product" or similar.
export async function fetchHnWhoIsHiring(): Promise<Job[]> {
  const queries = ['intern product', 'intern operations', 'apm intern'];
  const all: Job[] = [];

  for (const q of queries) {
    const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(
      q,
    )}&tags=comment&hitsPerPage=20`;
    const res = await fetch(url, { next: { revalidate: 0 } });
    if (!res.ok) continue;
    const data = (await res.json()) as { hits: HnHit[] };

    for (const hit of data.hits) {
      const text = (hit.comment_text ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (text.length < 80) continue;

      // HN posts don't have structured fields — title/company guessed from first line.
      const firstLine = text.split(/[|–\-]/)[0]?.slice(0, 100) ?? 'HN listing';
      all.push({
        id: `hn:${hit.objectID}`,
        source: 'hn',
        title: firstLine,
        company: hit.author,
        location: text.toLowerCase().includes('remote') ? 'Remote' : 'Unknown',
        url: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        postedAt: new Date(hit.created_at_i * 1000),
        tags: [],
        description: text.slice(0, 600),
      });
    }
  }

  // de-dupe by id
  const seen = new Set<string>();
  return all.filter((j) => (seen.has(j.id) ? false : (seen.add(j.id), true)));
}
