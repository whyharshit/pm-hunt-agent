import * as cheerio from 'cheerio';
import type { Job } from '../types';

// We Work Remotely site-wide RSS. One request returns the ~100 most recent
// listings across all categories (10 per category); the strict intern/PM/ops
// filter in lib/filters.ts decides relevance. Every WWR job is remote by
// definition, so location defaults to Remote when no region is given.
const FEED_URL = 'https://weworkremotely.com/remote-jobs.rss';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function clean(s: string): string {
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#8217;|&#8216;/g, "'")
    .replace(/&#8220;|&#8221;/g, '"')
    .replace(/&#8211;|&#8212;/g, '–')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Split "Company: Position" into its two halves; falls back gracefully. */
function splitTitle(raw: string): { company: string; title: string } {
  const idx = raw.indexOf(':');
  if (idx === -1) return { company: 'Unknown', title: raw };
  const company = raw.slice(0, idx).trim();
  const title = raw.slice(idx + 1).trim();
  if (!company || !title) return { company: 'Unknown', title: raw };
  return { company, title };
}

/** Fetch + parse We Work Remotely's site-wide RSS into Job records (no LLM). */
export async function fetchWeWorkRemotely(): Promise<Job[]> {
  const res = await fetch(FEED_URL, {
    headers: { 'user-agent': UA, accept: 'application/rss+xml,application/xml,text/xml' },
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(`WeWorkRemotely feed fetch failed: ${res.status}`);

  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });

  const jobs: Job[] = [];
  const seen = new Set<string>();
  $('item').each((_, el) => {
    const item = $(el);
    const rawTitle = clean(item.find('title').first().text());
    const link =
      item.find('link').first().text().trim() || item.find('guid').first().text().trim();
    if (!rawTitle || !link) return;

    const { company, title } = splitTitle(rawTitle);
    const region = clean(item.find('region').first().text());
    const state = clean(item.find('state').first().text());
    const country = clean(item.find('country').first().text());
    const location = [region, state, country].filter(Boolean).join(', ') || 'Remote';
    const category = clean(item.find('category').first().text());
    const type = clean(item.find('type').first().text());
    const skills = clean(item.find('skills').first().text());
    const pub = item.find('pubDate').first().text().trim();
    const description = clean(item.find('description').first().text()).slice(0, 600);

    const slug = link.split('/').filter(Boolean).pop() ?? link;
    const id = `wwr:${slug}`;
    if (seen.has(id)) return;
    seen.add(id);

    const tags = [category, type, ...skills.split(',').map((s) => s.trim())].filter(Boolean);

    jobs.push({
      id,
      source: 'wwr',
      title,
      company,
      location,
      url: link,
      postedAt: pub ? new Date(pub) : new Date(),
      tags,
      description,
    });
  });

  return jobs;
}
