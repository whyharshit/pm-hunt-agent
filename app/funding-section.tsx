import { addFundingContactEmail, draftFundingOutreach, findFundingContact, sendFundingEmail, setFundingStatus } from '@/lib/actions';
import { addressLooksLikePerson, isGenericEmail } from '@/lib/contact';
import { fmtDate, hostOf } from '@/lib/format';
import { CopyButton } from './copy-button';
import type { FundingContact, FundingItem, FundingOutreach } from '@/lib/types';

const STATUSES: FundingItem['status'][] = ['new', 'contacted', 'skipped'];

const STATUS_CLASS: Record<FundingItem['status'], string> = {
  new: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  contacted: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  skipped: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500',
};

function ContactLine({ contact }: { contact: FundingContact }) {
  const hasAnything = contact.founders.length > 0 || contact.emails.length > 0 || contact.website;
  return (
    <div className="rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs dark:border-zinc-800 dark:bg-zinc-900">
      {contact.founders.length > 0 && (
        <div className="text-zinc-700 dark:text-zinc-300">
          {contact.founders.map((f) => `${f.name}${f.title ? ` · ${f.title}` : ''}`).join('  |  ')}
        </div>
      )}
      {contact.emails.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          {contact.emails.map((e) => (
            <a
              key={e.address}
              href={`mailto:${e.address}`}
              title={`found on ${e.foundOn}`}
              className="rounded bg-emerald-100 px-1.5 py-0.5 font-mono text-[11px] text-emerald-800 hover:underline dark:bg-emerald-900/40 dark:text-emerald-200"
            >
              {e.address}
            </a>
          ))}
        </div>
      )}
      {(contact.website || contact.socials.length > 0) && (
        <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-zinc-400 dark:text-zinc-500">
          {contact.website && (
            <a href={contact.website} target="_blank" rel="noreferrer noopener" className="hover:underline">
              {hostOf(contact.website)}
            </a>
          )}
          {contact.socials.map((s) => (
            <a key={s} href={s} target="_blank" rel="noreferrer noopener" className="hover:underline">
              {hostOf(s)}
            </a>
          ))}
        </div>
      )}
      {contact.note && (
        <div className={`${hasAnything ? 'mt-1 ' : ''}text-[11px] text-amber-700 dark:text-amber-400`}>
          {contact.note}
        </div>
      )}
    </div>
  );
}

/**
 * Paste a contact the agent couldn't find (ContactOut, LinkedIn, a company About page).
 * Always available, not just on failed rows — the harvester's founder hit rate is low
 * enough that the manual path is a normal route, not an error path. Adding a name here
 * re-renders the draft so the greeting follows the address.
 */
function AddContactRow({ item }: { item: FundingItem }) {
  return (
    <form action={addFundingContactEmail} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={item.id} />
      <input
        type="email"
        name="email"
        required
        placeholder="founder@company.com"
        className="h-7 w-52 rounded border border-zinc-300 bg-white px-2 font-mono text-xs text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      />
      <input
        type="text"
        name="name"
        placeholder="Their name (sets the greeting)"
        className="h-7 w-52 rounded border border-zinc-300 bg-white px-2 text-xs text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      />
      <button
        type="submit"
        className="h-7 rounded border border-zinc-300 bg-white px-2 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
      >
        Add contact
      </button>
    </form>
  );
}

function SendRow({
  item,
  draft,
  contact,
  mailerReady,
}: {
  item: FundingItem;
  draft: FundingOutreach;
  contact: FundingContact;
  mailerReady: boolean;
}) {
  if (draft.sentAt) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-green-700 dark:text-green-400">
        ✓ Sent to <span className="font-mono">{draft.sentTo}</span> · {fmtDate(draft.sentAt)}
        <form action={sendFundingEmail}>
          <input type="hidden" name="id" value={item.id} />
          <input type="hidden" name="to" value={draft.sentTo ?? ''} />
          <button
            type="submit"
            className="h-6 rounded border border-zinc-300 bg-white px-2 text-[11px] font-medium text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Send again
          </button>
        </form>
      </div>
    );
  }

  if (!mailerReady) {
    return (
      <p className="text-[11px] text-amber-700 dark:text-amber-400">
        Sending is off — set <code>GMAIL_USER</code> and <code>GMAIL_APP_PASSWORD</code> on Vercel to
        send via Gmail, or <code>RESEND_API_KEY</code> and <code>MAIL_FROM</code> to send via Resend.
      </p>
    );
  }

  // The email opens "Hi <first name>", so the default recipient must be a person — and
  // ideally THAT person. Preferring a matching address over the harvester's ranking is what
  // stops "Hi Paolo," defaulting to booking@weroad.com.
  const greeted = contact.founders[0]?.name;
  const byName = greeted
    ? contact.emails.find((e) => addressLooksLikePerson(e.address, greeted))
    : undefined;
  const best = byName ?? contact.emails.find((e) => !isGenericEmail(e.address)) ?? contact.emails[0];
  const mismatch = greeted ? !addressLooksLikePerson(best.address, greeted) : false;

  return (
    <form action={sendFundingEmail} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="id" value={item.id} />
      <select
        name="to"
        defaultValue={best.address}
        className="h-7 rounded border border-zinc-300 bg-white px-2 font-mono text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
      >
        {contact.emails.map((e) => (
          <option key={e.address} value={e.address}>
            {e.address}
            {isGenericEmail(e.address) ? ' (shared inbox)' : ''}
          </option>
        ))}
      </select>
      {mismatch && (
        <span className="text-[11px] font-medium text-red-700 dark:text-red-400">
          ⚠ opens “Hi {greeted!.replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, '').split(' ')[0]},” but
          this address isn’t theirs — add the right one below
        </span>
      )}
      <button
        type="submit"
        className="h-7 rounded border border-amber-400 bg-amber-50 px-2 text-xs font-semibold text-amber-800 hover:bg-amber-100 dark:border-amber-700 dark:bg-amber-950 dark:text-amber-200 dark:hover:bg-amber-900"
      >
        Send email
      </button>
      <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
        subject: “{draft.subject || `${item.company} — quick note`}”
      </span>
    </form>
  );
}

export function FundingSection({
  items,
  outreach,
  contacts,
  mailerReady,
}: {
  items: FundingItem[];
  outreach: Map<string, FundingOutreach>;
  contacts: Map<string, FundingContact>;
  mailerReady: boolean;
}) {
  return (
    <section className="mb-12">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
        Funding · cold-outreach targets · {items.length}
      </h2>
      {items.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          No funding items yet. Run the Funding Tracker (Run now on its agent card) to pull recent raises.
        </p>
      ) : (
        <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
          {items.map((it) => {
            const draft = outreach.get(it.id);
            const contact = contacts.get(it.id);
            return (
              <li key={it.id} className="flex flex-col gap-2 px-4 py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{it.company}</span>
                      {(it.amount || it.round) && (
                        <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200">
                          {[it.amount, it.round].filter(Boolean).join(' · ')}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">{it.summary}</p>
                    <div className="mt-0.5 text-xs text-zinc-400 dark:text-zinc-500">
                      <a href={it.url} target="_blank" rel="noreferrer noopener" className="hover:underline">
                        {hostOf(it.url)}
                      </a>{' '}
                      · {fmtDate(it.postedAt)}
                    </div>
                  </div>
                  <span className={`inline-flex h-6 items-center rounded-full px-2 text-xs font-medium ${STATUS_CLASS[it.status]}`}>
                    {it.status}
                  </span>
                  <form action={setFundingStatus} className="flex items-center gap-2">
                    <input type="hidden" name="id" value={it.id} />
                    <select
                      name="status"
                      defaultValue={it.status}
                      className="h-7 rounded border border-zinc-300 bg-white px-2 text-xs text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                    <button
                      type="submit"
                      className="h-7 rounded border border-zinc-300 bg-zinc-100 px-2 text-xs font-medium text-zinc-700 hover:bg-zinc-200 dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-200 dark:hover:bg-zinc-700"
                    >
                      Save
                    </button>
                  </form>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <form action={findFundingContact}>
                    <input type="hidden" name="id" value={it.id} />
                    <button
                      type="submit"
                      className="h-7 rounded border border-sky-300 bg-sky-50 px-2 text-xs font-medium text-sky-700 hover:bg-sky-100 dark:border-sky-800 dark:bg-sky-950 dark:text-sky-200 dark:hover:bg-sky-900"
                    >
                      {contact ? 'Re-find contact' : 'Find contact'}
                    </button>
                  </form>
                  <form action={draftFundingOutreach}>
                    <input type="hidden" name="id" value={it.id} />
                    <button
                      type="submit"
                      className="h-7 rounded border border-indigo-300 bg-indigo-50 px-2 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-200 dark:hover:bg-indigo-900"
                    >
                      {draft ? 'Re-draft outreach' : 'Draft outreach'}
                    </button>
                  </form>
                  {draft && <CopyButton text={draft.text} label="Copy outreach" />}
                  {draft && (
                    <span className="text-[11px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500">
                      angle: {draft.angle}
                    </span>
                  )}
                </div>

                {contact && <ContactLine contact={contact} />}

                {draft && (
                  // whitespace-pre-line: the template email is multi-line plain text with a
                  // bulleted list, and a bare <p> collapses it into one paragraph — so the
                  // preview would not match what actually gets sent.
                  <p className="whitespace-pre-line rounded border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300">
                    {draft.text}
                  </p>
                )}

                {draft && contact && contact.emails.length > 0 && (
                  <SendRow item={it} draft={draft} contact={contact} mailerReady={mailerReady} />
                )}

                <AddContactRow item={it} />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
