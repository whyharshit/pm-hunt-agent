import {
  getFundingContacts,
  getFundingOutreaches,
  getOutreachSequences,
  getRecentFunding,
} from '@/lib/storage';
import { mailerConfigured } from '@/lib/mailer';
import { FundingSection } from '../funding-section';
import { Nav } from '../nav';
import type {
  FundingContact,
  FundingItem,
  FundingOutreach,
  OutreachSequence,
} from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Funding outreach on its own route. `?status=` filters, because the queue is ~100 rows and
 * the only ones that matter on any given day are the handful that are actually sendable.
 */
export default async function FundingPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string }>;
}) {
  const { status } = await searchParams;

  let items: FundingItem[] = [];
  let outreach = new Map<string, FundingOutreach>();
  let contacts = new Map<string, FundingContact>();
  let sequences = new Map<string, OutreachSequence>();
  let error: string | null = null;

  try {
    items = await getRecentFunding(200);
    const ids = items.map((i) => i.id);
    [outreach, contacts, sequences] = await Promise.all([
      getFundingOutreaches(ids),
      getFundingContacts(ids),
      getOutreachSequences(ids),
    ]);
  } catch (e) {
    error = (e as Error).message;
  }

  const counts = {
    all: items.length,
    new: items.filter((i) => i.status === 'new').length,
    contacted: items.filter((i) => i.status === 'contacted').length,
    skipped: items.filter((i) => i.status === 'skipped').length,
    // The one number worth acting on: a draft exists and someone can be reached.
    ready: items.filter(
      (i) =>
        i.status === 'new' &&
        outreach.get(i.id) &&
        !outreach.get(i.id)!.sentAt &&
        (contacts.get(i.id)?.emails.length ?? 0) > 0
    ).length,
    // The point of the whole follow-up machine: who actually answered. It cannot live on
    // `FundingItem.status`, which says `contacted` for replies, bounces and silence alike.
    replied: items.filter((i) => sequences.get(i.id)?.state === 'replied').length,
  };

  const shown =
    status === 'ready'
      ? items.filter(
          (i) =>
            i.status === 'new' &&
            outreach.get(i.id) &&
            !outreach.get(i.id)!.sentAt &&
            (contacts.get(i.id)?.emails.length ?? 0) > 0
        )
      : status === 'replied'
        ? items.filter((i) => sequences.get(i.id)?.state === 'replied')
        : status && status !== 'all'
          ? items.filter((i) => i.status === status)
          : items;

  const tab = (key: string, label: string, n: number) => (
    <a
      key={key}
      href={`/funding?status=${key}`}
      className={
        (status ?? 'all') === key
          ? 'rounded border border-zinc-900 bg-zinc-900 px-2 py-1 text-[11px] font-semibold text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900'
          : 'rounded border border-zinc-300 bg-white px-2 py-1 text-[11px] text-zinc-600 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300'
      }
    >
      {label} {n}
    </a>
  );

  return (
    <div className="min-h-screen bg-zinc-50 px-4 py-8 dark:bg-zinc-950 sm:px-8">
      <main className="mx-auto max-w-4xl">
        <Nav current="funding" />

        {error && (
          <p className="mb-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        <div className="mb-4 flex flex-wrap gap-1.5">
          {tab('ready', 'ready to send', counts.ready)}
          {tab('replied', 'replied', counts.replied)}
          {tab('all', 'all', counts.all)}
          {tab('new', 'new', counts.new)}
          {tab('contacted', 'contacted', counts.contacted)}
          {tab('skipped', 'skipped', counts.skipped)}
        </div>

        <FundingSection
          items={shown}
          outreach={outreach}
          contacts={contacts}
          sequences={sequences}
          mailerReady={mailerConfigured()}
        />
      </main>
    </div>
  );
}
