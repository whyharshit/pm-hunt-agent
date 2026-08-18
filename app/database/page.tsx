import { categoryLabel } from '@/lib/job-category';
import { fmtDate } from '@/lib/format';
import { getJobContacts, getJobOutreaches, getRecentJobs } from '@/lib/storage';
import { Nav } from '../nav';
import type { Job, JobContact, JobOutreach } from '@/lib/types';

export const dynamic = 'force-dynamic';
// Reads every recent row plus its contact and its draft: two pipelined fetches over 500 ids,
// which is longer than the default allows on a cold Redis connection. A dashboard pass that
// looks thin is usually this, not the data (see the "Find contacts & draft" episode).
export const maxDuration = 60;

/**
 * The contact database, kept on the agent itself.
 *
 * ⚠️ THIS EXISTS INSTEAD OF A GOOGLE SHEET, on the user's own suggestion ("you can maintain
 * the database on agent also by adding a new tab") after they said they did not want to keep
 * exporting a CSV. It is the better answer for the same reason the CSV was: these rows are
 * ALREADY a database in Redis, and a Sheet would be a second copy that drifts the moment a
 * send updates a row, bought at the price of a service account, an OAuth scope, and a new way
 * for every paste to fail. This page reads the live rows, so it cannot be stale by
 * construction. The CSV export stays for when the data needs to leave the building.
 *
 * Every contact the project holds is here, discovered and pasted alike, ONE LINE PER ADDRESS:
 * a row carrying two addresses is two contacts, and collapsing them would hide one.
 */
type Entry = {
  job: Job;
  contact?: JobContact;
  draft?: JobOutreach;
  email?: string;
  person?: string;
  foundOn?: string;
};

export default async function DatabasePage() {
  const entries: Entry[] = [];
  let error: string | null = null;

  try {
    const jobs = await getRecentJobs(500);
    const ids = jobs.map((j) => j.id);
    const [contacts, drafts] = await Promise.all([getJobContacts(ids), getJobOutreaches(ids)]);

    for (const job of jobs) {
      const contact = contacts.get(job.id);
      const draft = drafts.get(job.id);
      const emails = contact?.emails.length ? contact.emails : [undefined];
      for (const e of emails) {
        // A row with no address, no profile, no phone and no name is a listing, not a contact.
        // Those live on /jobs, and letting them in here would bury the rows that matter.
        if (!e && !contact?.linkedin && !contact?.phone && !contact?.people.length) continue;
        entries.push({
          job,
          contact,
          draft,
          email: e?.address,
          person: e?.person ?? contact?.people[0]?.name,
          foundOn: e?.foundOn,
        });
      }
    }
  } catch (e) {
    error = (e as Error).message;
  }

  const withEmail = entries.filter((e) => e.email).length;
  const sent = entries.filter((e) => e.draft?.sentAt).length;

  const columns = [
    'Company',
    'Role',
    'Category',
    'Person',
    'Email',
    'Source',
    'LinkedIn',
    'Phone',
    'Status',
  ];

  return (
    <div className="min-h-screen bg-zinc-50 px-4 py-8 dark:bg-zinc-950 sm:px-8">
      <main className="mx-auto max-w-7xl">
        <Nav current="database" />

        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Database</h1>
            <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
              {entries.length} contacts · {withEmail} with an address · {sent} written to. Read
              live from storage, so it is never out of date.
            </p>
          </div>
          <a
            href="/api/contacts"
            className="h-7 rounded border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            Export CSV
          </a>
        </div>

        {error && (
          <p className="mb-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        {entries.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No contacts yet. Paste a post, or press Find contacts &amp; draft on Discovered jobs.
          </p>
        ) : (
          // The WRAPPER scrolls, not the page: the nav and the header stay put while the
          // columns move, which is the difference between usable and not on a phone.
          <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
            <table className="w-full min-w-[64rem] border-collapse text-xs">
              <thead className="bg-zinc-50 text-left text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
                <tr>
                  {columns.map((h) => (
                    <th key={h} className="whitespace-nowrap px-3 py-2 font-medium">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {entries.map((e, i) => (
                  <tr
                    key={`${e.job.id}:${e.email ?? i}`}
                    className="border-t border-zinc-100 align-top dark:border-zinc-900"
                  >
                    <td className="px-3 py-2 font-medium text-zinc-900 dark:text-zinc-100">
                      {e.job.company}
                    </td>
                    <td className="max-w-[18rem] px-3 py-2 text-zinc-700 dark:text-zinc-300">
                      {e.job.url ? (
                        <a
                          href={e.job.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="hover:underline"
                        >
                          {e.job.title}
                        </a>
                      ) : (
                        e.job.title
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-zinc-500 dark:text-zinc-400">
                      {categoryLabel(e.job.title)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-zinc-700 dark:text-zinc-300">
                      {e.person ?? ''}
                    </td>
                    <td className="px-3 py-2 text-zinc-700 dark:text-zinc-300">{e.email ?? ''}</td>
                    <td className="whitespace-nowrap px-3 py-2 text-zinc-400 dark:text-zinc-500">
                      {e.foundOn ?? e.job.source}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {e.contact?.linkedin ? (
                        <a
                          href={e.contact.linkedin}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="text-indigo-700 hover:underline dark:text-indigo-300"
                        >
                          profile
                        </a>
                      ) : (
                        ''
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2 text-zinc-700 dark:text-zinc-300">
                      {e.contact?.phone ?? ''}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">
                      {e.draft?.sentAt ? (
                        <span className="text-emerald-700 dark:text-emerald-400">
                          sent {fmtDate(e.draft.sentAt)}
                        </span>
                      ) : e.draft ? (
                        <span className="text-zinc-500 dark:text-zinc-400">drafted</span>
                      ) : (
                        <span className="text-zinc-400 dark:text-zinc-600">no draft</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
