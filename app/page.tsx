import {
  getAgentRuns,
  getFundingContacts,
  getFundingOutreaches,
  getGformPrefills,
  getRecentFunding,
  getRecentJobs,
  getRecentTracked,
  getTrackedArtifacts,
} from '@/lib/storage';
import type { TrackedArtifacts } from '@/lib/storage';
import { TIER_EMOJI } from '@/lib/classify';
import { LIVE_AGENT_IDS } from '@/lib/agents';
import { setTrackedStatus, tailorTracked } from '@/lib/actions';
import { mailerConfigured } from '@/lib/mailer';
import { fmtDate, hostOf } from '@/lib/format';
import { answersFilled } from '@/lib/gform';
import { AgentsPanel } from './agents-panel';
import { FundingSection } from './funding-section';
import { AddUrlForm } from './add-url-form';
import { GformRow } from './gform-row';
import { CopyButton } from './copy-button';
import type {
  AgentRun,
  FundingContact,
  FundingItem,
  FundingOutreach,
  GformPrefill,
  TrackedUrl,
} from '@/lib/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const maxDuration = 120;

const STATUSES: TrackedUrl['status'][] = ['new', 'drafted', 'submitted', 'rejected', 'skipped'];

const STATUS_CLASS: Record<TrackedUrl['status'], string> = {
  new: 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200',
  drafted: 'bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200',
  submitted: 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200',
  rejected: 'bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-400 line-through',
  skipped: 'bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500',
};

async function loadData() {
  try {
    const [tracked, jobs, agentRuns, funding] = await Promise.all([
      getRecentTracked(50),
      getRecentJobs(50),
      getAgentRuns(LIVE_AGENT_IDS),
      getRecentFunding(50),
    ]);
    const greenIds = tracked.filter((t) => t.tier === 'green').map((t) => t.id);
    const [artifacts, fundingOutreach, fundingContacts, gformPrefills] = await Promise.all([
      getTrackedArtifacts(tracked.map((t) => t.id)),
      getFundingOutreaches(funding.map((f) => f.id)),
      getFundingContacts(funding.map((f) => f.id)),
      getGformPrefills(greenIds),
    ]);
    return {
      tracked,
      jobs,
      artifacts,
      agentRuns,
      funding,
      fundingOutreach,
      fundingContacts,
      gformPrefills,
      error: null as string | null,
    };
  } catch (e) {
    return {
      tracked: [] as TrackedUrl[],
      jobs: [] as Awaited<ReturnType<typeof getRecentJobs>>,
      artifacts: new Map<string, TrackedArtifacts>(),
      agentRuns: new Map<string, AgentRun>(),
      funding: [] as FundingItem[],
      fundingOutreach: new Map<string, FundingOutreach>(),
      fundingContacts: new Map<string, FundingContact>(),
      gformPrefills: new Map<string, GformPrefill>(),
      error: (e as Error).message,
    };
  }
}

export default async function Home() {
  const {
    tracked,
    jobs,
    artifacts,
    agentRuns,
    funding,
    fundingOutreach,
    fundingContacts,
    gformPrefills,
    error,
  } = await loadData();
  const answersReady = answersFilled();

  return (
    <div className="min-h-screen bg-zinc-50 dark:bg-black text-zinc-900 dark:text-zinc-100 font-sans">
      <main className="mx-auto max-w-5xl px-6 py-10 sm:py-14">
        <header className="mb-10 flex items-baseline justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Intern Hunt · Agent Control</h1>
            <p className="mt-1 text-sm text-zinc-500 dark:text-zinc-400">
              What each agent is fetching, plus tracked URLs and discovered roles.
            </p>
          </div>
          <div className="text-xs text-zinc-400 dark:text-zinc-500 tabular-nums">
            {tracked.length} tracked · {jobs.length} discovered
          </div>
        </header>

        {error && (
          <div className="mb-8 rounded-md border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950 dark:text-red-200">
            Couldn&apos;t load data: {error}
          </div>
        )}

        <AgentsPanel runs={agentRuns} />

        <section className="mb-12">
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Tracked URLs · {tracked.length}
          </h2>
          <AddUrlForm />
          {tracked.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              Nothing tracked yet. Paste a job URL above, or DM the Telegram bot.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
              {tracked.map((t) => {
                const art = artifacts.get(t.id);
                const canTailor = t.tier !== 'green';
                return (
                <li key={t.id} className="flex flex-col gap-2 px-4 py-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
                    <span className="text-xl leading-none" title={t.tier}>{TIER_EMOJI[t.tier]}</span>
                    <div className="min-w-0 flex-1">
                      <a
                        href={t.url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="block truncate text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                      >
                        {t.role || hostOf(t.url)}
                        {t.company ? (
                          <span className="ml-2 text-xs font-normal text-zinc-500 dark:text-zinc-400">{t.company}</span>
                        ) : (
                          <span className="ml-2 text-xs font-normal text-zinc-500 dark:text-zinc-400">{t.url}</span>
                        )}
                      </a>
                      <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                        added {fmtDate(t.addedAt)}
                      </div>
                    </div>
                    <span
                      className={`inline-flex h-6 items-center rounded-full px-2 text-xs font-medium ${STATUS_CLASS[t.status]}`}
                    >
                      {t.status}
                    </span>
                    <form action={setTrackedStatus} className="flex items-center gap-2">
                      <input type="hidden" name="id" value={t.id} />
                      <select
                        name="status"
                        defaultValue={t.status}
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

                  {canTailor && (
                    <div className="flex flex-wrap items-center gap-2 sm:pl-9">
                      <form action={tailorTracked}>
                        <input type="hidden" name="id" value={t.id} />
                        <button
                          type="submit"
                          className="h-7 rounded border border-indigo-300 bg-indigo-50 px-2 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-200 dark:hover:bg-indigo-900"
                        >
                          {art?.hasPdf ? 'Re-tailor' : 'Tailor'}
                        </button>
                      </form>
                      {art?.hasPdf && (
                        <a
                          href={`/download/${t.id}`}
                          target="_blank"
                          rel="noreferrer noopener"
                          className="inline-flex h-7 items-center rounded border border-zinc-300 bg-white px-2 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200 dark:hover:bg-zinc-800"
                        >
                          Download PDF
                        </a>
                      )}
                      {art?.blurb && <CopyButton text={art.blurb.text} />}
                      {art?.blurb && (
                        <span className="max-w-md truncate text-xs italic text-zinc-500 dark:text-zinc-400" title={art.blurb.text}>
                          “{art.blurb.text}”
                        </span>
                      )}
                      {t.tailorError && (
                        <span className="text-xs text-red-600 dark:text-red-400" title={t.tailorError}>
                          ⚠ {t.tailorError}
                        </span>
                      )}
                    </div>
                  )}

                  {t.tier === 'green' && (
                    <GformRow
                      tracked={t}
                      prefill={gformPrefills.get(t.id)}
                      answersReady={answersReady}
                    />
                  )}
                </li>
                );
              })}
            </ul>
          )}
        </section>

        <FundingSection
          items={funding}
          outreach={fundingOutreach}
          contacts={fundingContacts}
          mailerReady={mailerConfigured()}
        />

        <section>
          <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
            Discovered Jobs · {jobs.length}
          </h2>
          {jobs.length === 0 ? (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No jobs saved yet. The daily cron will populate this once a match clears the filters.
            </p>
          ) : (
            <ul className="divide-y divide-zinc-200 dark:divide-zinc-800 rounded-lg border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-950">
              {jobs.map((j) => (
                <li key={j.id} className="px-4 py-3">
                  <a
                    href={j.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="block text-sm font-medium text-zinc-900 hover:underline dark:text-zinc-100"
                  >
                    {j.title}
                  </a>
                  <div className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
                    {j.company} · {j.location || 'remote'} · <span className="italic">{j.source}</span>
                    {j.salary ? ` · ${j.salary}` : ''} · {fmtDate(j.postedAt)}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
