import { findContact, isGenericEmail } from '@/lib/contact';
import { enrichmentConfigured, findPeopleEmails, resolveDomain } from '@/lib/enrich';
import { draftOutreach } from '@/lib/funding';
import { MAX_AGE_DAYS } from '@/lib/sources/techcrunch';
import {
  deleteJob,
  deleteTracked,
  deleteWhatsappLead,
  getFundingContacts,
  getFundingOutreaches,
  getRecentFunding,
  getRecentJobs,
  getRecentTracked,
  getRecentWhatsappLeads,
  saveFundingContact,
  saveFundingOutreach,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';
// `prepare-outreach` fetches an article, crawls up to 4 pages of the company's site and
// makes 2 Gemini calls per row. The read-only actions return in well under a second.
export const maxDuration = 300;

/**
 * Guarded data-hygiene endpoint (Bearer CRON_SECRET, same contract as the other routes).
 * Exists because prod Redis is only reachable from inside Vercel — the CLI masks env
 * values on this team, so local tooling can never connect (see NEXT_SESSION.md).
 *
 *   ?action=inventory   — list every tracked row + WhatsApp lead, and flag rows that look
 *                         like test data. Read-only; run this FIRST and eyeball it.
 *   ?action=purge-test  — delete ONLY the flagged rows (tracker rows drop their scraped
 *                         JD / tailored resume / PDF / blurb / gform artifacts with them).
 *   ?action=funding     — read-only view of the founder-outreach queue: every funding row
 *                         with its status, whether a draft and a contact lookup exist, the
 *                         harvested addresses, and whether a real email has already gone
 *                         out (`sentAt`). Answers "what is there to send today" without
 *                         loading the dashboard. Sends NOTHING — sending stays a human
 *                         click on the dashboard.
 *   ?action=prepare-outreach&limit=N
 *                       — bulk "Find contact" + "Draft outreach" over fresh un-drafted
 *                         rows, so the human step is just review-and-send. Also sends
 *                         NOTHING. Idempotent: already-drafted rows are skipped.
 *
 * The markers are deliberately narrow: the smoke rows planted by the 2026-08-02 WhatsApp
 * ingest test ("SMOKE TEST — delete me", forms.gle/internAgentSmokeTest,
 * smoketest@example.com). Real rows never carry these; a row this can't classify is left
 * alone and surfaced for a human to judge.
 */
const TEST_MARKERS = [
  /smoke\s?test/i,
  /\bexample\.(com|org|net)\b/i,
  /internAgentSmokeTest/i,
  /delete\s?me/i,
  // A planted fake Google Form found by the first prod inventory (2026-08-08): real form
  // ids are ~56-char tokens, this one is literally "test".
  /docs\.google\.com\/forms\/d\/e\/test\b/i,
];

const isTest = (...fields: Array<string | undefined>) =>
  fields.some((f) => !!f && TEST_MARKERS.some((re) => re.test(f)));

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = request.headers.get('authorization');
    if (auth !== `Bearer ${secret}`) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  const params = new URL(request.url).searchParams;
  const action = params.get('action');

  // Answered before the tracker/jobs reads below, which this action has no use for.
  if (action === 'funding') {
    const items = await getRecentFunding(200);
    const ids = items.map((i) => i.id);
    const [outreaches, contacts] = await Promise.all([
      getFundingOutreaches(ids),
      getFundingContacts(ids),
    ]);

    const rows = items.map((i) => {
      const draft = outreaches.get(i.id);
      const contact = contacts.get(i.id);
      return {
        id: i.id,
        company: i.company,
        amount: i.amount ?? null,
        round: i.round ?? null,
        status: i.status,
        postedAt: i.postedAt,
        url: i.url,
        draft: draft
          ? { angle: draft.angle, subject: draft.subject ?? null, text: draft.text, sentAt: draft.sentAt ?? null, sentTo: draft.sentTo ?? null }
          : null,
        contact: contact
          ? {
              founders: contact.founders,
              website: contact.website ?? null,
              emails: contact.emails.map((e) => e.address),
              note: contact.note ?? null,
            }
          : null,
      };
    });

    // "Ready to send" is the number that decides whether an outreach session is worth
    // running: a draft exists, an address was harvested, and nothing has gone out yet.
    const readyToSend = rows.filter(
      (r) => r.status === 'new' && r.draft && !r.draft.sentAt && (r.contact?.emails.length ?? 0) > 0
    );

    // Split by whether a HUMAN can actually be reached. The drafts open "Hi <founder> —"
    // and ask for an internship; delivered to support@ that is a support ticket, so
    // counting those as ready would be the same lying green light the mailer avoided by
    // leaving MAIL_FROM unset. Measured 2026-08-08: personal was 0 of 11.
    const toAPerson = readyToSend.filter((r) => r.contact!.emails.some((e) => !isGenericEmail(e)));
    const genericOnly = readyToSend.filter((r) => r.contact!.emails.every((e) => isGenericEmail(e)));

    return Response.json({
      rows,
      counts: {
        total: rows.length,
        new: rows.filter((r) => r.status === 'new').length,
        contacted: rows.filter((r) => r.status === 'contacted').length,
        skipped: rows.filter((r) => r.status === 'skipped').length,
        drafted: rows.filter((r) => r.draft).length,
        withEmail: rows.filter((r) => (r.contact?.emails.length ?? 0) > 0).length,
        sent: rows.filter((r) => r.draft?.sentAt).length,
        readyToSend: readyToSend.length,
        readyToAPerson: toAPerson.length,
        readyGenericInboxOnly: genericOnly.length,
      },
      readyToSend: readyToSend.map((r) => ({
        id: r.id,
        company: r.company,
        emails: r.contact!.emails,
        reachesAPerson: r.contact!.emails.some((e) => !isGenericEmail(e)),
      })),
    });
  }

  // Prepare the outreach queue: look up the contact, then draft against it. Both are the
  // same server actions the dashboard buttons call — this just does them in bulk so the
  // human step is reduced to reviewing and clicking send.
  //
  // It NEVER sends. Sending stays `sendFundingEmail`, which needs a human click and only
  // accepts an address that was harvested from the company's own site.
  //
  // Skips anything already drafted (re-runnable/idempotent), anything not `new`, and
  // anything older than the recency gate — a draft congratulating a founder on a raise
  // from last year is worse than no draft. `?limit=` bounds one invocation so a slow
  // article fetch can't run past the function timeout; run it again for the next batch.
  if (action === 'prepare-outreach') {
    // Default 2 because of the 5-req/min Gemini free-tier ceiling described below.
    const limit = Math.min(Number(params.get('limit') ?? 2) || 2, 12);
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

    const batch = queue.slice(0, limit);

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

    for (const item of batch) {
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
    const attempted = prepared.length;
    return Response.json({
      ok: true,
      sent: 0,
      note: 'drafts + contacts only — nothing was emailed',
      prepared: ok.length,
      failed: prepared.filter((p) => p.error),
      withEmail: ok.filter((p) => (p.emails?.length ?? 0) > 0).length,
      rateLimited,
      remaining: Math.max(0, queue.length - attempted),
      skippedStale: { count: stale.length, maxAgeDays: MAX_AGE_DAYS, items: stale },
      results: ok,
    });
  }

  /**
   * Fill in the contact details the article scrape could not get — the 60-odd Google News
   * rows have no founder and no website, because their links are JS interstitials.
   *
   *   ?action=enrich            free phase only: company name → domain, over every row
   *                             that lacks one. Hunter's domain-finder consumes no credits.
   *   ?action=enrich&spend=N    then ALSO spend N credits on domain-search, newest rows
   *                             first, to get named people + personal addresses.
   *
   * `spend` defaults to 0 on purpose. Hunter's free plan is ~25 searches/month against 60+
   * rows, so burning them automatically would empty the quota on whatever happened to be
   * at the top of the queue. Sends nothing, ever.
   */
  if (action === 'enrich') {
    if (!enrichmentConfigured()) {
      return Response.json(
        { error: 'HUNTER_API_KEY not set — enrichment is off', spent: 0 },
        { status: 400 }
      );
    }

    const spendBudget = Math.min(Math.max(Number(params.get('spend') ?? 0) || 0, 0), 25);
    const items = await getRecentFunding(200);
    const contacts = await getFundingContacts(items.map((i) => i.id));

    // Newest first: a fresher raise is a better cold-outreach target, so if the credit
    // budget runs out it should run out on the oldest rows.
    const ordered = [...items].sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));

    let domainsFound = 0;
    let credited = 0;
    let peopleFound = 0;
    const results: Array<Record<string, unknown>> = [];
    const errors: string[] = [];

    for (const item of ordered) {
      if (item.status !== 'new') continue;
      const existing = contacts.get(item.id);
      const alreadyHasPerson = (existing?.emails.length ?? 0) > 0 && (existing?.founders.length ?? 0) > 0;
      if (alreadyHasPerson) continue;

      try {
        // --- free phase: resolve the company's own domain ---
        let domain = existing?.website?.replace(/^https?:\/\//, '') ?? '';
        let matchedName: string | undefined;
        if (!domain) {
          const found = await resolveDomain(item.company);
          if (!found) continue;
          domain = found.domain;
          matchedName = found.matchedName;
          domainsFound++;
        }

        let people = existing?.founders ?? [];
        let emails = existing?.emails ?? [];

        // --- paid phase: only while the caller's credit budget lasts ---
        if (credited < spendBudget) {
          credited++;
          const enriched = await findPeopleEmails(domain);
          if (enriched) {
            people = enriched.people.length ? enriched.people : people;
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
          note: matchedName && matchedName.toLowerCase() !== item.company.toLowerCase()
            ? `domain resolved from company name — Hunter matched "${matchedName}"; check it is the right company`
            : existing?.note,
        });

        results.push({
          id: item.id,
          company: item.company,
          domain,
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

    return Response.json({
      ok: true,
      sent: 0,
      note: 'contact enrichment only — nothing was emailed',
      domainsFound,
      creditsSpent: credited,
      peopleFound,
      errors,
      results,
    });
  }

  const [tracked, leads, jobs] = await Promise.all([
    getRecentTracked(500),
    getRecentWhatsappLeads(500),
    getRecentJobs(500),
  ]);

  const trackedRows = tracked.map((t) => ({
    id: t.id,
    url: t.url,
    company: t.company,
    role: t.role,
    status: t.status,
    source: t.source,
    addedAt: t.addedAt,
    tailorError: t.tailorError ?? null,
    flagged: isTest(t.url, t.note, t.company, t.role),
  }));
  const leadRows = leads.map((l) => ({
    id: l.id,
    group: l.group,
    sender: l.sender,
    roleLine: l.roleLine,
    emails: l.emails,
    status: l.status,
    postedAt: l.postedAt,
    flagged: isTest(l.group, l.text, l.roleLine, ...l.emails),
  }));
  // Jobs come from real sources only, so just the flagged ones are worth listing.
  const flaggedJobs = jobs
    .filter((j) => isTest(j.title, j.company, j.url))
    .map((j) => ({ id: j.id, title: j.title, company: j.company, url: j.url }));

  if (action === 'inventory') {
    return Response.json({
      tracked: trackedRows,
      whatsappLeads: leadRows,
      flaggedJobs,
      counts: {
        tracked: trackedRows.length,
        trackedFlagged: trackedRows.filter((r) => r.flagged).length,
        whatsappLeads: leadRows.length,
        leadsFlagged: leadRows.filter((r) => r.flagged).length,
        jobs: jobs.length,
        jobsFlagged: flaggedJobs.length,
      },
    });
  }

  if (action === 'purge-test') {
    const trackedToDelete = trackedRows.filter((r) => r.flagged);
    const leadsToDelete = leadRows.filter((r) => r.flagged);

    await Promise.all([
      ...trackedToDelete.map((r) => deleteTracked(r.id)),
      ...leadsToDelete.map((r) => deleteWhatsappLead(r.id)),
      ...flaggedJobs.map((r) => deleteJob(r.id)),
    ]);

    return Response.json({
      ok: true,
      deleted: {
        tracked: trackedToDelete,
        whatsappLeads: leadsToDelete,
        jobs: flaggedJobs,
      },
    });
  }

  return Response.json({ error: 'unknown action — use ?action=inventory or ?action=purge-test' }, { status: 400 });
}
