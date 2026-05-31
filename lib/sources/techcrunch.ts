import * as cheerio from 'cheerio';
import { urlId } from '../storage';

const FEED_URL = 'https://techcrunch.com/tag/funding/feed/';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export type FundingRaw = {
  sourceId: string;
  title: string;
  summary: string;
  url: string;
  postedAt: string;
};

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

/** Fetch + parse TechCrunch's "funding" tag RSS into raw items (no LLM here). */
export async function fetchTechCrunchFunding(): Promise<FundingRaw[]> {
  const res = await fetch(FEED_URL, {
    headers: { 'user-agent': UA, accept: 'application/rss+xml,application/xml,text/xml' },
    next: { revalidate: 0 },
  });
  if (!res.ok) throw new Error(`TechCrunch feed fetch failed: ${res.status}`);

  const xml = await res.text();
  const $ = cheerio.load(xml, { xmlMode: true });

  const items: FundingRaw[] = [];
  $('item').each((_, el) => {
    const item = $(el);
    const title = clean(item.find('title').first().text());
    const link = item.find('link').first().text().trim() || item.find('guid').first().text().trim();
    const pub = item.find('pubDate').first().text().trim();
    const summary = clean(item.find('description').first().text()).slice(0, 600);
    if (!title || !link) return;
    const postedAt = pub ? new Date(pub).toISOString() : new Date().toISOString();
    items.push({ sourceId: urlId(link), title, summary, url: link, postedAt });
  });

  return items;
}
