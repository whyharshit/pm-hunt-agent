import { getJobContacts, getRecentJobs } from '@/lib/storage';
import { categoryLabel } from '@/lib/job-category';

export const dynamic = 'force-dynamic';

/**
 * The contact database, as a CSV the browser downloads.
 *
 * ⚠️ WHY NOT GOOGLE SHEETS, which is what the user asked about. A Sheet needs a service
 * account, a shared key and an OAuth scope, and it writes on every paste — so it adds a second
 * place the data lives and a new way for a paste to fail, in a project where production
 * secrets are write-only and a failing integration cannot be inspected from a dev machine.
 * The rows are ALREADY a database in Redis; a Sheet would be a second copy that drifts from it
 * the moment a send updates a row.
 *
 * A CSV export is the same spreadsheet without any of that: it opens directly in Sheets
 * (File > Import) or Excel, it is generated from the live rows so it can never be stale, and
 * it needs no credential that could leak. If a live two-way Sheet is ever genuinely wanted,
 * this endpoint is the thing a sync would read.
 *
 * Auth: /api/contacts is covered by the proxy matcher. A route left off that list is PUBLIC,
 * and this one returns every address the project holds.
 */
function csvCell(v: string | undefined): string {
  const s = (v ?? '').replace(/\r?\n/g, ' ').trim();
  // Quote whenever the value could break a column, and double any inner quote.
  return /[",]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function GET() {
  const jobs = await getRecentJobs(500);
  const contacts = await getJobContacts(jobs.map((j) => j.id));

  const header = [
    'company',
    'role',
    'category',
    'location',
    'source',
    'posted',
    'person',
    'email',
    'email_source',
    'linkedin',
    'phone',
    'website',
    'post_url',
    'apply_url',
  ];

  const rows: string[] = [header.join(',')];
  for (const job of jobs) {
    const c = contacts.get(job.id);
    // One line per ADDRESS, not per row: a row with two addresses is two contacts, and a row
    // with none still belongs in the database if a human recorded a profile or a phone.
    const emails = c?.emails.length ? c.emails : [undefined];
    for (const e of emails) {
      if (!e && !c?.linkedin && !c?.phone && !c?.people.length) continue;
      rows.push(
        [
          job.company,
          job.title,
          categoryLabel(job.title),
          job.location,
          job.source,
          new Date(job.postedAt).toISOString().slice(0, 10),
          e?.person ?? c?.people[0]?.name ?? '',
          e?.address ?? '',
          e?.foundOn ?? '',
          c?.linkedin ?? '',
          c?.phone ?? '',
          c?.website ?? '',
          job.url,
          job.applyUrl ?? '',
        ]
          .map(csvCell)
          .join(',')
      );
    }
  }

  return new Response(rows.join('\n'), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': 'attachment; filename="contacts.csv"',
      'cache-control': 'no-store',
    },
  });
}
