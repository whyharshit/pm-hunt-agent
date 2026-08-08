import * as cheerio from 'cheerio';
import type { AnyNode } from 'domhandler';
import { Type } from '@google/genai';
import { FLASH_MODEL, generateContent } from './gemini';
import { fetchHtml } from './scrape';
import { isUnresolvableNewsLink } from './sources/fundingnews';
import { stripTags } from './html';
import type { ContactEmail, ContactPerson, FundingContact, FundingItem } from './types';

const MODEL = FLASH_MODEL;
const ARTICLE_TIMEOUT_MS = 12_000;
const SITE_TIMEOUT_MS = 8_000;
const MAX_SITE_PAGES = 4;
const MAX_ARTICLE_TEXT = 8000;
const MAX_EMAILS = 6;

// Hosts that are never the startup's own site: press, social, infra, CDNs.
const NON_COMPANY_HOSTS = [
  'techcrunch.com', 'wp.com', 'wordpress.com', 'gravatar.com', 'automattic.com',
  'google.com', 'apple.com', 'yahoo.com', 'amazon.com', 'microsoft.com',
  'facebook.com', 'instagram.com', 'youtube.com', 'tiktok.com', 'reddit.com',
  'twitter.com', 'x.com', 'linkedin.com', 'github.com',
  'crunchbase.com', 'pitchbook.com', 'sec.gov', 'wikipedia.org',
  'medium.com', 'substack.com', 'bloomberg.com', 'reuters.com', 'wsj.com',
  'forbes.com', 'nytimes.com', 'theverge.com', 'wired.com', 'axios.com',
  'businessinsider.com', 'ft.com', 'cnbc.com', 'venturebeat.com',
];

const SOCIAL_HOSTS = ['twitter.com', 'x.com', 'linkedin.com', 'github.com', 'crunchbase.com'];

// Embedded posts/tweets quoted by the article — not the company's or founder's profile.
const SOCIAL_NOISE_RE = /linkedin\.com\/(posts|pulse|feed)\/|\/status\/|\/share\//i;

// Junk that matches the email shape: asset filenames (logo@2x.png), robots, vendor noise.
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,24}\b/g;
const EMAIL_REJECT =
  /(noreply|no-reply|donotreply|example\.(com|org)|sentry\.io|wixpress|\.(png|jpe?g|gif|webp|svg|css|js)$|@\d+x|schema\.org|w3\.org)/i;
const GENERIC_EMAIL =
  /^(info|hello|contact|support|team|admin|sales|press|hi|help|enquiries|inquiries|careers|jobs|hr|marketing|billing|noc|agent|no-?reply)@/i;

/**
 * A shared inbox, not a person. Worth knowing downstream: outreach addressed to a founder
 * that lands in `support@` is a support ticket, not an introduction — measured 2026-08-08,
 * every address this harvester found across 11 freshly-funded companies was one of these.
 * Callers use it to avoid reporting such a row as "ready to send to a founder".
 */
export function isGenericEmail(address: string): boolean {
  return GENERIC_EMAIL.test(address);
}

const CONTACT_LINK_RE = /contact|about|team|people|company/i;

function hostname(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function matchesHost(host: string, list: string[]): boolean {
  return list.some((h) => host === h || host.endsWith(`.${h}`));
}

function textOf(root: cheerio.Cheerio<AnyNode>): string {
  const clone = root.clone();
  clone.find('script, style, noscript, svg, aside, nav, footer, form').remove();
  return clone.text().replace(/\s+/g, ' ').trim().slice(0, MAX_ARTICLE_TEXT);
}

type ArticleFacts = { text: string; candidates: string[]; socials: string[] };

/** Pull the article's prose plus the outbound links it cites, split into company candidates vs socials. */
function readArticle(html: string): ArticleFacts {
  const $ = cheerio.load(html);
  let root: cheerio.Cheerio<AnyNode> = $('body');
  for (const sel of ['.article-content', '.entry-content', '.wp-block-post-content', 'article', 'main']) {
    const el = $(sel).first();
    if (el.length) {
      root = el;
      break;
    }
  }

  const candidates: string[] = [];
  const socials: string[] = [];
  root.find('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('#')) return;
    const host = hostname(href);
    if (!host) return;
    if (matchesHost(host, SOCIAL_HOSTS)) {
      if (!SOCIAL_NOISE_RE.test(href) && !socials.includes(href)) socials.push(href);
      return;
    }
    if (matchesHost(host, NON_COMPANY_HOSTS)) return;
    if (!candidates.includes(host)) candidates.push(host);
  });

  return { text: textOf(root), candidates: candidates.slice(0, 25), socials: socials.slice(0, 8) };
}

const EXTRACT_SYSTEM = `You read a startup funding-announcement article and work out who to contact at the startup that RAISED the money.

Rules:
- founders: people the article names as working AT that startup — founder, co-founder, CEO, CTO, COO, president or similar. Copy each name exactly as written. Never include investors, VC partners, board members, analysts, or the article's author. If the article names nobody at the startup, return an empty list.
- website: the startup's own site. Choose ONLY from CANDIDATE DOMAINS. If none of them is clearly the startup's own site, return "".
- Never output an email address. Never output a name or domain that is not present in the input.`;

const extractSchema = {
  type: Type.OBJECT,
  properties: {
    founders: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          name: { type: Type.STRING },
          title: { type: Type.STRING },
        },
        required: ['name', 'title'],
        propertyOrdering: ['name', 'title'],
      },
    },
    website: { type: Type.STRING },
  },
  required: ['founders', 'website'],
  propertyOrdering: ['founders', 'website'],
};

type Extracted = { founders: ContactPerson[]; website: string };

async function extractPeople(item: FundingItem, facts: ArticleFacts): Promise<Extracted> {
  const prompt = [
    `STARTUP THAT RAISED: ${item.company}`,
    '',
    'CANDIDATE DOMAINS (pick the website from this list only):',
    facts.candidates.length ? facts.candidates.map((c) => `- ${c}`).join('\n') : '- (none)',
    '',
    'ARTICLE:',
    facts.text,
  ].join('\n');

  const response = await generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      systemInstruction: EXTRACT_SYSTEM,
      responseMimeType: 'application/json',
      responseSchema: extractSchema,
      temperature: 0.1,
    },
  });

  const text = response.text;
  if (!text) throw new Error('Gemini returned empty response');
  const parsed = JSON.parse(text) as { founders?: Array<{ name?: string; title?: string }>; website?: string };

  const founders: ContactPerson[] = (parsed.founders ?? [])
    .filter((f) => f?.name?.trim())
    .map((f) => ({ name: f.name!.trim(), title: f.title?.trim() || undefined }))
    .slice(0, 5);

  // Pin the domain to one the article actually linked — otherwise it's a hallucination.
  const raw = parsed.website?.trim() ?? '';
  const host = raw ? hostname(raw.startsWith('http') ? raw : `https://${raw}`) : '';
  const website = host && facts.candidates.includes(host) ? `https://${host}` : '';

  return { founders, website };
}

function harvestEmails(pageUrl: string, html: string, into: Map<string, string>): void {
  const $ = cheerio.load(html);
  const push = (raw: string) => {
    const address = raw.trim().toLowerCase().replace(/^mailto:/, '').split('?')[0];
    if (!address || EMAIL_REJECT.test(address)) return;
    if (!into.has(address)) into.set(address, pageUrl);
  };
  $('a[href^="mailto:"]').each((_, el) => {
    const href = $(el).attr('href');
    if (href) push(href);
  });
  for (const m of stripTags(html).matchAll(EMAIL_RE)) push(m[0]);
}

/** Same-domain personal addresses first, generic inboxes last. */
function rankEmails(emails: ContactEmail[], siteHost: string): ContactEmail[] {
  const score = (e: ContactEmail): number => {
    const domain = e.address.split('@')[1] ?? '';
    const own = domain === siteHost || domain.endsWith(`.${siteHost}`);
    return (own ? 0 : 2) + (GENERIC_EMAIL.test(e.address) ? 1 : 0);
  };
  return [...emails].sort((a, b) => score(a) - score(b));
}

async function collectEmails(website: string): Promise<{ emails: ContactEmail[]; note?: string }> {
  const found = new Map<string, string>();

  let homeHtml: string;
  try {
    homeHtml = await fetchHtml(website, SITE_TIMEOUT_MS);
  } catch (e) {
    return { emails: [], note: `site unreachable (${(e as Error).message})` };
  }
  harvestEmails(website, homeHtml, found);

  const $ = cheerio.load(homeHtml);
  const host = hostname(website);
  const next: string[] = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href || href.startsWith('mailto:')) return;
    let abs: string;
    try {
      abs = new URL(href, website).toString();
    } catch {
      return;
    }
    if (hostname(abs) !== host) return;
    if (!CONTACT_LINK_RE.test(`${href} ${$(el).text()}`)) return;
    if (abs === website || next.includes(abs)) return;
    next.push(abs);
  });

  for (const url of next.slice(0, MAX_SITE_PAGES - 1)) {
    try {
      harvestEmails(url, await fetchHtml(url, SITE_TIMEOUT_MS), found);
    } catch {
      // a missing /contact or /team is normal — keep whatever the other pages gave us
    }
  }

  const emails = [...found].map(([address, foundOn]) => ({ address, foundOn }));
  return { emails: rankEmails(emails, host).slice(0, MAX_EMAILS) };
}

/**
 * Work out who to approach at a freshly-funded company: read the announcement for
 * founder names + the company's own site, then harvest real published addresses off
 * that site. Every email returned was literally present on a page we fetched — nothing
 * here guesses `first@domain`, because a bounced cold email costs more than a missing one.
 */
export async function findContact(item: FundingItem): Promise<FundingContact> {
  // A Google News link is a JavaScript interstitial, not the article (see
  // lib/sources/fundingnews.ts). Scraping it yields Angular source, and asking Gemini to
  // find a founder in that would waste one of a very small daily quota. Say so instead.
  if (isUnresolvableNewsLink(item.url)) {
    return {
      id: item.id,
      founders: [],
      emails: [],
      socials: [],
      foundAt: new Date().toISOString(),
      model: 'none',
      note: 'Google News link — open it in the browser to reach the article; automated contact lookup cannot follow it',
    };
  }

  const html = await fetchHtml(item.url, ARTICLE_TIMEOUT_MS);
  const facts = readArticle(html);
  const { founders, website } = await extractPeople(item, facts);

  const notes: string[] = [];
  let emails: ContactEmail[] = [];

  if (website) {
    const res = await collectEmails(website);
    emails = res.emails;
    if (res.note) notes.push(res.note);
    else if (emails.length === 0) notes.push('no public email on the site');
  } else {
    notes.push('no company site linked in the article');
  }
  if (founders.length === 0) notes.push('article names nobody at the company');

  return {
    id: item.id,
    founders,
    website: website || undefined,
    emails,
    socials: facts.socials,
    foundAt: new Date().toISOString(),
    model: MODEL,
    note: notes.length ? notes.join(' · ') : undefined,
  };
}
