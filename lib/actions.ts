'use server';

import { revalidatePath } from 'next/cache';
import {
  getFundingContact,
  getFundingItem,
  getFundingOutreach,
  getTracked,
  recordAgentRun,
  saveFundingContact,
  saveFundingOutreach,
  saveGformPrefill,
  saveTracked,
  updateFundingStatus,
  updateTracked,
  urlId,
} from './storage';
import { classifyUrl, extractUrls, TIER_EMOJI } from './classify';
import { generatePrefill } from './gform';
import { hostOf } from './format';
import { sendOutreachMail } from './mailer';
import { runTailorPipeline } from './pipeline';
import { runDiscovery } from './discover';
import { findContact } from './contact';
import { draftOutreach, runFundingScan } from './funding';
import type { FundingItem, TrackedUrl } from './types';

const VALID_STATUSES: TrackedUrl['status'][] = ['new', 'drafted', 'submitted', 'rejected', 'skipped'];
const VALID_FUNDING_STATUSES: FundingItem['status'][] = ['new', 'contacted', 'skipped'];

export type AddUrlState = { ok: boolean; message: string };

/**
 * Dashboard equivalent of DMing the bot a link — same classifier, same tracker storage,
 * so a manually-added URL is indistinguishable downstream (the tailorer just works).
 * Takes free text, not a strict URL, to match the webhook's forgiving paste behaviour.
 */
export async function addTrackedUrl(_prev: AddUrlState, formData: FormData): Promise<AddUrlState> {
  const raw = formData.get('url');
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, message: 'Paste a URL first.' };

  const urls = extractUrls(raw.trim());
  if (urls.length === 0) return { ok: false, message: 'No http(s) link found in that text.' };

  const added: string[] = [];
  let dupes = 0;
  for (const url of urls) {
    const id = urlId(url);
    if (await getTracked(id)) {
      dupes += 1;
      continue;
    }
    const tier = classifyUrl(url);
    await saveTracked({
      id,
      url,
      tier,
      source: 'manual',
      addedAt: new Date().toISOString(),
      status: 'new',
    });
    added.push(`${TIER_EMOJI[tier]} ${hostOf(url)}`);
  }

  if (added.length > 0) {
    await recordAgentRun('intake', {
      state: 'ok',
      summary: `+${added.length} URL${added.length > 1 ? 's' : ''} · manual`,
      stats: { received: urls.length, added: added.length },
      error: null,
    });
  }
  revalidatePath('/');

  if (added.length === 0) return { ok: false, message: `Already tracked (${dupes}).` };
  return {
    ok: true,
    message: `Added ${added.join(', ')}${dupes ? ` · ${dupes} already tracked` : ''}`,
  };
}

export async function setTrackedStatus(formData: FormData): Promise<void> {
  const id = formData.get('id');
  const status = formData.get('status');
  if (typeof id !== 'string' || typeof status !== 'string') return;
  if (!VALID_STATUSES.includes(status as TrackedUrl['status'])) return;
  await updateTracked(id, { status: status as TrackedUrl['status'] });
  revalidatePath('/');
}

/** "Run now" from an agent card. Each runnable agent records its own run-state. */
export async function runAgent(formData: FormData): Promise<void> {
  const id = formData.get('id');
  try {
    if (id === 'discover') {
      // notify:false — a manual run shouldn't blast a Telegram digest.
      await runDiscovery({ notify: false });
    } else if (id === 'funding') {
      await runFundingScan();
    }
  } catch {
    // run-state already recorded as 'error' inside the agent
  }
  revalidatePath('/');
}

/** Draft a per-company cold outreach message for a funding row, addressed to the founder if we know one. */
export async function draftFundingOutreach(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string') return;
  const item = await getFundingItem(id);
  if (!item) return;
  try {
    const contact = await getFundingContact(id);
    const outreach = await draftOutreach(item, contact);
    await saveFundingOutreach(id, outreach);
  } catch {
    // surfaced as no draft appearing; user can retry
  }
  revalidatePath('/');
}

/** Resolve who to send a funding row's outreach to: founder names + published emails off the company site. */
export async function findFundingContact(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string') return;
  const item = await getFundingItem(id);
  if (!item) return;
  try {
    await saveFundingContact(id, await findContact(item));
  } catch (e) {
    await saveFundingContact(id, {
      id,
      founders: [],
      emails: [],
      socials: [],
      foundAt: new Date().toISOString(),
      model: 'gemini-2.5-flash',
      note: `lookup failed: ${(e as Error).message}`,
    });
  }
  revalidatePath('/');
}

/**
 * Send one funding outreach email. Deliberately narrow: the recipient must be an address
 * the contact lookup actually found on the company's own site (no free-text "to"), and a
 * draft must already exist — so nothing gets composed and sent in the same click.
 */
export async function sendFundingEmail(formData: FormData): Promise<void> {
  const id = formData.get('id');
  const to = formData.get('to');
  if (typeof id !== 'string' || typeof to !== 'string') return;

  const [item, outreach, contact] = await Promise.all([
    getFundingItem(id),
    getFundingOutreach(id),
    getFundingContact(id),
  ]);
  if (!item || !outreach) return;

  // Only ever send to a harvested address — never to whatever the form posted.
  if (!contact?.emails.some((e) => e.address === to)) return;

  try {
    const subject = outreach.subject || `${item.company} — quick note`;
    await sendOutreachMail({ to, subject, text: outreach.text, company: item.company });
    await saveFundingOutreach(id, { ...outreach, sentAt: new Date().toISOString(), sentTo: to });
    await updateFundingStatus(id, 'contacted');
  } catch {
    // run-state already recorded as 'error' by sendOutreachMail; the card surfaces it
  }
  revalidatePath('/');
}

export async function setFundingStatus(formData: FormData): Promise<void> {
  const id = formData.get('id');
  const status = formData.get('status');
  if (typeof id !== 'string' || typeof status !== 'string') return;
  if (!VALID_FUNDING_STATUSES.includes(status as FundingItem['status'])) return;
  await updateFundingStatus(id, status as FundingItem['status']);
  revalidatePath('/');
}

/**
 * Generate a pre-filled link for a green-tier (Google Form) tracked row. Stores the
 * result — including which fields were left blank — and surfaces any error inline. Never
 * submits; the user opens the link, reviews, and submits themselves.
 */
export async function prefillGformTracked(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string') return;
  const tracked = await getTracked(id);
  if (!tracked) return;
  try {
    const prefill = await generatePrefill(id, tracked.url);
    await saveGformPrefill(id, prefill);
    await updateTracked(id, { tailorError: null });
    await recordAgentRun('formfiller', {
      state: 'ok',
      summary: `${prefill.filled.length}/${prefill.fieldCount} filled · ${prefill.formTitle}`.slice(0, 80),
      stats: { filled: prefill.filled.length, fields: prefill.fieldCount },
      error: null,
    });
  } catch (e) {
    await updateTracked(id, { tailorError: `prefill: ${(e as Error).message}` });
    await recordAgentRun('formfiller', { state: 'error', error: (e as Error).message });
  }
  revalidatePath('/');
}

/** Runs scrape → tailor → render → blurb for a tracked URL, then refreshes the dashboard. */
export async function tailorTracked(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string') return;
  const result = await runTailorPipeline(id);
  if (result.ok) {
    await updateTracked(id, { status: 'drafted', tailorError: null });
  } else {
    await updateTracked(id, { tailorError: `${result.stage}: ${result.error}` });
  }
  revalidatePath('/');
}
