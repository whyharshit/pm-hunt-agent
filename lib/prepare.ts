import { findContact } from './contact';
import { enrichmentConfigured, findPeopleEmails, resolveDomain } from './enrich';
import { draftOutreach } from './funding';
import { resolveDomainViaSearch } from './sources/fundingnews';
import { MAX_AGE_DAYS } from './sources/techcrunch';
import {
  getFundingContacts,
  getFundingOutreaches,
  getRecentFunding,
  saveFundingContact,
  saveFundingOutreach,
} from './storage';
import type { ContactPerson, ContactEmail } from './types';

/**
 * The middle of the outreach pipeline: company → domain → people → draft.
 *
 * WHY THIS FILE EXISTS
 * Discovery ran on a cron and sending ran on a cron, but the two steps BETWEEN them —
 * enrichment and draft preparation — only ever ran when a human curled
 * `/api/admin?action=enrich` and `?action=prepare-outreach`. So the unattended sender woke
 * every morning to rows that had no contact and no draft, found nothing eligible, and mailed
 * nobody. Measured 2026-08-13: 5 sends on Aug 8–9 (right after a manual run), then four
 * silent days, `eligible: 0`, with 47 of 143 rows having no draft and 29 holding a contact
 * record with no addresses in it. The loop looked automated and was not.
 *
 * The logic here is LIFTED, not rewritten, from those two admin actions, and both of them
 * now call these functions. One implementation is the point: the cron and the manual button
 * must spend credits, pick founders and skip stale rows identically, or the dry run a human
 * inspects stops describing what the cron actually does.
 *
 * NOTHING HERE SENDS EMAIL. It writes contacts and drafts; `runAutoSend` decides what leaves
 * the building, and its gates are unchanged.
 */

/** Wall-clock ceiling for a pass. Returns true once the caller should stop starting work. */
function expired(deadline: number | null): boolean {
  return deadline !== null && Date.now() > deadline;
}

// ---------------------------------------------------------------------------
// Enrichment — company name → domain (free) → named people + addresses (paid)
// ---------------------------------------------------------------------------

export type EnrichPassResult = {
  configured: boolean;
  domainsFound: number;
  searchResolved: number;
  ambiguousDomains: number;
  ambiguous: Array<{ company: string; candidates: string[] }>;
  creditsSpent: number;
  peopleFound: number;
  errors: string[];
  results: Array<Record<string, unknown>>;
  /** Rows whose paid lookup was withheld because only a web search knew their domain. */
  skippedUnverified: number;
  /** True when the pass stopped on its clock rather than running the queue out. */
  timedOut: boolean;
};

export type EnrichPassOptions = {
  /** Hunter search credits this pass may spend. 0 = free domain phase only. */
  spendBudget: number;
  /** Epoch ms after which no further row is started. null = no clock (manual runs). */
  deadline?: number | null;
  /**
   * Skip the PAID phase on rows whose domain a web search merely guessed.
   *
   * `runAutoSend`'s `domainUnverified` gate refuses to mail those rows at all (the Amigo
   * near-miss: search resolved a Kolkata startup to an unrelated American company and Hunter
   * cheerfully returned its staff). Spending a credit to harvest addresses that the sender
   * is then forbidden to use is pure waste, and the pool is ~100 searches a MONTH.
   *
   * True on the cron, false for a manual `?action=enrich&spend=N` — there a human has asked
   * to spend, and seeing the people is how they decide whether the domain is even right.
   */
  skipUnverifiedDomains?: boolean;
};

/**
 * Fill in the contact details the article scrape could not get.
 *
 * Two phases, and the split matters: Hunter's domain-finder is FREE and its domain-search
 * costs a credit, so every row gets a domain and only `spendBudget` rows get people. The
 * free plan is ~50 searches per ACCOUNT per month and the key pool is small, so an unbounded
 * spend here would empty the month's quota on whatever sat at the top of the queue.
 */
export async function runEnrichPass(opts: EnrichPassOptions): Promise<EnrichPassResult> {
  const deadline = opts.deadline ?? null;
  const empty: EnrichPassResult = {
    configured: enrichmentConfigured(),
    domainsFound: 0,
    searchResolved: 0,
    ambiguousDomains: 0,
    ambiguous: [],
    creditsSpent: 0,
    peopleFound: 0,
    errors: [],
    results: [],
    skippedUnverified: 0,
    timedOut: false,
  };
  if (!empty.configured) return empty;

  const items = await getRecentFunding(200);
  const contacts = await getFundingContacts(items.map((i) => i.id));

  // Newest first: a fresher raise is a better cold-outreach target, so if the credit
  // budget runs out it should run out on the oldest rows.
  const ordered = [...items].sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));

  let domainsFound = 0;
  let searchResolved = 0;
  let credited = 0;
  let peopleFound = 0;
  let skippedUnverified = 0;
  let timedOut = false;
  const results: Array<Record<string, unknown>> = [];
  const ambiguous: Array<{ company: string; candidates: string[] }> = [];
  const errors: string[] = [];

  for (const item of ordered) {
    if (item.status !== 'new') continue;
    const existing = contacts.get(item.id);
    const alreadyHasPerson =
      (existing?.emails.length ?? 0) > 0 && (existing?.founders.length ?? 0) > 0;
    if (alreadyHasPerson) continue;

    // The free phase is not free of TIME: an unresolved row costs a Hunter call plus a
    // Serper call, and on the cron this pass shares one 300s invocation with the scan, the
    // sends and an IMAP session. Stop starting rows rather than let the function be killed
    // mid-write with the sends still ahead of it.
    if (expired(deadline)) {
      timedOut = true;
      break;
    }

    try {
      // --- free phase: establish the company's own domain ---
      // A website already on the row came from a link inside the funding article, so it
      // has real provenance and always beats a name lookup.
      let domain = existing?.website?.replace(/^https?:\/\//, '') ?? '';
      let note = existing?.note;
      let knownEmails = domain ? 1 : 0; // unknown for article-derived domains; assume worth a look

      if (!domain) {
        const found = await resolveDomain(item.company);

        if (found.kind === 'resolved') {
          domain = found.domain;
          knownEmails = found.emailCount;
          domainsFound++;
          if (found.matchedName.toLowerCase() !== item.company.toLowerCase()) {
            note = `domain resolved from company name — Hunter matched "${found.matchedName}"; confirm it is the right company`;
          }
        } else {
          // Hunter could not decide (or found nothing). A search engine can: it was
          // 41 of 83 fresh rows stuck on exactly this, and the Serper key is already
          // paid for. Still no guessing — the searcher requires the domain to relate to
          // the company name and skips press and directory hosts.
          const viaSearch = await resolveDomainViaSearch(item.company).catch(() => null);
          if (viaSearch) {
            domain = viaSearch;
            knownEmails = 1; // unknown to Hunter yet; worth one lookup
            domainsFound++;
            note = `domain found by web search (${viaSearch})`;
            searchResolved++;
          } else if (found.kind === 'ambiguous') {
            await saveFundingContact(item.id, {
              id: item.id,
              founders: existing?.founders ?? [],
              website: existing?.website,
              emails: existing?.emails ?? [],
              socials: existing?.socials ?? [],
              foundAt: new Date().toISOString(),
              model: 'hunter.io',
              note: `domain ambiguous — candidates: ${found.candidates.join(', ')}; pick one by hand`,
            });
            ambiguous.push({ company: item.company, candidates: found.candidates });
            continue;
          } else {
            continue;
          }
        }
      }

      let people: ContactPerson[] = existing?.founders ?? [];
      let emails: ContactEmail[] = existing?.emails ?? [];

      // A domain a search engine guessed is one the sender will refuse to mail, so on the
      // cron a credit spent here can never turn into an email. Counted, not silent, or the
      // pass reports "0 people found" and looks broken rather than thrifty.
      const guessedDomain = /found by web search/i.test(note ?? '');
      if (opts.skipUnverifiedDomains && guessedDomain) skippedUnverified++;

      // --- paid phase: bounded, and never spent on a domain with nothing to return ---
      if (
        credited < opts.spendBudget &&
        knownEmails > 0 &&
        !(opts.skipUnverifiedDomains && guessedDomain)
      ) {
        credited++;
        const enriched = await findPeopleEmails(domain);
        if (enriched) {
          // NEVER replace a founder the ARTICLE named. The funding announcement says who
          // founded the company; Hunter only ranks by seniority over whoever it has
          // scraped. On Omilia that swap put "Hi Petr" (an exec) on an email that should
          // have greeted Dimitris Vassos, the founder the article named. Article-derived
          // people lead; Hunter's are appended for their addresses.
          const known = new Set(people.map((p) => p.name.toLowerCase()));
          people = [...people, ...enriched.people.filter((p) => !known.has(p.name.toLowerCase()))];
          emails = enriched.emails.length ? enriched.emails : emails;
          peopleFound += enriched.people.length;
        }
      }

      await saveFundingContact(item.id, {
        id: item.id,
        founders: people,
        website: `https://${domain}`,
        emails,
        socials: existing?.socials ?? [],
        foundAt: new Date().toISOString(),
        model: 'hunter.io',
        note,
      });

      results.push({
        id: item.id,
        company: item.company,
        domain,
        knownEmails,
        founders: people.map((p) => p.name),
        emails: emails.map((e) => e.address),
      });
    } catch (e) {
      const msg = (e as Error).message;
      errors.push(`${item.company}: ${msg}`);
      // Out of credits or rate-limited: stop rather than hammer the API for every row.
      if (/\b429\b|credit/i.test(msg)) break;
    }
  }

  return {
    configured: true,
    domainsFound,
    searchResolved,
    ambiguousDomains: ambiguous.length,
    ambiguous,
    creditsSpent: credited,
    peopleFound,
    errors,
    results,
    skippedUnverified,
    timedOut,
  };
}

// ---------------------------------------------------------------------------
// Draft preparation — contact lookup + the outreach draft itself
// ---------------------------------------------------------------------------

export type DraftPassResult = {
  prepared: number;
  withEmail: number;
  failed: Array<{ id: string; company: string; error: string }>;
  rateLimited: boolean;
  remaining: number;
  skippedStale: { count: number; maxAgeDays: number; items: string[] };
  results: Array<Record<string, unknown>>;
  timedOut: boolean;
};

export type DraftPassOptions = {
  /** Rows to draft this pass. 0 = off. */
  limit: number;
  /** Epoch ms after which no further row is started. null = no clock (manual runs). */
  deadline?: number | null;
};

/**
 * Write the cold-outreach draft for rows that do not have one.
 *
 * Stale rows are skipped rather than drafted: `MAX_AGE_DAYS` is the same gate `runAutoSend`
 * applies, so drafting past it would spend Gemini quota on rows that can never be sent.
 */
export async function runDraftPass(opts: DraftPassOptions): Promise<DraftPassResult> {
  const deadline = opts.deadline ?? null;
  const items = await getRecentFunding(200);
  const existing = await getFundingOutreaches(items.map((i) => i.id));

  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  const stale: string[] = [];
  const queue = items.filter((i) => {
    if (i.status !== 'new' || existing.has(i.id)) return false;
    if (Date.parse(i.postedAt) < cutoff) {
      stale.push(`${i.company} (${i.postedAt.slice(0, 10)})`);
      return false;
    }
    return true;
  });

  const batch = queue.slice(0, Math.max(0, opts.limit));

  // SEQUENTIAL, not Promise.all. The Gemini free tier allows 5 requests/minute for
  // gemini-2.5-flash and each row costs 2 calls, so a parallel batch of 5 rows fires 10
  // calls at once and 3 of them 429 — measured, not theoretical. Running in series keeps
  // us under the limit, and a 429 stops the batch rather than burning the rest of the
  // queue against a quota that is already spent.
  const prepared: Array<{
    id: string;
    company: string;
    angle?: string;
    subject?: string;
    text?: string;
    founders?: string[];
    emails?: string[];
    contactNote?: string | null;
    error: string | null;
  }> = [];
  let rateLimited = false;
  let timedOut = false;

  for (const item of batch) {
    // A row costs an article fetch, up to 4 site pages and 2 Gemini calls. On the cron this
    // runs before the sends, so it yields the remaining time to them rather than drafting
    // one more row and leaving nothing to send it with.
    if (expired(deadline)) {
      timedOut = true;
      break;
    }

    try {
      // Contact first: a named founder makes the draft open "Hi <first> —".
      const contact = await findContact(item);
      await saveFundingContact(item.id, contact);
      const outreach = await draftOutreach(item, contact);
      await saveFundingOutreach(item.id, outreach);
      prepared.push({
        id: item.id,
        company: item.company,
        angle: outreach.angle,
        subject: outreach.subject,
        text: outreach.text,
        founders: contact.founders.map((f) => f.name),
        emails: contact.emails.map((e) => e.address),
        contactNote: contact.note ?? null,
        error: null,
      });
    } catch (e) {
      const message = (e as Error).message;
      prepared.push({ id: item.id, company: item.company, error: message });
      if (/RESOURCE_EXHAUSTED|\b429\b/.test(message)) {
        rateLimited = true;
        break;
      }
    }
  }

  const ok = prepared.filter((p) => !p.error);
  return {
    prepared: ok.length,
    withEmail: ok.filter((p) => (p.emails?.length ?? 0) > 0).length,
    failed: prepared
      .filter((p) => p.error)
      .map((p) => ({ id: p.id, company: p.company, error: p.error as string })),
    rateLimited,
    remaining: Math.max(0, queue.length - prepared.length),
    skippedStale: { count: stale.length, maxAgeDays: MAX_AGE_DAYS, items: stale },
    results: ok,
    timedOut,
  };
}

// ---------------------------------------------------------------------------
// The combined pass the cron runs
// ---------------------------------------------------------------------------

/**
 * Hunter search credits one cron run may spend. Cap AND kill switch: **0 = off**.
 *
 * Unset defaults to 2. The pool is ~50 searches per Hunter account per month across the key
 * pool (measured 2026-08-13: 85 left of 100), so 2/day is ~60/month — inside the pool with
 * room for a manual `?action=enrich&spend=N` on top. Raise this and the month runs dry
 * mid-way, which fails silently as "no eligible rows" rather than as an error.
 */
export function enrichSpendPerRun(): number {
  const raw = process.env.ENRICH_CREDITS_PER_RUN;
  if (raw === undefined || raw.trim() === '') return 2;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Rows one cron run may draft. Cap AND kill switch: **0 = off**.
 *
 * Unset defaults to 3, matching the default `AUTO_SEND_MAX_PER_DAY` — drafting far ahead of
 * what can be sent just spends Gemini quota to grow a backlog. Each row is 2 sequential
 * Gemini calls plus an article fetch, so this is also the slowest thing in the invocation.
 */
export function draftLimitPerRun(): number {
  const raw = process.env.PREPARE_MAX_PER_RUN;
  if (raw === undefined || raw.trim() === '') return 3;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/**
 * Time this whole pass may occupy inside the funding invocation.
 *
 * The route is capped at 300s and must still fit `runAutoSend` (70s of pacing) and
 * `runFollowUps` (70s of pacing plus an IMAP session) AFTER this. Being late here costs a
 * day of sending, so the budget is deliberately smaller than the room available.
 */
const PREPARE_BUDGET_MS = 100_000;

export type PrepareResult = {
  enrich: EnrichPassResult | null;
  drafts: DraftPassResult | null;
  dryRun: boolean;
  /** What a dry run would have done, since it runs neither pass. */
  wouldSpend?: { credits: number; drafts: number };
};

/**
 * Enrich, then draft — in that order, because a draft opens by greeting a founder that
 * enrichment is what finds. Runs immediately before `runAutoSend` so a row discovered this
 * morning can be contacted this morning.
 */
export async function runPrepare(opts: { dryRun?: boolean } = {}): Promise<PrepareResult> {
  const credits = enrichSpendPerRun();
  const drafts = draftLimitPerRun();

  if (opts.dryRun) {
    return { enrich: null, drafts: null, dryRun: true, wouldSpend: { credits, drafts } };
  }

  const deadline = Date.now() + PREPARE_BUDGET_MS;

  // Enrichment is skipped entirely at 0 rather than run with a 0 budget: the free domain
  // phase still costs an HTTP call per row, and 0 is meant to be off, not cheap.
  const enrichResult =
    credits > 0
      ? await runEnrichPass({ spendBudget: credits, deadline, skipUnverifiedDomains: true })
      : null;
  const draftResult = drafts > 0 ? await runDraftPass({ limit: drafts, deadline }) : null;

  return { enrich: enrichResult, drafts: draftResult, dryRun: false };
}
