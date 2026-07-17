'use server';

import { revalidatePath } from 'next/cache';
import {
  getFundingContact,
  getFundingItem,
  saveFundingContact,
  saveFundingOutreach,
  updateFundingStatus,
  updateTracked,
} from './storage';
import { runTailorPipeline } from './pipeline';
import { runDiscovery } from './discover';
import { findContact } from './contact';
import { draftOutreach, runFundingScan } from './funding';
import type { FundingItem, TrackedUrl } from './types';

const VALID_STATUSES: TrackedUrl['status'][] = ['new', 'drafted', 'submitted', 'rejected', 'skipped'];
const VALID_FUNDING_STATUSES: FundingItem['status'][] = ['new', 'contacted', 'skipped'];

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

export async function setFundingStatus(formData: FormData): Promise<void> {
  const id = formData.get('id');
  const status = formData.get('status');
  if (typeof id !== 'string' || typeof status !== 'string') return;
  if (!VALID_FUNDING_STATUSES.includes(status as FundingItem['status'])) return;
  await updateFundingStatus(id, status as FundingItem['status']);
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
