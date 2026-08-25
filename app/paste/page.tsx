import { addJobContactEmail, deleteJobRow, writeJobDraft } from '@/lib/actions';
import { addressLooksLikePerson, isGenericEmail } from '@/lib/contact';
import { isHiringInbox } from '@/lib/job-contact';
import { isTeamDraft } from '@/lib/job-outreach-template';
import { fmtDate } from '@/lib/format';
import { companyLabel } from '@/lib/postjob';
import { greetedIn } from '@/lib/sequence';
import { getJobContacts, getJobOutreaches, getRecentJobs } from '@/lib/storage';
import { DeleteButton } from '../delete-button';
import { JobDraftBlock } from '../job-draft-block';
import { Nav } from '../nav';
import { PasteForm } from '../paste-form';
import { SendJobButton } from '../send-job-button';
import type { Job, JobContact, JobOutreach } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Paste a hiring post you found yourself, get an application ready to send.
 *
 * This is the manual counterpart to the Discover cron: the user reads LinkedIn, sees a good
 * post the scrapers missed, and pastes it. Everything after that is the same machinery the
 * cron uses — same contact lookup, same template, same sender, same follow-up sequence — so
 * a pasted row and a discovered one behave identically from here on.
 *
 * ⚠️ A pasted row IS a job row, which means the unattended sender can pick it up on the next
 * cron if it qualifies and nobody sent it by hand. That is deliberate (it is the same queue),
 * but it means "I'll get to it later" is not the same as "it won't go out".
 */
export default async function PastePage() {
  let jobs: Job[] = [];
  let contacts = new Map<string, JobContact>();
  let drafts = new Map<string, JobOutreach>();
  let error: string | null = null;

  try {
    const all = await getRecentJobs(300);
    jobs = all.filter((j) => j.source === 'paste');
    const ids = jobs.map((j) => j.id);
    [contacts, drafts] = await Promise.all([getJobContacts(ids), getJobOutreaches(ids)]);
  } catch (e) {
    error = (e as Error).message;
  }

  return (
    <div className="min-h-screen bg-zinc-50 px-4 py-8 dark:bg-zinc-950 sm:px-8">
      <main className="mx-auto max-w-4xl">
        <Nav current="paste" />

        <h1 className="mb-1 text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Paste a hiring post
        </h1>
        <p className="mb-4 text-xs text-zinc-500 dark:text-zinc-400">
          For the posts you find yourself. The address in the post is used if there is one;
          otherwise Hunter is asked. Nothing sends until you press Send.
        </p>

        {error && (
          <p className="mb-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        <PasteForm />

        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Pasted posts · {jobs.length}
          </h2>
          {/* The contact database as a spreadsheet. Generated from the live rows on each click,
              so it can never be stale the way a synced Google Sheet would be. Opens in Sheets
              via File > Import, or in Excel directly. */}
          <a
            href="/api/contacts"
            className="h-7 rounded border border-zinc-300 bg-white px-2 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
          >
            Export contacts CSV
          </a>
        </div>

        {jobs.length === 0 ? (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            Nothing pasted yet. Drop a post in the box above.
          </p>
        ) : (
          <ul className="space-y-3">
            {jobs.map((j) => (
              <PastedRow key={j.id} job={j} contact={contacts.get(j.id)} draft={drafts.get(j.id)} />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

function PastedRow({
  job,
  contact,
  draft,
}: {
  job: Job;
  contact?: JobContact;
  draft?: JobOutreach;
}) {
  const teamDraft = draft ? isTeamDraft(draft.model) : false;
  // A team draft greets "team", which is not a person — reporting it as the greeted name
  // would put "Send to X? It opens Hi team," in the confirm dialog, which reads as a bug.
  const greeted = draft && !teamDraft ? greetedIn(draft.text) : null;
  const sent = draft?.sentAt;

  return (
    <li className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          {job.url ? (
            <a
              href={job.url}
              target="_blank"
              rel="noreferrer noopener"
              className="text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100"
            >
              {job.title}
            </a>
          ) : (
            <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{job.title}</span>
          )}
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {job.company}
            {job.location ? ` · ${job.location}` : ''} · pasted {fmtDate(job.postedAt)}
          </p>
        </div>
        <DeleteButton id={job.id} action={deleteJobRow} what={`“${job.title}”`} />
      </div>

      {sent ? (
        <p className="mt-2 text-xs text-emerald-700 dark:text-emerald-400">
          ✓ sent {fmtDate(sent)} to {draft?.sentTo}
        </p>
      ) : (
        <>
          {contact && contact.emails.length > 0 ? (
            <div className="mt-3 space-y-1.5">
              {contact.emails.map((e) => {
                // Two different problems, and the row says which. A shared inbox cannot take a
                // named greeting; a personal address that is not THIS person's is the
                // "Hi Paolo → booking@weroad.com" failure. Both are warnings, not blocks: a
                // human reading the greeting and the address together is the better check.
                // A "Hi team," draft going to careers@ is not a mismatch, it is the point.
                // Only a NAMED draft landing on a shared inbox is the mail-merge failure.
                const hiringInbox = isHiringInbox(e.address);
                const shared = isGenericEmail(e.address) && !(teamDraft && hiringInbox);
                const mismatch =
                  !teamDraft &&
                  !isGenericEmail(e.address) &&
                  Boolean(greeted) &&
                  !addressLooksLikePerson(e.address, greeted!);
                return (
                  <div key={e.address} className="flex flex-wrap items-center gap-2 text-xs">
                    <span className="font-medium text-zinc-800 dark:text-zinc-200">{e.address}</span>
                    <span className="text-zinc-400 dark:text-zinc-500">
                      {e.person ? `${e.person} · ` : ''}
                      {e.foundOn}
                    </span>
                    {teamDraft && hiringInbox && (
                      <span className="text-zinc-500 dark:text-zinc-400">
                        hiring inbox · draft opens “Hi team,”
                      </span>
                    )}
                    {shared && (
                      <span className="text-amber-700 dark:text-amber-500">
                        shared inbox{greeted ? `, but the draft opens “Hi ${greeted},”` : ''}
                      </span>
                    )}
                    {mismatch && (
                      <span className="text-amber-700 dark:text-amber-500">
                        does not look like {greeted}
                      </span>
                    )}
                    {draft && (
                      <SendJobButton
                        id={job.id}
                        to={e.address}
                        // "team" reads correctly in the confirm's `Hi {greeted},`, which is
                        // literally what a team draft opens with.
                        greeted={teamDraft ? 'team' : (greeted ?? '')}
                        company={companyLabel(job)}
                        warn={shared || mismatch}
                      />
                    )}
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="mt-2 text-xs text-amber-700 dark:text-amber-500">
              {contact?.note ?? 'No address found in the post, and Hunter had none either.'}
            </p>
          )}

          {(contact?.linkedin || contact?.phone) && (
            <p className="mt-2 flex flex-wrap gap-3 text-xs text-zinc-500 dark:text-zinc-400">
              {contact.linkedin && (
                <a
                  href={contact.linkedin}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="hover:underline"
                >
                  LinkedIn profile
                </a>
              )}
              {contact.phone && <span>{contact.phone}</span>}
            </p>
          )}

          {/* The escape hatch, and it is used often: plenty of posts put the address in an
              image or behind a link, where nothing automated can read it. */}
          <form action={addJobContactEmail} className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="id" value={job.id} />
            <input
              name="email"
              type="email"
              required
              placeholder="add an address by hand"
              className="h-7 min-w-0 flex-1 rounded border border-zinc-300 bg-white px-2 text-xs text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
            <input
              name="name"
              placeholder="whose address (sets the greeting)"
              className="h-7 min-w-0 flex-1 rounded border border-zinc-300 bg-white px-2 text-xs text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
            <button
              type="submit"
              className="h-7 rounded border border-zinc-300 bg-white px-2 text-xs font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
            >
              Add
            </button>
          </form>

          {draft ? (
            <JobDraftBlock
              id={job.id}
              draft={draft}
              greeted={teamDraft ? 'team' : greeted}
              summary="Edit the email"
            />
          ) : (
            <HandDraftForm job={job} />
          )}
        </>
      )}
    </li>
  );
}

/**
 * Write the email yourself when the machine declined to.
 *
 * A draft is only auto-written when there is somebody to greet — a named person, or a
 * recognised hiring inbox. A row that has neither used to be a dead end: the address was
 * visible and the Send button was not, because Send and the editor both ride on a draft
 * existing. This form is the way out — one save and the row behaves like any other
 * (editable, sendable, and marked hand-edited so no re-render ever overwrites it).
 */
function HandDraftForm({ job }: { job: Job }) {
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs text-zinc-500 hover:text-zinc-700 dark:text-zinc-400 dark:hover:text-zinc-200">
        Write the email by hand
      </summary>
      <form action={writeJobDraft} className="mt-2 space-y-1">
        <input type="hidden" name="id" value={job.id} />
        <input
          type="text"
          name="subject"
          defaultValue={`Application: ${job.title}`}
          placeholder="Subject"
          className="w-full rounded border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-900 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100"
        />
        <textarea
          name="text"
          rows={12}
          placeholder={'Hi <their name>,\n\nI saw your post about …'}
          className="w-full resize-y rounded border border-zinc-200 bg-white px-3 py-2 font-mono text-xs leading-relaxed text-zinc-700 placeholder:text-zinc-400 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-300 dark:placeholder:text-zinc-600"
        />
        <p className="text-[11px] text-zinc-500 dark:text-zinc-400">
          Open with “Hi &lt;their name&gt;,” — or “Hi team,” for a shared inbox — the send paths
          check the greeting against the address.
        </p>
        <button
          type="submit"
          className="h-7 rounded border border-zinc-300 bg-white px-2 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          Save draft
        </button>
      </form>
    </details>
  );
}
