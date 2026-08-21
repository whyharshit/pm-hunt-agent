import { getAllOutreachSequences } from '@/lib/storage';
import { fmtDate, fmtDue, fmtStamp } from '@/lib/format';
import {
  isOverdue,
  lastActivityAt,
  mailTimeline,
  needsAttention,
  type MailEvent,
} from '@/lib/mail-timeline';
import { Nav } from '../nav';
import type { OutreachSequence } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Every email this project has sent, as conversations rather than as rows.
 *
 * WHY IT EXISTS. All of this was already stored and none of it was readable: /funding showed a
 * status word, /jobs showed "✓ applied 3d ago", and "what has this thread done, and when?" had
 * no answer anywhere. On 2026-08-21 a follow-up went out seven hours after the recruiter had
 * replied, and the only reason anybody found out was that the user read their own inbox. A
 * tracker that shows the reply on the same line as the bump makes that visible at a glance.
 *
 * Threads that got an ANSWER sort to the top, because a reply is the one state in this system
 * no agent can act on.
 */

const STATE_BADGE: Record<OutreachSequence['state'], string> = {
  active: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  replied: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200',
  bounced: 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200',
  done: 'bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400',
  stopped: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500',
};

const STATE_LABEL: Record<OutreachSequence['state'], string> = {
  active: 'in sequence',
  replied: 'replied',
  bounced: 'bounced',
  done: 'no answer',
  stopped: 'stopped',
};

const EVENT_MARK: Record<MailEvent['kind'], string> = {
  sent: '✉',
  followup: '↻',
  reply: '💬',
  bounce: '⚠',
  stopped: '■',
  spent: '·',
  due: '⏳',
};

const EVENT_CLASS: Record<MailEvent['kind'], string> = {
  sent: 'text-zinc-700 dark:text-zinc-300',
  followup: 'text-zinc-500 dark:text-zinc-400',
  reply: 'font-semibold text-emerald-700 dark:text-emerald-400',
  bounce: 'text-red-600 dark:text-red-400',
  stopped: 'text-zinc-500 dark:text-zinc-500',
  spent: 'text-zinc-500 dark:text-zinc-500',
  due: 'text-blue-600 dark:text-blue-400',
};

function Timeline({ seq }: { seq: OutreachSequence }) {
  const events = mailTimeline(seq);
  return (
    <ol className="mt-2 space-y-1">
      {events.map((e, i) => (
        <li key={`${e.kind}-${e.at}-${i}`} className={`flex flex-wrap items-baseline gap-x-2 text-xs ${EVENT_CLASS[e.kind]}`}>
          <span className="w-4 shrink-0 text-center">{EVENT_MARK[e.kind]}</span>
          <span className="tabular-nums text-zinc-400 dark:text-zinc-500">
            {/* A due date is in the future, where an absolute stamp reads as history. */}
            {e.kind === 'due' ? fmtDue(e.at) : fmtStamp(e.at)}
          </span>
          <span>{e.label}</span>
          {e.approximate && (
            <span
              className="text-[10px] uppercase tracking-wide text-zinc-400 dark:text-zinc-500"
              title="the time we noticed, not the time it happened — this thread predates the reply record"
            >
              approx
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}

function SequenceCard({ seq }: { seq: OutreachSequence }) {
  const attention = needsAttention(seq);
  const overdue = isOverdue(seq);
  return (
    <li
      className={`rounded-lg border p-4 ${
        attention
          ? 'border-emerald-300 bg-emerald-50/40 dark:border-emerald-800 dark:bg-emerald-950/20'
          : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950'
      }`}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
          {seq.company || '(company not named)'}
        </span>
        <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
          {seq.kind === 'job' ? 'application' : 'funding'}
        </span>
        <span className={`rounded-full px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide ${STATE_BADGE[seq.state]}`}>
          {STATE_LABEL[seq.state]}
        </span>
        {overdue && (
          <span
            className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-800 dark:bg-amber-900/40 dark:text-amber-200"
            title="the next follow-up was due more than a day ago — a run either has not fired or declined for lack of time"
          >
            overdue
          </span>
        )}
        <span className="ml-auto text-[11px] text-zinc-400 dark:text-zinc-500">
          last activity {fmtDate(lastActivityAt(seq))}
        </span>
      </div>

      <p className="mt-1 truncate text-xs text-zinc-500 dark:text-zinc-400" title={seq.subject}>
        to {seq.to} · opened &quot;Hi {seq.greeted},&quot; · {seq.subject}
      </p>

      <Timeline seq={seq} />

      {/* The reply is the actionable case, so it says what to do rather than only that it
          happened. The body is NOT stored — this project never reads message bodies — so the
          honest instruction is to go and read it. */}
      {attention && (
        <p className="mt-2 rounded border border-emerald-200 bg-white px-2 py-1.5 text-xs text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
          They answered — read it in Gmail and reply by hand. Nothing automated writes back, and
          the sequence is closed, so no further follow-up will go out.
        </p>
      )}
    </li>
  );
}

export default async function MailPage({
  searchParams,
}: {
  searchParams: Promise<{ state?: string }>;
}) {
  const { state } = await searchParams;

  let sequences: OutreachSequence[] = [];
  let error: string | null = null;
  try {
    sequences = await getAllOutreachSequences();
  } catch (e) {
    error = (e as Error).message;
  }

  const counts = {
    all: sequences.length,
    replied: sequences.filter((s) => s.state === 'replied').length,
    active: sequences.filter((s) => s.state === 'active').length,
    overdue: sequences.filter((s) => isOverdue(s)).length,
    bounced: sequences.filter((s) => s.state === 'bounced').length,
    done: sequences.filter((s) => s.state === 'done').length,
    job: sequences.filter((s) => s.kind === 'job').length,
    funding: sequences.filter((s) => s.kind !== 'job').length,
  };

  const filtered =
    state === 'replied'
      ? sequences.filter((s) => s.state === 'replied')
      : state === 'active'
        ? sequences.filter((s) => s.state === 'active')
        : state === 'overdue'
          ? sequences.filter((s) => isOverdue(s))
          : state === 'bounced'
            ? sequences.filter((s) => s.state === 'bounced')
            : state === 'job' || state === 'funding'
              ? sequences.filter((s) => (s.kind === 'job') === (state === 'job'))
              : sequences;

  // Answers first, then whatever moved most recently. Sorting purely by time would bury a
  // reply from yesterday under three bumps sent this morning.
  const shown = [...filtered].sort((a, b) => {
    const attention = Number(needsAttention(b)) - Number(needsAttention(a));
    return attention !== 0 ? attention : +lastActivityAt(b) - +lastActivityAt(a);
  });

  const tab = (key: string, label: string, n: number) => (
    <a
      key={key}
      href={`/mail?state=${key}`}
      className={
        (state ?? 'all') === key
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
        <Nav current="mail" />

        <header className="mb-4">
          <h1 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">Mail</h1>
          <p className="mt-1 text-xs text-zinc-500 dark:text-zinc-400">
            Every thread this project has opened, in order: the first email, each follow-up, and
            the answer if one came. Times are IST, and a reply is stamped when THEY wrote it, not
            when the cron noticed.
          </p>
        </header>

        {error && (
          <p className="mb-4 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
            {error}
          </p>
        )}

        <div className="mb-4 flex flex-wrap gap-1.5">
          {tab('replied', 'replied', counts.replied)}
          {tab('active', 'in sequence', counts.active)}
          {tab('overdue', 'overdue', counts.overdue)}
          {tab('all', 'all', counts.all)}
          {tab('job', 'applications', counts.job)}
          {tab('funding', 'funding', counts.funding)}
          {tab('bounced', 'bounced', counts.bounced)}
        </div>

        {shown.length === 0 ? (
          <p className="rounded-lg border border-dashed border-zinc-300 bg-white p-6 text-center text-sm text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-400">
            {error
              ? 'Storage could not be read, so nothing can be shown.'
              : counts.all === 0
                ? 'No thread has been opened yet. A sequence starts the moment the first email goes out.'
                : 'No thread in this state.'}
          </p>
        ) : (
          <ul className="space-y-3">
            {shown.map((seq) => (
              <SequenceCard key={seq.id} seq={seq} />
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}
