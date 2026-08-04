import * as cheerio from 'cheerio';
import type { Job } from '../types';

// Internshala — India's intern-dense board, server-rendered HTML (no API).
// We fetch the WORK-FROM-HOME category pages on purpose: most Internshala listings
// are in-office India and would (correctly) die on the remote gate; the WFH pages
// keep the fetch honest instead of fetching 5× and filtering 90% away. The VC page
// is a keyword search (no VC category exists) so it's mixed-location — the remote
// gate sorts it out.
const PAGES = [
  'https://internshala.com/internships/work-from-home-product-management-internships/',
  'https://internshala.com/internships/work-from-home-data-science-internships/',
  'https://internshala.com/internships/work-from-home-operations-internships/',
  'https://internshala.com/internships/work-from-home-machine-learning-internships/',
  'https://internshala.com/internships/keywords-venture-capital/',
];

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** "Today" / "3 days ago" / "1 week ago" → a Date. Unknown shapes fall back to now. */
function parsePostedAt(text: string): Date {
  const t = text.trim().toLowerCase();
  const now = Date.now();
  if (!t || t === 'today' || t.includes('hour') || t === 'just now') return new Date(now);
  const m = t.match(/(\d+)\s+(day|week|month)/);
  if (!m) return new Date(now);
  const n = Number(m[1]);
  const unit = m[2] === 'day' ? 1 : m[2] === 'week' ? 7 : 30;
  return new Date(now - n * unit * 24 * 60 * 60 * 1000);
}

/** Fetch + parse Internshala WFH category pages into Job records (no LLM). */
export async function fetchInternshala(): Promise<Job[]> {
  const jobs: Job[] = [];
  const seen = new Set<string>();
  const failures: string[] = [];

  const pages = await Promise.all(
    PAGES.map(async (url) => {
      try {
        const res = await fetch(url, {
          headers: { 'user-agent': UA, accept: 'text/html' },
          next: { revalidate: 0 },
        });
        if (!res.ok) throw new Error(`${res.status}`);
        return await res.text();
      } catch (e) {
        failures.push(`${url.split('/').filter(Boolean).pop()}: ${(e as Error).message}`);
        return null;
      }
    })
  );

  for (const html of pages) {
    if (!html) continue;
    const $ = cheerio.load(html);

    $('.individual_internship').each((_, el) => {
      const card = $(el);
      const internshipId = card.attr('internshipid');
      const href = card.attr('data-href') || card.find('a.job-title-href').attr('href') || '';
      const rawTitle = card.find('.job-internship-name a').first().text().trim();
      if (!internshipId || !href || !rawTitle) return;

      const id = `internshala:${internshipId}`;
      if (seen.has(id)) return;
      seen.add(id);

      const company = card.find('.company-name').first().text().trim() || 'Unknown';
      const location = card.find('.locations span').first().text().trim() || 'India';
      const stipend = card.find('.stipend').first().text().trim();
      // The user wants PAID internships; Internshala marks the rest explicitly.
      if (/unpaid/i.test(stipend)) return;

      const about = card.find('.about_job .text').first().text().replace(/\s+/g, ' ').trim();
      const skills = card
        .find('.job_skill')
        .map((_, s) => $(s).text().trim())
        .get();
      const posted = card.find('.status-success span, .status-info span').first().text().trim();

      // Internshala titles are bare role names ("Product Management", "ECommerce") —
      // every listing IS an internship, so append the word the title-anchored
      // intern filter needs. Skip when the poster already wrote it.
      const title = /\bintern(ship)?\b/i.test(rawTitle) ? rawTitle : `${rawTitle} Internship`;

      jobs.push({
        id,
        source: 'internshala',
        title,
        company,
        location,
        url: new URL(href, 'https://internshala.com').toString(),
        postedAt: parsePostedAt(posted),
        tags: [stipend, ...skills].filter(Boolean),
        description: about.slice(0, 600),
      });
    });
  }

  // All pages failing means the site changed or blocked us — surface it as an error
  // so the run summary says so; partial failure just yields fewer jobs.
  if (jobs.length === 0 && failures.length === PAGES.length) {
    throw new Error(`all pages failed: ${failures.join('; ')}`);
  }

  return jobs;
}
