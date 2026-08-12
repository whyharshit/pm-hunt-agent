import { addressLooksLikePerson, findContact, isGenericEmail } from '@/lib/contact';
import { enrichmentConfigured } from '@/lib/enrich';
import { backfillSequences, followUpCap } from '@/lib/followup';
import { imapConfigured } from '@/lib/imap';
import { firstName, isEditedDraft, renderOutreachTemplate } from '@/lib/outreach-template';
import { isUnresolvableNewsLink } from '@/lib/sources/fundingnews';
import { draftOutreach } from '@/lib/funding';
import { runDraftPass, runEnrichPass } from '@/lib/prepare';
import {
  deleteJob,
  deleteTracked,
  deleteWhatsappLead,
  getAllOutreachSequences,
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
 *   ?action=followups   — read-only view of every follow-up sequence: which founders are
 *                         still being chased, at which of the three steps, when the next
 *                         bump is due, and which sequences replies or bounces closed.
 *   ?action=followup-backfill
 *                       — start a sequence for every email that went out BEFORE sequences
 *                         existed, recovering each Message-ID from Gmail's Sent Mail so the
 *                         follow-ups land in the original thread. Sends NOTHING. Idempotent.
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

  // Read-only view of every follow-up sequence, live and closed. The authoritative answer to
  // "who is still being chased, at which step, and who stopped it".
  if (action === 'followups') {
    const sequences = await getAllOutreachSequences();
    sequences.sort((a, b) => (a.nextDueAt ?? '9999').localeCompare(b.nextDueAt ?? '9999'));
    const active = sequences.filter((s) => s.state === 'active');
    return Response.json({
      counts: {
        total: sequences.length,
        active: active.length,
        dueNow: active.filter((s) => s.nextDueAt && Date.parse(s.nextDueAt) <= Date.now()).length,
        replied: sequences.filter((s) => s.state === 'replied').length,
        bounced: sequences.filter((s) => s.state === 'bounced').length,
        stopped: sequences.filter((s) => s.state === 'stopped').length,
        done: sequences.filter((s) => s.state === 'done').length,
        // A sequence with no rootMessageId sends follow-ups outside the original thread.
        unthreaded: sequences.filter((s) => !s.rootMessageId).length,
        followUpsSent: sequences.reduce(
          (n, s) => n + s.sends.filter((x) => x.kind !== 'initial').length,
          0
        ),
      },
      cap: followUpCap(),
      imapConfigured: imapConfigured(),
      sequences,
    });
  }

  // Give the emails that went out before sequences existed a sequence to belong to, and
  // recover their Message-IDs from Gmail's Sent Mail so their follow-ups thread properly.
  // Idempotent: rows that already have a sequence are skipped.
  if (action === 'followup-backfill') {
    return Response.json(await backfillSequences());
  }

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

    // Split by whether the GREETED PERSON can actually be reached — not merely whether some
    // address isn't on the shared-inbox denylist. That weaker test counted
    // supplier@rideriver.com and coordinators@weroad.com as person-reachable on rows whose
    // email opens "Hi Aravind," and "Hi Paolo,". A denylist can never enumerate every
    // shared mailbox, so the number a human reads to decide what to send has to be built on
    // the positive check.
    const reaches = (r: (typeof rows)[number]) => {
      const greeted = r.contact?.founders[0]?.name;
      if (!greeted) return false;
      return r.contact!.emails.some(
        (e) => !isGenericEmail(e) && addressLooksLikePerson(e, greeted)
      );
    };
    const toAPerson = readyToSend.filter(reaches);
    const genericOnly = readyToSend.filter((r) => !reaches(r));

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
        reachesAPerson: reaches(r),
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
    // Default 2 because of the 5-req/min Gemini free-tier ceiling described in runDraftPass.
    const limit = Math.min(Number(params.get('limit') ?? 2) || 2, 12);
    // No deadline: a human waiting on a curl would rather it finish than yield time to a
    // sender that is not running here. The cron passes one.
    const pass = await runDraftPass({ limit });

    return Response.json({
      ok: true,
      sent: 0,
      note: 'drafts + contacts only — nothing was emailed',
      prepared: pass.prepared,
      failed: pass.failed,
      withEmail: pass.withEmail,
      rateLimited: pass.rateLimited,
      remaining: pass.remaining,
      skippedStale: pass.skippedStale,
      results: pass.results,
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
    // No deadline, same reason as prepare-outreach above.
    const pass = await runEnrichPass({ spendBudget });

    return Response.json({
      ok: true,
      sent: 0,
      note: 'contact enrichment only — nothing was emailed',
      domainsFound: pass.domainsFound,
      searchResolved: pass.searchResolved,
      ambiguousDomains: pass.ambiguousDomains,
      ambiguous: pass.ambiguous,
      creditsSpent: pass.creditsSpent,
      peopleFound: pass.peopleFound,
      errors: pass.errors,
      results: pass.results,
    });
  }

  /**
   * Re-run the contact lookup on rows whose LINK has since been upgraded.
   *
   * A row first seen through Google News was contacted against an interstitial, so it
   * stored "cannot follow this link" and no founder. Once Serper supplies a real publisher
   * URL for the same company, `runFundingScan` swaps the URL in — but the stored contact
   * is still the useless one, and `prepare-outreach` won't revisit it because a draft
   * already exists. This is the step that closes that gap.
   *
   * Only touches rows that are now scrapeable AND still have no founder, so it is safe to
   * re-run and never spends a call re-doing work that succeeded.
   */
  if (action === 'recontact') {
    const limit = Math.min(Number(params.get('limit') ?? 5) || 5, 15);
    const items = await getRecentFunding(200);
    const contacts = await getFundingContacts(items.map((i) => i.id));

    const queue = items
      .filter((i) => i.status === 'new')
      .filter((i) => !isUnresolvableNewsLink(i.url))
      .filter((i) => {
        const c = contacts.get(i.id);
        if ((c?.founders.length ?? 0) > 0) return false;
        // Already read this article and it named nobody at the company. Re-reading spends
        // a Gemini call to get the same answer, and without this the queue never drains —
        // `remaining` sat at 18 across four batches, re-processing the same rows.
        // `model: 'none'` means the row was short-circuited as an unfollowable link and
        // was never actually read, so those still qualify.
        if (c && c.model !== 'none' && /names nobody/i.test(c.note ?? '')) return false;
        return true;
      })
      .sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));

    const done: Array<Record<string, unknown>> = [];
    const failed: Array<Record<string, unknown>> = [];
    let rateLimited = false;

    for (const item of queue.slice(0, limit)) {
      try {
        const contact = await findContact(item);
        await saveFundingContact(item.id, contact);
        done.push({
          company: item.company,
          founders: contact.founders.map((f) => f.name),
          website: contact.website ?? null,
          emails: contact.emails.map((e) => e.address),
          note: contact.note ?? null,
        });
      } catch (e) {
        const message = (e as Error).message;
        failed.push({ company: item.company, error: message });
        if (/RESOURCE_EXHAUSTED|\b429\b/.test(message)) {
          rateLimited = true;
          break;
        }
      }
    }

    return Response.json({
      ok: true,
      sent: 0,
      recontacted: done.length,
      withFounder: done.filter((d) => (d.founders as string[]).length > 0).length,
      rateLimited,
      remaining: Math.max(0, queue.length - done.length - failed.length),
      failed,
      results: done,
    });
  }

  /**
   * Re-draft rows whose founder became known AFTER the draft was written.
   *
   * The drafts are generated once and never revisited, so a row that was drafted while its
   * contact lookup had failed opens with no greeting at all. Once `recontact` or `enrich`
   * supplies a name, the draft is stale in the one place the reader notices first — the
   * prompt's rule 8 opens "Hi <first> —" only when a recipient is passed in. These are the
   * rows about to be emailed to a real founder, so a generic opener is worth a re-draft.
   *
   * Only touches rows that HAVE a founder and whose stored draft does not already greet
   * them by first name, and never a row already sent.
   */
  if (action === 'redraft') {
    const limit = Math.min(Number(params.get('limit') ?? 5) || 5, 15);
    const items = await getRecentFunding(200);
    const ids = items.map((i) => i.id);
    const [contacts, drafts] = await Promise.all([getFundingContacts(ids), getFundingOutreaches(ids)]);

    const queue = items.filter((i) => {
      if (i.status !== 'new') return false;
      const draft = drafts.get(i.id);
      const contact = contacts.get(i.id);
      if (!draft || draft.sentAt) return false;
      const first = contact?.founders[0]?.name.split(' ')[0];
      if (!first) return false;
      return !new RegExp(`^\\s*(hi|hey|hello)\\s+${first}\\b`, 'i').test(draft.text);
    });

    const done: Array<Record<string, unknown>> = [];
    const failed: Array<Record<string, unknown>> = [];
    let rateLimited = false;

    for (const item of queue.slice(0, limit)) {
      try {
        const outreach = await draftOutreach(item, contacts.get(item.id) ?? null);
        await saveFundingOutreach(item.id, outreach);
        done.push({ company: item.company, subject: outreach.subject, text: outreach.text });
      } catch (e) {
        const message = (e as Error).message;
        failed.push({ company: item.company, error: message });
        if (/RESOURCE_EXHAUSTED|\b429\b/.test(message)) {
          rateLimited = true;
          break;
        }
      }
    }

    return Response.json({
      ok: true,
      sent: 0,
      redrafted: done.length,
      rateLimited,
      remaining: Math.max(0, queue.length - done.length - failed.length),
      failed,
      results: done,
    });
  }

  /**
   * Re-draft every row using the user's own template (lib/outreach-template.ts) instead of
   * the LLM. Free — no Gemini call, so it is not bounded by `limit` the way the generated
   * drafts were, and it can run over the whole queue in one pass even with the quota spent.
   *
   * Overwrites existing drafts on purpose: the user supplied this email to replace them.
   * Rows already sent are never touched, and a row with no founder name is skipped rather
   * than drafted with a "Hi there" opener.
   */
  if (action === 'template-drafts') {
    const items = await getRecentFunding(200);
    const ids = items.map((i) => i.id);
    const [contacts, drafts] = await Promise.all([getFundingContacts(ids), getFundingOutreaches(ids)]);

    const written: Array<{ company: string; greeting: string }> = [];
    let skippedNoFounder = 0;
    let skippedSent = 0;
    let skippedEdited = 0;

    for (const item of items) {
      if (item.status !== 'new') continue;
      const existingDraft = drafts.get(item.id);
      if (existingDraft?.sentAt) {
        skippedSent++;
        continue;
      }
      // Never clobber a hand-edit. This action overwrites drafts by design, which is right
      // for template changes and catastrophic for edits the user made on the dashboard.
      if (existingDraft && isEditedDraft(existingDraft.model)) {
        skippedEdited++;
        continue;
      }
      const outreach = renderOutreachTemplate(item, contacts.get(item.id) ?? null);
      if (!outreach) {
        skippedNoFounder++;
        continue;
      }
      await saveFundingOutreach(item.id, outreach);
      written.push({
        company: item.company,
        // The same helper the email uses, so the report can't disagree with what was sent.
        // Reporting the raw name here showed "Hi Dr." for a row whose email correctly
        // opened "Hi Chinmay,".
        greeting: `Hi ${firstName(contacts.get(item.id)!.founders[0].name)}`,
      });
    }

    return Response.json({
      ok: true,
      sent: 0,
      note: 'drafts rewritten from the user template — nothing was emailed',
      written: written.length,
      skippedNoFounder,
      skippedSent,
      skippedEdited,
      results: written,
    });
  }

  /**
   * Set a contact by hand: `?action=set-contact&company=Omilia&email=x@y.com&name=First Last`
   *
   * The same operation as the dashboard's "Add contact" form, reachable without a browser.
   * It matters most for rows the unattended sender is about to mail: the address goes to the
   * front, the supplied name becomes the greeted founder, and the draft is re-rendered so
   * the greeting can never disagree with the recipient.
   *
   * Matched on company name rather than row id because a human invoking this knows the
   * company, not a hash. Refuses when the name is ambiguous instead of guessing which row.
   */
  if (action === 'set-contact') {
    const company = (params.get('company') ?? '').trim();
    const email = (params.get('email') ?? '').trim().toLowerCase();
    const name = (params.get('name') ?? '').trim();
    if (!company || !/^[^\s@]+@[^\s@]+\.[a-z]{2,24}$/i.test(email)) {
      return Response.json({ error: 'need ?company= and a valid ?email=' }, { status: 400 });
    }

    const items = await getRecentFunding(200);
    const matches = items.filter((i) => i.company.toLowerCase() === company.toLowerCase());
    if (matches.length === 0) return Response.json({ error: `no funding row named "${company}"` }, { status: 404 });
    if (matches.length > 1) {
      return Response.json(
        { error: `"${company}" matches ${matches.length} rows — set it from the dashboard instead` },
        { status: 409 }
      );
    }

    const item = matches[0];
    const existing = (await getFundingContacts([item.id])).get(item.id);
    const founders = name
      ? [{ name }, ...(existing?.founders ?? []).filter((f) => f.name.toLowerCase() !== name.toLowerCase())]
      : (existing?.founders ?? []);

    const contact = {
      id: item.id,
      founders,
      website: existing?.website,
      emails: [
        { address: email, foundOn: 'added by hand' },
        ...(existing?.emails ?? []).filter((e) => e.address !== email),
      ],
      socials: existing?.socials ?? [],
      foundAt: new Date().toISOString(),
      model: existing?.model ?? 'manual',
      note: existing?.note,
    };
    await saveFundingContact(item.id, contact);

    const outreach = renderOutreachTemplate(item, contact);
    if (outreach) await saveFundingOutreach(item.id, outreach);

    return Response.json({
      ok: true,
      sent: 0,
      company: item.company,
      greets: founders[0]?.name ?? null,
      to: email,
      draftFirstLine: outreach?.text.split('\n')[0] ?? null,
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
