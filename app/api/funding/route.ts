import { runAutoSend } from '@/lib/autosend';
import { runFollowUps } from '@/lib/followup';
import { runFundingScan } from '@/lib/funding';
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

    if (prepareResult || autosendResult || followupResult) {
      return Response.json({
        ok: true,
        ...result,
        ...(prepareResult ? { prepare: prepareResult } : {}),
        ...(autosendResult ? { autosend: autosendResult } : {}),
        ...(followupResult ? { followups: followupResult } : {}),
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
