'use server';

import { revalidatePath } from 'next/cache';
import { updateTracked } from './storage';
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
