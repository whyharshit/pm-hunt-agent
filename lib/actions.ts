'use server';

import { revalidatePath } from 'next/cache';
import {
  deleteFundingItem,
  deleteJob,
  deleteTracked,
  deleteWhatsappLead,
  getFundingContact,
  getFundingItem,
  getFundingOutreach,
  getJob,
  getJobContact,
  getJobOutreach,
  getOutreachSequence,
  getTracked,
  recordAgentRun,
  saveFundingContact,
  saveFundingOutreach,
  saveGformPrefill,
  saveJobContact,
  saveJobOutreach,
  saveTracked,
  updateFundingStatus,
  updateJobStatus,
  updateTracked,
  updateWhatsappLeadStatus,
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
import {
  EDITED_MODEL_SUFFIX,
  firstName,
  isEditedDraft,
  renderOutreachTemplate,
} from './outreach-template';
import { renderJobOutreach } from './job-outreach-template';
import { runJobPrepare } from './job-prepare';
import { ingestHiringPost } from './paste';
import { closeSequence, greetedIn, recordInitialSend } from './sequence';
import type { FundingContact, FundingItem, JobContact, TrackedUrl, WhatsappLead } from './types';

const VALID_STATUSES: TrackedUrl['status'][] = ['new', 'drafted', 'submitted', 'rejected', 'skipped'];
const VALID_FUNDING_STATUSES: FundingItem['status'][] = ['new', 'contacted', 'skipped'];
const VALID_LEAD_STATUSES: WhatsappLead['status'][] = ['new', 'contacted', 'skipped'];

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

/** Edit a draft on the dashboard before sending it. */
export async function updateFundingDraft(formData: FormData): Promise<void> {
  const id = formData.get('id');
  const text = formData.get('text');
  const subject = formData.get('subject');
  if (typeof id !== 'string' || typeof text !== 'string') return;
  if (!text.trim()) return; // an empty body is never an intended edit

  const existing = await getFundingOutreach(id);
  if (!existing) return;

  await saveFundingOutreach(id, {
    ...existing,
    text,
    subject: typeof subject === 'string' && subject.trim() ? subject.trim() : existing.subject,
    model: isEditedDraft(existing.model)
      ? existing.model
      : `${existing.model}${EDITED_MODEL_SUFFIX}`,
  });
  revalidatePath('/');
}

/** Drop a hand-edit and go back to the template, so an edit is never a one-way door. */
export async function resetFundingDraft(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string') return;
  const [item, contact] = await Promise.all([getFundingItem(id), getFundingContact(id)]);
  if (!item) return;
  const outreach = renderOutreachTemplate(item, contact);
  if (outreach) await saveFundingOutreach(id, outreach);
  revalidatePath('/');
}

/**
 * Row deletion, one action per list. Deliberately separate from the status dropdowns:
 * `skipped` keeps a row visible as a decision, deleting removes it and its artifacts.
 *
 * There is no undo, so each button carries a native confirm in the UI. A deleted funding or
 * discovered row also stays in its `seen` set, otherwise the next scan would resurrect it.
 */
export async function deleteTrackedRow(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string') return;
  await deleteTracked(id);
  revalidatePath('/');
}

export async function deleteFundingRow(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string') return;
  await deleteFundingItem(id);
  revalidatePath('/funding');
  revalidatePath('/');
}

export async function deleteWhatsappLeadRow(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string') return;
  await deleteWhatsappLead(id);
  revalidatePath('/');
}

export async function deleteJobRow(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string') return;
  await deleteJob(id);
  revalidatePath('/jobs');
  revalidatePath('/');
}

/**
 * Run the job contact-and-draft pass from the dashboard.
 *
 * ⚠️ THIS EXISTS BECAUSE THE CURL SWITCHES ARE UNREACHABLE. Every documented rehearsal in this
 * project (`?jobs=dry`, `?autosend=dry`, `?action=enrich`) needs `Bearer CRON_SECRET`, and on
 * 2026-08-18 that turned out to be impossible to obtain: the Vercel project has sensitive
 * environment variables switched on, so all 24 real secrets read back as `[SENSITIVE]` from
 * both the CLI and the dashboard. Nobody can recover the value, not even the account owner.
 *
 * So the one pass that has to run before anything is sendable now has a button. It writes
 * contacts and drafts; it does NOT send. Once it has run, `/jobs` shows exactly who the
 * unattended sender would write to, which is the thing the dry run was for.
 *
 * It spends up to `JOB_ENRICH_CREDITS_PER_CLICK` Hunter credits (default 5) — more than the
 * cron's 1, because a human pressing a button has decided this batch is worth paying for and
 * is watching the result. Rows whose paid lookup is already settled cost nothing to re-visit,
 * so pressing again advances into new rows rather than re-buying the same ones.
 */
export async function runJobPreparePass(): Promise<void> {
  try {
    await runJobPrepare({ manual: true });
  } catch {
    // Surfaced on the page by the absence of new contacts rather than by throwing into the
    // action, which would render an error boundary over the whole list.
  }
  revalidatePath('/jobs');
}

export type PasteState = { ok: boolean; message: string };

/**
 * Paste a hiring post you found yourself, get a drafted application back.
 *
 * Deliberately does NOT send. Pasting and sending in one click would mean a cold email
 * leaving on the same submit that composed it, with nobody having read either the address or
 * the greeting — and this page exists precisely for the posts the automated pipeline could
 * not reach, which are the ones most likely to need a human eye. Review, then press Send.
 */
export async function pasteHiringPost(
  _prev: PasteState,
  formData: FormData
): Promise<PasteState> {
  const text = formData.get('text');
  const company = formData.get('company');
  if (typeof text !== 'string' || typeof company !== 'string') {
    return { ok: false, message: 'Paste the post and name the company.' };
  }

  const str = (k: string) => {
    const v = formData.get(k);
    return typeof v === 'string' ? v : '';
  };

  try {
    const outcome = await ingestHiringPost({
      text,
      company,
      poster: str('poster'),
      role: str('role'),
      url: str('url'),
    });
    revalidatePath('/paste');
    revalidatePath('/jobs');
    return { ok: outcome.ok, message: outcome.message };
  } catch (e) {
    return { ok: false, message: `Failed: ${(e as Error).message}` };
  }
}

/**
 * Send one job application by hand, from the paste page or the jobs list.
 *
 * The same narrowing as `sendFundingEmail`: the recipient must be an address already stored
 * on the row's contact, never whatever the form posted, and a draft must already exist. The
 * unattended sender's extra gates (person-matched address, no shared inboxes) are NOT applied
 * here — a human is looking at the greeting and the address on the same screen, which is a
 * better check than any regex, and this button is how the shared-inbox rows get sent at all.
 */
export async function sendJobEmail(formData: FormData): Promise<void> {
  const id = formData.get('id');
  const to = formData.get('to');
  if (typeof id !== 'string' || typeof to !== 'string') return;

  const [job, draft, contact] = await Promise.all([
    getJob(id),
    getJobOutreach(id),
    getJobContact(id),
  ]);
  if (!job || !draft) return;
  if (!contact?.emails.some((e) => e.address === to)) return;

  try {
    const sent = await sendOutreachMail({
      to,
      subject: draft.subject,
      text: draft.text,
      company: job.company,
    });
    const sentAt = new Date().toISOString();
    await saveJobOutreach(id, { ...draft, sentAt: draft.sentAt ?? sentAt, sentTo: to });
    await updateJobStatus(id, 'contacted');
    await recordInitialSend({
      id,
      kind: 'job',
      company: job.company,
      to,
      greeted: firstName(greetedIn(draft.text) ?? contact?.people[0]?.name ?? ''),
      subject: draft.subject,
      sentAt,
      messageId: sent.id,
    });
  } catch {
    // run-state already recorded as 'error' by sendOutreachMail; the agent card surfaces it
  }
  revalidatePath('/paste');
  revalidatePath('/jobs');
}

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[a-z]{2,24}$/i;

/**
 * Add an address to a job row by hand — the same escape hatch funding rows have, for the
 * posts where the address is in an image, behind a link, or simply not there.
 */
export async function addJobContactEmail(formData: FormData): Promise<void> {
  const id = formData.get('id');
  const emailRaw = formData.get('email');
  const nameRaw = formData.get('name');
  if (typeof id !== 'string' || typeof emailRaw !== 'string') return;

  const email = emailRaw.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(email)) return;
  const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';

  const [job, existing] = await Promise.all([getJob(id), getJobContact(id)]);
  if (!job) return;

  const people = existing?.people ?? [];
  const merged = name
    ? [{ name }, ...people.filter((p) => p.name.toLowerCase() !== name.toLowerCase())]
    : people;

  const contact: JobContact = {
    id,
    people: merged,
    emails: [
      // Attach the person only when one was supplied, so the sender's greeting check has
      // something true to test against rather than a name paired with an unrelated inbox.
      { address: email, foundOn: 'added by hand', ...(name ? { person: name } : {}) },
      ...(existing?.emails ?? []).filter((e) => e.address !== email),
    ],
    website: existing?.website,
    foundAt: new Date().toISOString(),
    model: existing?.model ?? 'manual',
    note: existing?.note,
  };
  await saveJobContact(id, contact);

  // Re-render so the greeting matches whoever was just added. Free, no model involved.
  const draft = renderJobOutreach(job, contact);
  if (draft) await saveJobOutreach(id, draft);

  revalidatePath('/paste');
  revalidatePath('/jobs');
}

/**
 * Add a contact by hand — for the rows the automated lookup got wrong or couldn't reach.
 *
 * This exists because the harvester's real hit rate for a FOUNDER's address is low: sites
 * publish `info@`, Hunter is unsure which domain is the company, and some articles name
 * nobody. The user pulls those from ContactOut and pastes them here rather than the agent
 * guessing, which is the one thing it must never do.
 *
 * A name is accepted alongside the address and takes the lead position, because the email
 * opens "Hi <first name>" — supplying the address without the person would keep greeting
 * whoever the lookup had guessed. The draft is re-rendered here for the same reason, so
 * the greeting can never disagree with the recipient.
 *
 * Provenance is preserved: `foundOn` records that a human supplied this, so it stays
 * distinguishable from a scraped address forever.
 */
export async function addFundingContactEmail(formData: FormData): Promise<void> {
  const id = formData.get('id');
  const emailRaw = formData.get('email');
  const nameRaw = formData.get('name');
  if (typeof id !== 'string' || typeof emailRaw !== 'string') return;

  const email = emailRaw.trim().toLowerCase();
  if (!EMAIL_SHAPE.test(email)) return;
  const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';

  const [item, existing] = await Promise.all([getFundingItem(id), getFundingContact(id)]);
  if (!item) return;

  const founders = existing?.founders ?? [];
  // A supplied name leads: it is the person this address belongs to, so it must be the one
  // greeted. Any previously-guessed people are kept behind it, not discarded.
  const merged = name
    ? [{ name }, ...founders.filter((f) => f.name.toLowerCase() !== name.toLowerCase())]
    : founders;

  const contact: FundingContact = {
    id,
    founders: merged,
    website: existing?.website,
    emails: [
      { address: email, foundOn: 'added by hand' },
      ...(existing?.emails ?? []).filter((e) => e.address !== email),
    ],
    socials: existing?.socials ?? [],
    foundAt: new Date().toISOString(),
    model: existing?.model ?? 'manual',
    note: existing?.note,
  };
  await saveFundingContact(id, contact);

  // Re-render so the greeting matches the person just added. Free — no model involved.
  const outreach = renderOutreachTemplate(item, contact);
  if (outreach) await saveFundingOutreach(id, outreach);

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
    const sent = await sendOutreachMail({ to, subject, text: outreach.text, company: item.company });
    const sentAt = new Date().toISOString();
    await saveFundingOutreach(id, {
      ...outreach,
      // "Send again" used to overwrite this, destroying the record of when the founder first
      // heard from us. The first send is the one the draft is a record of, so it stands; the
      // full history lives on the sequence.
      sentAt: outreach.sentAt ?? sentAt,
      sentTo: to,
    });
    await updateFundingStatus(id, 'contacted');
    await recordInitialSend({
      id,
      company: item.company,
      to,
      greeted: firstName(greetedIn(outreach.text) ?? contact?.founders[0]?.name ?? ''),
      subject,
      sentAt,
      messageId: sent.id,
    });
  } catch {
    // run-state already recorded as 'error' by sendOutreachMail; the card surfaces it
  }
  revalidatePath('/');
}

/**
 * Stop a follow-up sequence by hand.
 *
 * The reply check reads INBOX, so it cannot see a founder who answered from a different
 * address, replied to a colleague, or landed in a filtered label. This is the override for
 * those, and for "I have decided not to chase this one".
 */
export async function stopFollowUps(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string') return;
  const seq = await getOutreachSequence(id);
  if (!seq || seq.state !== 'active') return;
  await closeSequence(seq, 'stopped', 'stopped on the dashboard');
  revalidatePath('/funding');
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

/** Mark a URL-less WhatsApp lead (email/DM apply route) as handled. */
export async function setWhatsappLeadStatus(formData: FormData): Promise<void> {
  const id = formData.get('id');
  const status = formData.get('status');
  if (typeof id !== 'string' || typeof status !== 'string') return;
  if (!VALID_LEAD_STATUSES.includes(status as WhatsappLead['status'])) return;
  await updateWhatsappLeadStatus(id, status as WhatsappLead['status']);
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
