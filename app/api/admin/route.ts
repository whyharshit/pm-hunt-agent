import { findContact } from '@/lib/contact';
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

  const action = new URL(request.url).searchParams.get('action');

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
      },
      readyToSend: readyToSend.map((r) => ({ id: r.id, company: r.company, emails: r.contact!.emails })),
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
    const limit = Math.min(Number(new URL(request.url).searchParams.get('limit') ?? 6) || 6, 12);
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
    const prepared = await Promise.all(
      batch.map(async (item) => {
        try {
          // Contact first: a named founder makes the draft open "Hi <first> —".
          const contact = await findContact(item);
          await saveFundingContact(item.id, contact);
          const outreach = await draftOutreach(item, contact);
          await saveFundingOutreach(item.id, outreach);
          return {
            id: item.id,
            company: item.company,
            angle: outreach.angle,
            subject: outreach.subject,
            text: outreach.text,
            founders: contact.founders.map((f) => f.name),
            emails: contact.emails.map((e) => e.address),
            contactNote: contact.note ?? null,
            error: null as string | null,
          };
        } catch (e) {
          return { id: item.id, company: item.company, error: (e as Error).message };
        }
      })
    );

    const ok = prepared.filter((p) => !p.error);
    return Response.json({
      ok: true,
      sent: 0,
      note: 'drafts + contacts only — nothing was emailed',
      prepared: ok.length,
      failed: prepared.filter((p) => p.error),
      withEmail: ok.filter((p) => (p.emails?.length ?? 0) > 0).length,
      remaining: Math.max(0, queue.length - batch.length),
      skippedStale: { count: stale.length, maxAgeDays: MAX_AGE_DAYS, items: stale },
      results: ok,
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
