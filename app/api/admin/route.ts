import {
  deleteJob,
  deleteTracked,
  deleteWhatsappLead,
  getRecentJobs,
  getRecentTracked,
  getRecentWhatsappLeads,
} from '@/lib/storage';

export const dynamic = 'force-dynamic';

/**
 * Guarded data-hygiene endpoint (Bearer CRON_SECRET, same contract as the other routes).
 * Exists because prod Redis is only reachable from inside Vercel — the CLI masks env
 * values on this team, so local tooling can never connect (see NEXT_SESSION.md).
 *
 *   ?action=inventory   — list every tracked row + WhatsApp lead, and flag rows that look
 *                         like test data. Read-only; run this FIRST and eyeball it.
 *   ?action=purge-test  — delete ONLY the flagged rows (tracker rows drop their scraped
 *                         JD / tailored resume / PDF / blurb / gform artifacts with them).
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
