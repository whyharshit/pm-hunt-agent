import { AGENTS, runDisplayState, type AgentMeta, type RunDisplayState } from '@/lib/agents';
import { runAgent } from '@/lib/actions';
import { fmtDate } from '@/lib/format';
import type { AgentRun } from '@/lib/types';

const DOT: Record<RunDisplayState, string> = {
  idle: 'bg-zinc-400 dark:bg-zinc-600',
  running: 'bg-amber-500 animate-pulse',
  ok: 'bg-green-500',
  error: 'bg-red-500',
  // NOT pulsing, and not the same colour as a live run. The whole point is that this state
  // used to be indistinguishable from `running`.
  dead: 'bg-red-600 ring-2 ring-red-200 dark:ring-red-900',
};

const KIND_LABEL: Record<AgentMeta['kind'], string> = {
  cron: 'scheduled',
  webhook: 'webhook',
  pipeline: 'pipeline',
};

function AgentCard({ agent, run }: { agent: AgentMeta; run?: AgentRun }) {
  const planned = agent.status === 'planned';
  // ⚠️ `runDisplayState`, never `run.state`. A pass killed at its maxDuration leaves the
  // record saying `running` for ever, because the statement that would correct it is the one
  // that never ran. See lib/agents.ts.
  const state: RunDisplayState = planned ? 'idle' : runDisplayState(run);

  return (
    <li
      className={`flex flex-col gap-2 rounded-lg border p-4 ${
        planned
          ? 'border-dashed border-zinc-300 bg-zinc-50/50 dark:border-zinc-800 dark:bg-zinc-950/50'
          : 'border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${planned ? 'bg-zinc-300 dark:bg-zinc-700' : DOT[state]}`} />
        <span className={`text-sm font-semibold ${planned ? 'text-zinc-400 dark:text-zinc-500' : 'text-zinc-900 dark:text-zinc-100'}`}>
          {agent.name}
        </span>
        <span className="ml-auto rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500 dark:bg-zinc-900 dark:text-zinc-400">
          {planned ? 'planned' : `${KIND_LABEL[agent.kind]}${agent.cadence ? ` · ${agent.cadence}` : ''}`}
        </span>
      </div>

      <p className={`text-xs leading-relaxed ${planned ? 'text-zinc-400 dark:text-zinc-600' : 'text-zinc-500 dark:text-zinc-400'}`}>
        {agent.description}
      </p>

      {!planned && (
        <div className="mt-auto flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          {state === 'dead' ? (
            <span className="text-red-600 dark:text-red-400">
              ⚠ cut off mid-run — no result was ever recorded
              {run?.startedAt ? `, started ${fmtDate(run.startedAt)}` : ''}
            </span>
          ) : run?.summary ? (
            <span className="text-zinc-700 dark:text-zinc-300">{run.summary}</span>
          ) : state === 'running' ? (
            <span className="text-amber-700 dark:text-amber-500">
              in flight{run?.startedAt ? ` — started ${fmtDate(run.startedAt)}` : ''}
            </span>
          ) : (
            <span className="text-zinc-400 dark:text-zinc-500 italic">no run yet</span>
          )}
          {run?.finishedAt && state !== 'dead' && (
            <span className="text-zinc-400 dark:text-zinc-500 tabular-nums">{fmtDate(run.finishedAt)}</span>
          )}
          {run?.error && (
            <span className="text-red-600 dark:text-red-400" title={run.error}>
              ⚠ {run.error.length > 60 ? `${run.error.slice(0, 60)}…` : run.error}
            </span>
          )}
          {agent.runnable && (
            <form action={runAgent} className="ml-auto">
              <input type="hidden" name="id" value={agent.id} />
              <button
                type="submit"
                className="h-7 rounded border border-indigo-300 bg-indigo-50 px-2 text-xs font-medium text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-indigo-950 dark:text-indigo-200 dark:hover:bg-indigo-900"
              >
                Run now
              </button>
            </form>
          )}
        </div>
      )}
    </li>
  );
}

export function AgentsPanel({ runs }: { runs: Map<string, AgentRun> }) {
  return (
    <section className="mb-12">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
        Agents · {AGENTS.filter((a) => a.status === 'live').length} live
      </h2>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {AGENTS.map((agent) => (
          <AgentCard key={agent.id} agent={agent} run={runs.get(agent.id)} />
        ))}
      </ul>
    </section>
  );
}
