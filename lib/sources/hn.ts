import { htmlToText } from '../html';
import type { Job } from '../types';

const ALGOLIA = 'https://hn.algolia.com/api/v1';
const MAX_DESC = 1500;
const MIN_TEXT = 60;

type StoryHit = { objectID: string; title: string; created_at_i: number };
type SearchResponse = { hits: StoryHit[] };

type ItemComment = {
  id: number;
  author: string | null;
  text: string | null;
  created_at_i: number;
  children?: ItemComment[];
};
type ItemResponse = { id: number; title: string | null; children?: ItemComment[] };

/** Newest "Ask HN: Who is hiring?" — never "Who wants to be hired?", which is the inverse thread. */
async function findLatestThread(): Promise<StoryHit | null> {
  const res = await fetch(
    `${ALGOLIA}/search_by_date?tags=story,author_whoishiring&hitsPerPage=10`,
    { next: { revalidate: 0 } }
  );
  if (!res.ok) throw new Error(`HN story search failed: ${res.status}`);
  const data = (await res.json()) as SearchResponse;
  return (
    data.hits.find((h) => /who is hiring/i.test(h.title) && !/wants to be hired/i.test(h.title)) ??
    null
  );
}

/** Algolia hands back URLs as entity-encoded plain text, not <a href> anchors — decode, then match. */
function firstLink(html: string): string | undefined {
  const m = htmlToText(html).match(/https?:\/\/[^\s"'<>)\]]+/);
  return m ? m[0].replace(/[.,;]+$/, '') : undefined;
}

/**
 * Pipes are the real convention (248 of 278 posts). Dashes are a fallback and must be
 * space-delimited: an unspaced en-dash is a number range ("20–25% equity"), not a separator.
 */
function splitHeader(header: string): string[] {
  const piped = header.split(/\s*\|\s*/).map((s) => s.trim()).filter(Boolean);
  if (piped.length > 1) return piped;
  return header.split(/\s+[–—-]\s+/).map((s) => s.trim()).filter(Boolean);
}

/**
 * HN's convention: everything before the first <p> is the header line, formatted
 * "Company | Role | Location | Salary | URL" (248 of 278 posts in the July 2026
 * thread use pipes; a handful use dashes; ~27 freeform it).
 */
function parseComment(c: ItemComment, threadTitle: string): Job | null {
  if (!c.text) return null;
  const headerRaw = c.text.split(/<p>/i)[0] ?? '';
  const header = htmlToText(headerRaw).replace(/\n/g, ' ').trim();
  const text = htmlToText(c.text);
  if (text.length < MIN_TEXT || !header) return null;

  const parts = splitHeader(header);
  const company = (parts[0] ?? c.author ?? 'unknown').slice(0, 80);
  const rest = parts.slice(1);

  // Title carries the role signal the filters key on. HN puts role/location/salary in
  // no fixed order, so hand the filters the whole header minus the company rather than
  // betting on parts[1] being the role.
  const title = (rest.length ? rest.join(' | ') : header).slice(0, 200);

  const location =
    rest.find((p) => /\b(remote|anywhere|worldwide|distributed|hybrid|onsite|us|eu)\b/i.test(p)) ??
    (/\bremote\b/i.test(text) ? 'Remote' : '');

  return {
    id: `hn:${c.id}`,
    source: 'hn',
    title,
    company,
    location,
    url: `https://news.ycombinator.com/item?id=${c.id}`,
    applyUrl: firstLink(c.text),
    postedAt: new Date(c.created_at_i * 1000),
    tags: [...rest, threadTitle].slice(0, 12),
    description: text.slice(0, MAX_DESC),
  };
}

/**
 * Pull the current month's "Ask HN: Who is hiring?" thread and turn each top-level
 * comment into a Job. Replies are ignored — only top-level comments are postings.
 */
export async function fetchHnWhoIsHiring(): Promise<Job[]> {
  const story = await findLatestThread();
  if (!story) throw new Error('no "Who is hiring?" thread found');

  const res = await fetch(`${ALGOLIA}/items/${story.objectID}`, { next: { revalidate: 0 } });
  if (!res.ok) throw new Error(`HN thread fetch failed: ${res.status}`);
  const item = (await res.json()) as ItemResponse;

  const jobs: Job[] = [];
  for (const child of item.children ?? []) {
    const job = parseComment(child, story.title);
    if (job) jobs.push(job);
  }
  return jobs;
}
