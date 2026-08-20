import { runAutoSend } from '@/lib/autosend';
import { runFollowUps } from '@/lib/followup';
import { runFundingScan } from '@/lib/funding';
import { runJobAutoSend } from '@/lib/job-autosend';
import { runJobPrepare } from '@/lib/job-prepare';
import { runPrepare } from '@/lib/prepare';
import { fetchFundingNews } from '@/lib/sources/fundingnews';
import { fetchTechCrunchFundingDetailed } from '@/lib/sources/techcrunch';

export const dynamic = 'force-dynamic';
// Raised from 120 when the follow-up pass moved in: one invocation now covers the scan, the
// cold sends, an IMAP session and the follow-up sends.
export const maxDuration = 300;

function authOk(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return true;
  return request.headers.get('authorization') === `Bearer ${secret}`;
}

async function handle(request: Request) {
  if (!authOk(request)) {
    return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  const url = new URL(request.url);
  // Debug must exercise the SAME sources the real scan does, or it reports health for a
  // subset and a broken feed hides behind a green check.
  if (url.searchParams.get('debug') === 'true') {
    const [tc, news] = await Promise.all([
      fetchTechCrunchFundingDetailed().catch((e) => ({ error: (e as Error).message })),
      fetchFundingNews().catch((e) => ({ error: (e as Error).message })),
    ]);
    return Response.json({ debug: true, techcrunch: tc, news });
  }

  // Vercel Hobby caps at 2 crons and both are taken, so morning outreach rides along with
  // the funding scan rather than getting its own schedule. That makes this route the one
  // that mails real founders, so it must send on the SCHEDULE and never merely because
  // someone curled it while debugging.
  //
  // The trigger is Vercel's documented cron user-agent, not a query string: the docs
  // guarantee `vercel-cron/1.0` on scheduled invocations but say nothing about query
  // strings surviving in a cron `path`, and betting on that would fail silently — the
  // schedule would run, never send, and look configured. `?autosend=true` forces a send
  // manually; `?autosend=dry` reports what would go out and sends nothing.
  const autosend = url.searchParams.get('autosend');
  const isVercelCron = /vercel-cron/i.test(request.headers.get('user-agent') ?? '');
  const shouldSend = autosend === 'true' || (isVercelCron && autosend !== 'off');

  // Follow-ups ride the same schedule, on the same trigger, with the same switches. They are
  // controlled separately from the cold sends so a rehearsal can inspect one without the
  // other: `?autosend=off&followups=dry` shows the bumps that are due and mails nobody.
  const followups = url.searchParams.get('followups');
  const shouldFollowUp = followups === 'true' || (shouldSend && followups !== 'off');

  // Enrichment + drafting ride the same trigger as the sends, for one reason: without them
  // the sender has nothing to send. They ran ONLY as manual admin actions until 2026-08-13,
  // so the cron woke each morning to rows with no contact and no draft and mailed nobody for
  // four days straight while reporting `ok: true`. See lib/prepare.ts.
  //
  // Same switches as the other two passes, and the same reason for them: `?prepare=dry`
  // reports the budgets and touches nothing, `?prepare=off` suppresses a scheduled run, and
  // `?prepare=true` forces one by hand. Note that unlike a send, this pass SPENDS a metered
  // quota (Hunter credits, Gemini calls), so it is deliberately not run by a bare debug curl.
  const prepare = url.searchParams.get('prepare');
  const shouldPrepare = prepare === 'true' || (shouldSend && prepare !== 'off');

  // JOB outreach (2026-08-17) rides this route rather than /api/discover for one hard reason:
  // discover is capped at 60s and its slowest source already fills most of that, while this
  // invocation has 300s and is already the one that mails people. Hobby allows two crons and
  // both are spoken for, so there is no third schedule to give it.
  //
  // Its own switch, deliberately not `autosend`: `?jobs=dry` rehearses the job sender alone,
  // `?jobs=off` suppresses it on a scheduled run while founder outreach carries on, and
  // `?jobs=true` forces one by hand. Pausing one pipeline must never silently pause the other.
  //
  // ⚠️ `?jobs=prepare` RUNS THE PREPARE PASS AND NOTHING ELSE, added 2026-08-20. Until then
  // the only way to force a prepare pass by hand was `?jobs=true`, which forces the SENDER in
  // the same breath — so "re-draft the queue" and "mail twenty people right now" were the same
  // button, and the honest way to ask for the first was to not ask. `dry` rehearses both,
  // `prepare` commits the half that writes drafts and mails nobody. It is the same pass the
  // dashboard's Prepare jobs button runs, which exists because the KV secrets read back
  // redacted and nothing can reach storage from a shell.
  const jobs = url.searchParams.get('jobs');
  const prepareJobsOnly = jobs === 'prepare';
  const shouldRunJobs = jobs === 'true' || (isVercelCron && jobs !== 'off');

  try {
    const result = await runFundingScan();

    // BEFORE the sender, never after: a row enriched and drafted this morning is then
    // eligible in the very same invocation, so a company that raised yesterday can be
    // contacted today rather than tomorrow.
    const prepareResult =
      shouldPrepare || prepare === 'dry' ? await runPrepare({ dryRun: prepare === 'dry' }) : null;

    const autosendResult =
      shouldSend || autosend === 'dry'
        ? await runAutoSend({ dryRun: autosend === 'dry' })
        : null;

    const followupResult =
      shouldFollowUp || followups === 'dry'
        ? await runFollowUps({ dryRun: followups === 'dry' })
        : null;

    // Prepare then send, in that order and for the same reason the funding pair runs that
    // way: a job discovered this morning gets its contact, its draft and its email in one
    // invocation instead of waiting a day between each step.
    const jobsDry = jobs === 'dry';
    const jobPrepareResult =
      shouldRunJobs || jobsDry || prepareJobsOnly
        ? // `manual` on a hand-forced pass, exactly as the dashboard button does it: a human
          // asked for this batch and is reading the result, so it gets the longer clock and the
          // button's credit allowance rather than the cron's sip.
          await runJobPrepare({ dryRun: jobsDry, manual: prepareJobsOnly })
        : null;
    // NOT on `prepareJobsOnly`. That is the entire point of the switch.
    const jobSendResult =
      shouldRunJobs || jobsDry ? await runJobAutoSend({ dryRun: jobsDry }) : null;

    if (prepareResult || autosendResult || followupResult || jobPrepareResult) {
      return Response.json({
        ok: true,
        ...result,
        ...(prepareResult ? { prepare: prepareResult } : {}),
        ...(autosendResult ? { autosend: autosendResult } : {}),
        ...(followupResult ? { followups: followupResult } : {}),
        ...(jobPrepareResult ? { jobPrepare: jobPrepareResult } : {}),
        ...(jobSendResult ? { jobSend: jobSendResult } : {}),
        triggeredByCron: isVercelCron,
      });
    }

    return Response.json({ ok: true, ...result });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  return handle(request);
}

export async function GET(request: Request) {
  return handle(request);
}
