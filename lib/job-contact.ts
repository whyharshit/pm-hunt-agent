import { isGenericEmail } from './contact';
import { findPeopleEmails, resolveDomain } from './enrich';
import { POSTER_TAG } from './postjob';
import { extractEmails } from './whatsapp/match';
import type { ContactEmail, ContactPerson, Job, JobContact } from './types';

/**
 * Who to write to about a discovered job.
 *
 * WHY THIS IS NOT lib/contact.ts
 * That module reads a funding ARTICLE with Gemini to work out who founded the company, then
 * crawls the company site for published addresses. A job row needs none of that. The poster
 * very often writes the address into the post itself ("send your CV to ananya@acme.com"), and
 * that address is better than anything a lookup could produce: it is the one the poster ASKED
 * to be written to. Reading it costs nothing, no model, no credit, no network call.
 *
 * So this file is ordered by what is cheap and certain first:
 *   1. the address in the post          free, and the best signal there is
 *   2. Hunter domain-finder             free, company name to domain
 *   3. Hunter domain-search             1 CREDIT, domain to named people
 *
 * The standing no-guessing rule holds throughout: nothing here ever constructs `first@domain`.
 * Every address returned was literally written somewhere by somebody.
 */

/**
 * Role inboxes that EXIST to receive applications. Distinct from `isGenericEmail`, which is
 * the funding pipeline's denylist of shared inboxes — and rightly so there, because greeting a
 * founder by name on an email to `support@` reads as a botched mail-merge.
 *
 * On a job row the judgement inverts: `careers@` is not a mistake, it is the address the
 * posting gave. It still cannot receive an email that opens "Hi Ananya," so the draft greets
 * nobody by name, and reaching one at all is gated (see lib/job-autosend.ts).
 */
const HIRING_INBOX = /^(careers?|jobs?|hiring|recruit(ing|ment)?|hr|talent|internships?|apply|applications?|resume|cv|joinus|work(with|for)us)@/i;

export function isHiringInbox(address: string): boolean {
  return HIRING_INBOX.test(address);
}

/**
 * Everything the row already knows, at zero cost.
 *
 * Sources whose items are free-text posts stash the addresses they found in `tags` and the
 * body in `description`; both are re-read here rather than trusted to have been parsed once,
 * because a row can also arrive from a board scrape that never ran the post matcher.
 */
export function contactFromJob(job: Job): JobContact | null {
  const emailTags = job.tags.filter((t) => t.includes('@') && !t.startsWith(POSTER_TAG));
  const found = [
    ...new Set([...emailTags.flatMap(extractEmails), ...extractEmails(job.description ?? '')]),
  ];

  const posterTag = job.tags.find((t) => t.startsWith(POSTER_TAG));
  const poster = posterTag?.slice(POSTER_TAG.length).trim();

  if (found.length === 0 && !poster) return null;

  // Person-addressed first: those are the ones that can carry a named greeting, and the
  // sender will only ever act on one of them unattended.
  const ranked = [...found].sort((a, b) => Number(isGenericEmail(a)) - Number(isGenericEmail(b)));

  const emails: ContactEmail[] = ranked.map((address) => ({
    address,
    // Provenance is recorded as prose, exactly like `hunter.io (92% confidence)`, because it
    // is read by a human on the dashboard before anything is sent to it.
    foundOn: 'the job post itself',
    // Only attach the poster to an address that plausibly belongs to them. Pairing a name
    // with `hr@` here would make the row LOOK person-reachable to every check downstream.
    ...(poster && !isGenericEmail(address) ? { person: poster } : {}),
  }));

  const people: ContactPerson[] = poster ? [{ name: poster }] : [];

  return {
    id: job.id,
    people,
    emails,
    foundAt: new Date().toISOString(),
    model: 'post',
    ...(emails.length === 0 ? { note: 'poster named, but the post gives no address' } : {}),
  };
}

export type JobEnrichOutcome = {
  contact: JobContact | null;
  /** Hunter search credits this call actually spent. 0 when it stopped in the free phase. */
  creditsSpent: number;
  note: string | null;
};

/**
 * Fill in what the post did not give: company name → domain (free) → named people (1 credit).
 *
 * ⚠️ THE SAME ~100-SEARCHES-A-MONTH POOL AS FOUNDER OUTREACH. `spend` is not advisory — every
 * credit burned here is one the funding pipeline cannot use, and that pipeline is the one
 * currently producing replies. The caller's budget is deliberately small; see
 * `jobEnrichSpendPerRun` in lib/job-prepare.ts.
 *
 * The no-guess rule from lib/enrich.ts carries over unchanged: an ambiguous company name is
 * recorded as ambiguous and abandoned, never resolved by picking the biggest candidate. On a
 * job row the name is often worse than a funding row's ("Unknown", or a person's name from a
 * LinkedIn post), which makes the discipline more necessary here, not less.
 */
export async function enrichJobContact(
  job: Job,
  existing: JobContact | null,
  opts: { spend: boolean }
): Promise<JobEnrichOutcome> {
  const base = existing ?? contactFromJob(job);

  // Already have somebody to write to by name. Spending a credit on top would buy nothing.
  const hasPerson = base?.emails.some((e) => e.person) ?? false;
  if (hasPerson) return { contact: base, creditsSpent: 0, note: null };

  // Already paid for this domain once. Hunter's answer does not change between two presses of
  // a button, and an empty answer is indistinguishable from "never tried" without this flag,
  // so without it every later pass buys the same nothing again.
  if (base?.hunterCheckedAt) {
    return { contact: base, creditsSpent: 0, note: 'Hunter already searched this domain' };
  }

  const company = job.company.trim();
  if (!company || company.toLowerCase() === 'unknown') {
    return {
      contact: base,
      creditsSpent: 0,
      // Not a failure worth an error: the serper source cannot always read a company out of a
      // Google result title, and a row with no company simply cannot be looked up.
      note: 'no company name on the row, so no lookup is possible',
    };
  }

  let domain = base?.website?.replace(/^https?:\/\//, '') ?? '';
  let note: string | null = null;
  let knownEmails = domain ? 1 : 0;

  if (!domain) {
    const found = await resolveDomain(company);
    if (found.kind === 'resolved') {
      domain = found.domain;
      knownEmails = found.emailCount;
      if (found.matchedName.toLowerCase() !== company.toLowerCase()) {
        note = `domain resolved from the company name; Hunter matched "${found.matchedName}", confirm it is the right company`;
      }
    } else if (found.kind === 'ambiguous') {
      return {
        contact: base
          ? { ...base, note: `domain ambiguous: ${found.candidates.join(', ')}; pick one by hand` }
          : {
              id: job.id,
              people: [],
              emails: [],
              foundAt: new Date().toISOString(),
              model: 'hunter.io',
              note: `domain ambiguous: ${found.candidates.join(', ')}; pick one by hand`,
            },
        creditsSpent: 0,
        note: 'domain ambiguous',
      };
    } else {
      return { contact: base, creditsSpent: 0, note: 'Hunter knows no domain for this company' };
    }
  }

  if (!opts.spend || knownEmails === 0) {
    return {
      contact: {
        id: job.id,
        people: base?.people ?? [],
        emails: base?.emails ?? [],
        website: `https://${domain}`,
        foundAt: new Date().toISOString(),
        model: base?.model ?? 'hunter.io',
        // A domain Hunter knows ZERO addresses for is settled: the paid search cannot return
        // anything. Stamping it here is what stops the next pass paying to find that out —
        // on the pass after this one `domain` comes back off `website`, and the "assume worth
        // a look" default would otherwise make it look like a fresh candidate forever.
        ...(knownEmails === 0 ? { hunterCheckedAt: new Date().toISOString() } : {}),
        ...(note ? { note } : base?.note ? { note: base.note } : {}),
      },
      creditsSpent: 0,
      note: knownEmails === 0 ? 'Hunter knows no addresses on that domain' : 'domain only, no credit spent',
    };
  }

  const enriched = await findPeopleEmails(domain);
  const people = [...(base?.people ?? [])];
  const known = new Set(people.map((p) => p.name.toLowerCase()));
  for (const p of enriched?.people ?? []) {
    if (!known.has(p.name.toLowerCase())) people.push(p);
  }

  // The post's own addresses lead. They came from the person hiring; Hunter's came from a
  // crawl, and on a job row that ordering is the opposite of the funding pipeline's.
  const emails = [...(base?.emails ?? []), ...(enriched?.emails ?? [])];

  return {
    contact: {
      id: job.id,
      people,
      emails,
      website: `https://${domain}`,
      foundAt: new Date().toISOString(),
      model: 'hunter.io',
      // Stamped whatever the result was. An empty answer is exactly the case that must not be
      // paid for twice, so this cannot be conditional on `enriched`.
      hunterCheckedAt: new Date().toISOString(),
      ...(note ? { note } : enriched ? {} : { note: 'Hunter knows nobody on that domain' }),
    },
    creditsSpent: 1,
    note: enriched ? null : 'Hunter returned nobody on that domain',
  };
}
