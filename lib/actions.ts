'use server';

import { revalidatePath } from 'next/cache';
import { updateTracked } from './storage';
import { runTailorPipeline } from './pipeline';
import { runDiscovery } from './discover';
import type { TrackedUrl } from './types';

const VALID_STATUSES: TrackedUrl['status'][] = ['new', 'drafted', 'submitted', 'rejected', 'skipped'];

export async function setTrackedStatus(formData: FormData): Promise<void> {
  const id = formData.get('id');
  const status = formData.get('status');
  if (typeof id !== 'string' || typeof status !== 'string') return;
  if (!VALID_STATUSES.includes(status as TrackedUrl['status'])) return;
  await updateTracked(id, { status: status as TrackedUrl['status'] });
  revalidatePath('/');
}

/** "Run now" from an agent card. Only Discover is runnable on demand today. */
export async function runAgent(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (id === 'discover') {
    // notify:false — a manual run shouldn't blast a Telegram digest. runDiscovery
    // records its own run-state, so failures still surface on the card.
    try {
      await runDiscovery({ notify: false });
    } catch {
      // run-state already recorded as 'error' inside runDiscovery
    }
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
