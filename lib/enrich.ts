import type { ContactEmail, ContactPerson } from './types';

/**
 * Automated contact enrichment via Hunter.io — the user's explicit call 2026-08-08
 * ("I don't want to do enrichment manually, it's a headache").
 *
 * WHY HUNTER AND NOT THE OTHERS (checked 2026-08-08):
 *  - People Data Labs gives 1,000 free records/month but **masks contact fields on the
 *    free tier** — emails come back as true/false flags, not addresses. Useless here.
 *  - Snov.io free is 50 credits/month; Apollo's 10k "export credits" come with accuracy
 *    caveats and gated API access.
 *  - Hunter returns the address WITH first/last name, position, seniority and a
 *    `decision_maker` flag, which is exactly "who is the founder and how do I reach them".
 *
 * 💰 THE CREDIT SPLIT IS THE WHOLE DESIGN. Hunter's free plan is ~25 searches/month, which
 * is nothing against 60+ funding rows. But the two endpoints bill differently:
 *
 *   domain-finder  → FREE, no credits. company name → domain.
 *   domain-search  → 1 CREDIT. domain → emails with names/positions.
 *
 * So domain resolution runs over EVERY row (it costs nothing and it is what the Google
 * News rows are missing — they currently have no website at all), and the credit-spending
 * lookup is bounded per call and never runs automatically over the whole queue.
 *
 * HUNTER_API_KEY unset → every function here returns empty, silently. Same contract as
 * SERPER_API_KEY and FIRECRAWL_API_KEY: an unconfigured optional key must not put a daily
 * error on the agent card.
 */

const API = 'https://api.hunter.io/v2';
const TIMEOUT_MS = 12_000;

export function enrichmentConfigured(): boolean {
  return !!process.env.HUNTER_API_KEY;
}

async function hunter<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const key = process.env.HUNTER_API_KEY;
  if (!key) return null;

  const qs = new URLSearchParams({ ...params, api_key: key });
  const res = await fetch(`${API}/${path}?${qs}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (res.status === 404) return null; // nothing found is not an error
  if (!res.ok) {
    const body = await res.text();
    // Hunter reports "out of credits" as 429 with a specific body; name it, because the
    // raw status alone reads like a rate limit the caller should retry.
    throw new Error(`hunter ${path} ${res.status}: ${body.slice(0, 160).replace(/\s+/g, ' ')}`);
  }
  return (await res.json()) as T;
}

type DomainFinderResponse = {
  data?: { results?: Array<{ domain?: string; company_name?: string; email_count?: number }> };
};

/**
 * Company name → its own domain. FREE (Hunter's domain-finder consumes no credits), so
 * this can run over the whole queue. `perfect_match` is deliberately OFF — startup names
 * in headlines rarely match the registered company name exactly — but the caller still
 * gets `emailCount` to judge whether the match looks real.
 */
export async function resolveDomain(
  company: string
): Promise<{ domain: string; matchedName: string; emailCount: number } | null> {
  if (!company || company.trim().length < 3) return null;

  const body = await hunter<DomainFinderResponse>('domain-finder', {
    company: company.trim(),
    limit: '3',
  });

  const top = body?.data?.results?.find((r) => r.domain);
  if (!top?.domain) return null;

  return {
    domain: top.domain,
    matchedName: top.company_name ?? company,
    emailCount: top.email_count ?? 0,
  };
}

type DomainSearchResponse = {
  data?: {
    domain?: string;
    emails?: Array<{
      value?: string;
      type?: string;
      confidence?: number;
      first_name?: string | null;
      last_name?: string | null;
      position?: string | null;
      seniority?: string | null;
      department?: string | null;
      decision_maker?: boolean | null;
    }>;
  };
};

export type EnrichedContacts = {
  domain: string;
  people: ContactPerson[];
  emails: ContactEmail[];
  /** Personal addresses attached to a named human — the only ones worth a founder pitch. */
  personalCount: number;
};

/**
 * Domain → the people worth writing to. **COSTS 1 CREDIT per call**, so callers must bound
 * how many rows they run this over.
 *
 * `type=personal` is requested at the API rather than filtered afterwards: a credit spent
 * returning `info@` and `support@` is a credit wasted, and the whole reason this module
 * exists is that shared inboxes are not founders. Results are ranked decision-makers and
 * executives first, then by Hunter's own confidence.
 */
export async function findPeopleEmails(domain: string): Promise<EnrichedContacts | null> {
  if (!domain) return null;

  const body = await hunter<DomainSearchResponse>('domain-search', {
    domain,
    limit: '10',
    type: 'personal',
  });

  const raw = body?.data?.emails ?? [];
  if (raw.length === 0) return null;

  const ranked = [...raw].sort((a, b) => {
    const rank = (e: (typeof raw)[number]) =>
      (e.decision_maker ? 0 : 2) + (e.seniority === 'executive' ? 0 : 1);
    const d = rank(a) - rank(b);
    return d !== 0 ? d : (b.confidence ?? 0) - (a.confidence ?? 0);
  });

  const people: ContactPerson[] = [];
  const emails: ContactEmail[] = [];

  for (const e of ranked) {
    if (!e.value) continue;
    const name = [e.first_name, e.last_name].filter(Boolean).join(' ').trim();
    if (name && !people.some((p) => p.name === name)) {
      people.push({ name, title: e.position ?? undefined });
    }
    emails.push({
      address: e.value.toLowerCase(),
      // `foundOn` normally records the page an address was scraped from. Hunter is not a
      // page, so record the provider and the confidence instead — a reader must always be
      // able to tell where an address came from before mailing a stranger.
      foundOn: `hunter.io (${e.confidence ?? '?'}% confidence${e.position ? `, ${e.position}` : ''})`,
    });
  }

  return {
    domain: body?.data?.domain ?? domain,
    people,
    emails,
    personalCount: emails.length,
  };
}
