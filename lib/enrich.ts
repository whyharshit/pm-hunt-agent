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
 * 💰 THE CREDIT SPLIT IS THE WHOLE DESIGN. Hunter's free plan is 50 searches/month per
 * ACCOUNT (measured, not the 25 the pricing pages imply), so the user's two keys give 100
 * — still finite against a queue of ~100 rows. The two endpoints bill differently:
 *
 *   domain-finder  → FREE, no credits. company name → domain.
 *   domain-search  → 1 CREDIT. domain → emails with names/positions.
 *
 * So domain resolution runs over EVERY row (it costs nothing and it is what the Google
 * News rows are missing — they currently have no website at all), and the credit-spending
 * lookup is bounded per call and never runs automatically over the whole queue.
 *
 * HUNTER_API_KEYS unset → every function here returns empty, silently. Same contract as
 * SERPER_API_KEY and FIRECRAWL_API_KEY: an unconfigured optional key must not put a daily
 * error on the agent card.
 */

const API = 'https://api.hunter.io/v2';
const TIMEOUT_MS = 12_000;

/**
 * Keys are pooled exactly like the Gemini ones, and for the same reason: the free plan is
 * per ACCOUNT, so two keys on two teams are two quotas. Verified 2026-08-08 — the user's
 * two keys sit on teams 7289318 and 7289333 with 50 searches each, so the pool is 100
 * searches/month, not 50. Two keys on ONE team would pool to nothing.
 */
export function hunterKeys(): string[] {
  const raw = [process.env.HUNTER_API_KEYS ?? '', process.env.HUNTER_API_KEY ?? ''].join(',');
  return [...new Set(raw.split(/[,\s]+/).map((k) => k.trim()).filter(Boolean))];
}

export function enrichmentConfigured(): boolean {
  return hunterKeys().length > 0;
}

/** Out of credits, or the key is refused — either way, try the next key. */
function isKeyExhausted(status: number, body: string): boolean {
  return status === 429 || status === 401 || /usage limit|out of (search|request)|upgrade/i.test(body);
}

async function hunter<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const keys = hunterKeys();
  if (keys.length === 0) return null;

  let lastError = '';
  for (const key of keys) {
    const qs = new URLSearchParams({ ...params, api_key: key });
    const res = await fetch(`${API}/${path}?${qs}`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (res.status === 404) return null; // nothing found is not an error
    if (res.ok) return (await res.json()) as T;

    const body = await res.text();
    lastError = `hunter ${path} ${res.status}: ${body.slice(0, 160).replace(/\s+/g, ' ')}`;
    // A spent or refused key is the next key's problem, not the caller's. Anything else
    // (a bad domain, a malformed request) fails identically on every key — stop now.
    if (!isKeyExhausted(res.status, body)) throw new Error(lastError);
  }

  throw new Error(`all ${keys.length} Hunter key(s) exhausted — ${lastError}`);
}

/** Per-key credit balance, straight from Hunter. Free call — never spends a search. */
export async function hunterBalance(): Promise<
  Array<{ key: string; plan: string; searchesLeft: number; searchesUsed: number }>
> {
  const out = [];
  for (const key of hunterKeys()) {
    try {
      const res = await fetch(`${API}/account?api_key=${key}`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const d = (await res.json()).data as {
        plan_name?: string;
        requests?: { searches?: { used?: number; available?: number } };
      };
      out.push({
        key: `…${key.slice(-6)}`,
        plan: d.plan_name ?? '?',
        searchesLeft: (d.requests?.searches?.available ?? 0) - (d.requests?.searches?.used ?? 0),
        searchesUsed: d.requests?.searches?.used ?? 0,
      });
    } catch {
      // a key that can't report its balance still might work; don't fail the whole check
    }
  }
  return out;
}

/**
 * ⚠️ `data` is the ARRAY itself — NOT `data.results`. Hunter's published API reference
 * describes a `results` wrapper for this endpoint and it is wrong; the live response
 * (checked 2026-08-08) is `{ "data": [ { domain, company_name, logo, email_count } ] }`.
 * Trusting the docs here silently returned "no match" for every company.
 */
type DomainFinderResponse = {
  data?: Array<{ domain?: string; company_name?: string; email_count?: number }>;
};

/** "Consint.AI" and "consint.ai" must compare equal, so strip everything but letters/digits. */
const flatten = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export type DomainResolution =
  | { kind: 'resolved'; domain: string; matchedName: string; emailCount: number }
  | { kind: 'ambiguous'; candidates: string[] }
  | { kind: 'none' };

/**
 * Company name → its own domain. FREE (domain-finder consumes no credits), so this runs
 * over the whole queue.
 *
 * ⚠️ IT REFUSES TO GUESS, and that is the point. Two earlier attempts were wrong in ways
 * that would have produced real damage (all measured 2026-08-08):
 *
 *  - Picking the candidate with the most known emails resolved "Adiabatic Technologies"
 *    to **infineon.com** (10,107 addresses) — the semiconductor giant, not the startup that
 *    raised ₹8.3 Cr. That draft would have congratulated Infineon on someone else's seed
 *    round.
 *  - Even with `perfect_match=true`, "Hulp" returns hulp.chat / hulp.work / hulp.nl /
 *    hulp.in and "Vingo" returns five country TLDs. Choosing among those is a coin flip.
 *
 * So: accept only when the answer is unambiguous — a single candidate, or exactly one whose
 * domain matches the company name outright. Otherwise report the candidates and let a human
 * decide. A guessed domain is upstream of a guessed email address, and this project's
 * standing rule is that contacts are never guessed.
 *
 * `emailCount` also lets the caller skip the paid lookup: a domain Hunter knows 0 addresses
 * for returns nothing from domain-search, so spending a credit on it is pure waste.
 */
export async function resolveDomain(company: string): Promise<DomainResolution> {
  if (!company || company.trim().length < 3) return { kind: 'none' };

  const body = await hunter<DomainFinderResponse>('domain-finder', {
    company: company.trim(),
    perfect_match: 'true',
    limit: '5',
  });

  const candidates = (body?.data ?? []).filter((r) => r.domain);
  if (candidates.length === 0) return { kind: 'none' };

  const accept = (r: (typeof candidates)[number]) => ({
    kind: 'resolved' as const,
    domain: r.domain!,
    matchedName: r.company_name ?? company,
    emailCount: r.email_count ?? 0,
  });

  if (candidates.length === 1) return accept(candidates[0]);

  // "Consint.AI" → consint.ai, and "Smallest.ai" → smallest.ai, both exact once flattened.
  const target = flatten(company);
  const exact = candidates.filter(
    (r) => flatten(r.domain!) === target || flatten(r.domain!.split('.')[0]) === target
  );
  if (exact.length === 1) return accept(exact[0]);

  return { kind: 'ambiguous', candidates: candidates.map((r) => `${r.domain} (${r.email_count ?? 0})`) };
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
