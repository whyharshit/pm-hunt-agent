'use server';

import { revalidatePath } from 'next/cache';
import {
  deleteFundingItem,
  deleteJob,
  deleteLinkedInInvite,
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
  saveJobs,
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
import { importConnections, logInvite, markAccepted, runLinkedInScan } from './linkedin';
import { findContact } from './contact';
import { draftOutreach, runFundingScan } from './funding';
import {
  EDITED_MODEL_SUFFIX,
  firstName,
  isEditedDraft,
  renderOutreachTemplate,
} from './outreach-template';
import {
  EDITED_JOB_MODEL_SUFFIX,
  isEditedJobDraft,
  isStaleJobDraft,
  isTeamDraft,
  renderJobOutreach,
} from './job-outreach-template';
import { runJobAutoSend } from './job-autosend';
import { runJobPrepare } from './job-prepare';
import { ingestHiringPost } from './paste';
import { companyLabel, employerName } from './postjob';
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
    } else if (id === 'linkedin') {
      await runLinkedInScan();
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
/**
 * Edit a job application before it goes out. The funding pipeline has had this since
 * 2026-08-08; job rows were preview-only, so the only options on a draft that read slightly
 * wrong were send it or delete the row.
 *
 * Marking the model `+edited` is the load-bearing part, not the text. Three separate machines
 * rewrite drafts they believe they own, and all three check this flag:
 *   - `isStaleJobDraft` re-renders stale template drafts on the next prepare pass,
 *   - `greetingMatches` in the unattended sender re-renders when the recipient changed,
 *   - `resetJobDraft` below is the only way back.
 * Without the flag, a hand-edited application would be silently reverted by whichever ran
 * first, and the user would find the machine's wording in their sent mail.
 */
export async function updateJobDraft(formData: FormData): Promise<void> {
  const id = formData.get('id');
  const text = formData.get('text');
  const subject = formData.get('subject');
  if (typeof id !== 'string' || typeof text !== 'string') return;
  if (!text.trim()) return; // an empty body is never an intended edit

  const existing = await getJobOutreach(id);
  if (!existing) return;
  // A sent draft is a RECORD of what somebody received. Editing it would make the dashboard
  // disagree with their inbox, and the follow-ups quote it.
  if (existing.sentAt) return;

  await saveJobOutreach(id, {
    ...existing,
    text,
    subject: typeof subject === 'string' && subject.trim() ? subject.trim() : existing.subject,
    model: isEditedJobDraft(existing.model)
      ? existing.model
      : `${existing.model}${EDITED_JOB_MODEL_SUFFIX}`,
  });
  revalidatePath('/paste');
  revalidatePath('/jobs');
}

/** Drop a hand-edit and go back to the template, so an edit is never a one-way door. */
export async function resetJobDraft(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string') return;

  const [job, contact, existing] = await Promise.all([
    getJob(id),
    getJobContact(id),
    getJobOutreach(id),
  ]);
  if (!job || existing?.sentAt) return;

  // Re-render the SAME KIND of draft. Regenerating a team draft as a person draft (or the
  // reverse) would hand the sender copy whose greeting cannot match its recipient, which it
  // refuses to send — so a Reset would read as having broken the row.
  const greeting = existing && isTeamDraft(existing.model) ? 'team' : 'person';
  const rendered = renderJobOutreach(job, contact, { greeting });
  if (rendered) await saveJobOutreach(id, rendered);
  revalidatePath('/paste');
  revalidatePath('/jobs');
}

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

/**
 * Send the eligible job applications now, instead of waiting for tomorrow's cron.
 *
 * Calls `runJobAutoSend` itself — the same function the cron calls, with the same gates, the
 * same cap and the same pacing. It is emphatically NOT a second sending path: a button that
 * re-implemented "send everything eligible" would be a second definition of eligible, and the
 * whole point of the gates is that there is exactly one.
 *
 * Bounded by `JOB_SEND_MAX_PER_DAY` like any other run, so pressing it twice does not send
 * twice as much on top of the cron's own batch — the rows it sent are marked `contacted` and
 * drop out of the queue.
 */
export async function sendEligibleJobs(): Promise<void> {
  try {
    await runJobAutoSend();
  } catch {
    // run-state already recorded as 'error' by the sender; the agent card surfaces it
  }
  revalidatePath('/jobs');
  revalidatePath('/');
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
    return { ok: false, message: 'Paste the post text first.' };
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
      linkedin: str('linkedin'),
      email: str('email'),
      phone: str('phone'),
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

  const [job, stored, contact] = await Promise.all([
    getJob(id),
    getJobOutreach(id),
    getJobContact(id),
  ]);
  if (!job || !stored) return;
  if (!contact?.emails.some((e) => e.address === to)) return;

  // ⚠️ RE-RENDER A STALE-TEMPLATE DRAFT BEFORE SENDING IT, added 2026-08-20. The prepare pass
  // rewrites old drafts, but it is capped per run, so a row a human clicks Send on today can
  // still be holding a v3 draft - and every v3 draft on a LinkedIn post row names the POSTER
  // as the employer. A hand-edited draft is left exactly as the human wrote it: theirs to
  // send, and the whole point of the edit flag.
  let draft = stored;
  if (isStaleJobDraft(draft.model)) {
    const fresh = renderJobOutreach(job, contact, {
      greeting: isTeamDraft(draft.model) ? 'team' : 'person',
    });
    if (!fresh) return;
    draft = { ...fresh, sentAt: draft.sentAt, sentTo: draft.sentTo };
    await saveJobOutreach(id, draft);
  }

  try {
    const sent = await sendOutreachMail({
      to,
      subject: draft.subject,
      text: draft.text,
      // Readable label for the agent card; the SEQUENCE below gets the trusted name, because
      // that one is interpolated into the follow-up bodies. Two different questions - see
      // employerName/companyLabel in lib/postjob.ts.
      company: companyLabel(job),
    });
    const sentAt = new Date().toISOString();
    await saveJobOutreach(id, { ...draft, sentAt: draft.sentAt ?? sentAt, sentTo: to });
    await updateJobStatus(id, 'contacted');
    await recordInitialSend({
      id,
      kind: 'job',
      company: employerName(job),
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
 * Attach the post's URL to a job row after the fact.
 *
 * Rows can be born without one — a pasted post whose text carried no link, a WhatsApp relay —
 * and the /linkedin evidence card depends on `job.url` to let a human check a name-matched
 * poster. Re-pasting cannot repair it: `ingestHiringPost` refuses once the row is contacted,
 * which is precisely when the acceptance shows up and the link is wanted. So this is the door.
 */
export async function attachJobUrl(formData: FormData): Promise<void> {
  const id = formData.get('id');
  const urlRaw = formData.get('url');
  if (typeof id !== 'string' || typeof urlRaw !== 'string') return;

  let parsed: URL;
  try {
    parsed = new URL(urlRaw.trim());
  } catch {
    return;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return;

  const job = await getJob(id);
  if (!job) return;
  await saveJobs([{ ...job, url: parsed.toString() }]);

  revalidatePath('/linkedin');
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

/* ---- LinkedIn tracker ---------------------------------------------------------------- */

export type LinkedInFormState = { ok: boolean; message: string };

/**
 * Log an invitation the user sent by hand.
 *
 * ⚠️ THIS IS THE ONLY WAY A PENDING INVITATION CAN BE KNOWN. LinkedIn emails an acceptance and
 * emails nothing at all when an invitation is merely sent, and there is no API — so "invited,
 * waiting" is a fact only the person who clicked Connect has. See lib/linkedin-mail.ts.
 */
export async function logLinkedInInvite(
  _prev: LinkedInFormState,
  formData: FormData
): Promise<LinkedInFormState> {
  const name = formData.get('name');
  if (typeof name !== 'string' || !name.trim()) {
    return { ok: false, message: 'A name is needed — it is what an acceptance is matched on.' };
  }
  const profileUrl = formData.get('profileUrl');
  const note = formData.get('note');
  try {
    const invite = await logInvite({
      name: name.trim(),
      profileUrl: typeof profileUrl === 'string' ? profileUrl : undefined,
      note: typeof note === 'string' ? note : undefined,
    });
    revalidatePath('/linkedin');
    return {
      ok: true,
      message: invite.jobLabel
        ? `Logged ${invite.name}, matched to ${invite.jobLabel}.`
        : `Logged ${invite.name}.`,
    };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

/** Mark an invitation accepted by hand — always available, mail or no mail. */
export async function markLinkedInAccepted(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string') return;
  await markAccepted(id);
  revalidatePath('/linkedin');
}

export async function deleteLinkedInRow(formData: FormData): Promise<void> {
  const id = formData.get('id');
  if (typeof id !== 'string') return;
  await deleteLinkedInInvite(id);
  revalidatePath('/linkedin');
}

/**
 * Scan the mailbox for LinkedIn acceptances, from the dashboard.
 *
 * The cron runs this too; the button exists for the same reason every other one here does —
 * the curl switches need a CRON_SECRET that reads back redacted, so a page is the only place a
 * human can ask for a pass to run.
 *
 * Returns nothing on purpose. The pass already writes a full summary onto its agent record
 * ("no LinkedIn mail in the last 30 days …"), and /linkedin renders that, so a second reporting
 * path here would be a second thing to keep true — and it would vanish on the next reload.
 */
export async function scanLinkedInMailNow(): Promise<void> {
  try {
    await runLinkedInScan();
  } catch {
    // recorded as state:'error' on the agent card inside the pass
  }
  revalidatePath('/linkedin');
  revalidatePath('/');
}

/**
 * Import LinkedIn's connections export.
 *
 * ⚠️ THIS IS THE TRACKER'S REAL INPUT, not a convenience. Two acceptances on 2026-08-21/22
 * produced no email whatsoever — LinkedIn sent phone notifications and nothing else — so the
 * mail parser has nothing to read. The CSV comes from LinkedIn → Settings → Data privacy → Get
 * a copy of your data → Connections, and it states, per person, the day the connection was
 * made. See lib/linkedin-csv.ts.
 *
 * Takes either an uploaded file or pasted text, because a phone browser cannot always hand a
 * file to a form and the file is small enough to paste.
 */
export async function importLinkedInCsv(
  _prev: LinkedInFormState,
  formData: FormData
): Promise<LinkedInFormState> {
  const file = formData.get('csv');
  const pasted = formData.get('pasted');
  const days = Number(formData.get('days') ?? 90);

  let text = '';
  if (file instanceof File && file.size > 0) text = await file.text();
  else if (typeof pasted === 'string') text = pasted;

  if (!text.trim()) {
    return { ok: false, message: 'Choose the Connections.csv file, or paste its contents.' };
  }

  try {
    const r = await importConnections(text, {
      windowDays: Number.isFinite(days) && days >= 0 ? days : 90,
    });
    revalidatePath('/linkedin');
    if (r.error) return { ok: false, message: r.error };

    const parts = [
      `${r.parsed} connections read`,
      r.added.length ? `${r.added.length} new: ${r.added.slice(0, 6).join(', ')}${r.added.length > 6 ? '…' : ''}` : 'none new',
      r.updated ? `${r.updated} refreshed` : '',
      r.linkedToJobs ? `${r.linkedToJobs} tied to a job row` : '',
      r.skippedOld ? `${r.skippedOld} older than the window and not tracked` : '',
      r.unusable.length ? `${r.unusable.length} unusable (${r.unusable[0].why})` : '',
    ].filter(Boolean);
    return { ok: r.added.length > 0 || r.updated > 0, message: parts.join(' · ') };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}
