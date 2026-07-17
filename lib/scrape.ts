import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import type { JdSource, ScrapedJd } from './types';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const MAX_TEXT_LEN = 12000;

export class ScrapeError extends Error {
  status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

export async function fetchHtml(url: string, timeoutMs?: number): Promise<string> {
  const res = await fetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml',
      'accept-language': 'en-US,en;q=0.9',
    },
    redirect: 'follow',
    signal: timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined,
  });
  if (!res.ok) {
    throw new ScrapeError(`fetch ${res.status} ${res.statusText}`, res.status);
  }
  return res.text();
}

function normaliseText(s: string): string {
  return s
    .replace(/ /g, ' ')
    .replace(/[\t\r ]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, MAX_TEXT_LEN);
}

function blockText($: cheerio.CheerioAPI, root: cheerio.Cheerio<AnyNode>): string {
  root.find('script, style, noscript, svg, nav, header, footer, form').remove();
  const html = root.html() ?? '';
  const withBreaks = html
    .replace(/<\/(p|div|li|h[1-6]|tr|br)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n');
  const stripped = withBreaks.replace(/<[^>]+>/g, '');
  return normaliseText(decodeEntities(stripped));
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function pickJsonLdJob($: cheerio.CheerioAPI): {
  title?: string;
  description?: string;
  company?: string;
} | null {
  const scripts = $('script[type="application/ld+json"]').toArray();
  for (const el of scripts) {
    const raw = $(el).contents().text();
    if (!raw) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      continue;
    }
    const candidates = Array.isArray(parsed) ? parsed : [parsed];
    for (const node of candidates) {
      const found = walkForJobPosting(node);
      if (found) return found;
    }
  }
  return null;
}

function walkForJobPosting(node: unknown): {
  title?: string;
  description?: string;
  company?: string;
} | null {
  if (!node || typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;
  const t = obj['@type'];
  const types = Array.isArray(t) ? t : [t];
  if (types.includes('JobPosting')) {
    const descHtml = typeof obj.description === 'string' ? obj.description : '';
    const description = normaliseText(decodeEntities(descHtml.replace(/<[^>]+>/g, ' ')));
    const title = typeof obj.title === 'string' ? obj.title : undefined;
    const org = obj.hiringOrganization;
    let company: string | undefined;
    if (org && typeof org === 'object' && 'name' in org) {
      const name = (org as Record<string, unknown>).name;
      if (typeof name === 'string') company = name;
    } else if (typeof org === 'string') {
      company = org;
    }
    return { title, description, company };
  }
  if (Array.isArray(obj['@graph'])) {
    for (const child of obj['@graph']) {
      const found = walkForJobPosting(child);
      if (found) return found;
    }
  }
  return null;
}

function detectHost(url: string): JdSource {
  let host = '';
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return 'generic';
  }
  if (host.endsWith('lever.co')) return 'lever';
  if (host.endsWith('greenhouse.io')) return 'greenhouse';
  if (host.endsWith('ashbyhq.com')) return 'ashby';
  if (host.endsWith('workable.com')) return 'workable';
  return 'generic';
}

function extractLever($: cheerio.CheerioAPI): Partial<ScrapedJd> {
  const title = $('.posting-headline h2, .section-wrapper h2').first().text().trim() || undefined;
  const company =
    $('a.main-header-logo img').attr('alt') ||
    $('meta[property="og:site_name"]').attr('content') ||
    undefined;
  const body = $('.section-wrapper, .content, [data-qa="job-description"]').first();
  const text = body.length ? blockText($, body) : blockText($, $('body'));
  return { title, company: company?.trim(), role: title, text };
}

function extractGreenhouse($: cheerio.CheerioAPI): Partial<ScrapedJd> {
  const title = $('.app-title, h1.app-title, .job__title h1, #header h1').first().text().trim() || undefined;
  const company =
    $('.company-name, .main-header__company-name').first().text().trim().replace(/^at\s+/i, '') ||
    $('meta[property="og:site_name"]').attr('content') ||
    undefined;
  const body = $('#content, .job__description, #job_description, .content').first();
  const text = body.length ? blockText($, body) : blockText($, $('body'));
  return { title, company: company || undefined, role: title, text };
}

function extractAshby($: cheerio.CheerioAPI): Partial<ScrapedJd> {
  const title =
    $('h1.ashby-job-posting-heading, .ashby-job-posting-heading, h1').first().text().trim() || undefined;
  const company = $('meta[property="og:site_name"]').attr('content') || undefined;
  const body = $('.ashby-job-posting-description, [class*="ashby-job-posting"]').first();
  const text = body.length ? blockText($, body) : blockText($, $('body'));
  return { title, company: company?.trim(), role: title, text };
}

function extractWorkable($: cheerio.CheerioAPI): Partial<ScrapedJd> {
  const title = $('h1[data-ui="job-title"], h1.job-title, h1').first().text().trim() || undefined;
  const company =
    $('[data-ui="company-name"]').first().text().trim() ||
    $('meta[property="og:site_name"]').attr('content') ||
    undefined;
  const body = $('[data-ui="job-description"], section.job-description, main').first();
  const text = body.length ? blockText($, body) : blockText($, $('body'));
  return { title, company: company || undefined, role: title, text };
}

function extractGeneric($: cheerio.CheerioAPI): Partial<ScrapedJd> {
  const ogTitle = $('meta[property="og:title"]').attr('content')?.trim();
  const docTitle = $('title').first().text().trim();
  const h1 = $('h1').first().text().trim();
  const title = ogTitle || h1 || docTitle || undefined;
  const company = $('meta[property="og:site_name"]').attr('content')?.trim();
  const main = $('main').first();
  const article = $('article').first();
  const root = main.length ? main : article.length ? article : $('body');
  const text = blockText($, root);
  return { title, company, role: title, text };
}

export async function scrapeJd(url: string): Promise<ScrapedJd> {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const host = detectHost(url);
  let partial: Partial<ScrapedJd> = {};
  let source: JdSource = host;

  switch (host) {
    case 'lever':
      partial = extractLever($);
      break;
    case 'greenhouse':
      partial = extractGreenhouse($);
      break;
    case 'ashby':
      partial = extractAshby($);
      break;
    case 'workable':
      partial = extractWorkable($);
      break;
    default:
      partial = extractGeneric($);
      source = 'generic';
  }

  if (!partial.text || partial.text.length < 200) {
    const ld = pickJsonLdJob($);
    if (ld && ld.description && ld.description.length > (partial.text?.length ?? 0)) {
      partial = {
        text: ld.description,
        title: partial.title ?? ld.title,
        company: partial.company ?? ld.company,
        role: partial.role ?? ld.title,
      };
      source = 'jsonld';
    }
  }

  if (!partial.text) {
    throw new ScrapeError('no extractable text');
  }

  return {
    text: partial.text,
    title: partial.title,
    company: partial.company,
    role: partial.role,
    source,
    scrapedAt: new Date().toISOString(),
    url,
  };
}
