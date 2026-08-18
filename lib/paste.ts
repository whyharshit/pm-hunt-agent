import { createHash } from 'node:crypto';
import { isGenericEmail } from './contact';
import { contactFromJob, enrichJobContact, isHiringInbox } from './job-contact';
import { renderJobOutreach } from './job-outreach-template';
import { headline, locationOf, POSTER_TAG } from './postjob';
import { getJob, saveJobContact, saveJobOutreach, saveJobs } from './storage';
import { extractUrls } from './classify';
import { extractEmails, matchWhatsappPost } from './whatsapp/match';
import type { Job, JobContact } from './types';

/**
 * Paste a hiring post, get a ready-to-send application. The user's request 2026-08-17:
 * "if i see a hiring post, i paste it and if email is present in the post use it or else use
 * hunter to find email and then send the email."
 *
 * WHY THIS IS A JOB ROW AND NOT A NEW ENTITY
 * Everything downstream of "we have a post" already exists: the contact lookup, the template,
 * the sender, the follow-up sequence. Giving pasted posts their own type would mean a second
 * copy of each, and this project's recurring failure mode is exactly that — two divergent
 * definitions of one thing (the Chief-of-Staff bug, the two "sendable" checks). So a paste
 * becomes a `Job` with `source: 'paste'` and inherits the lot.
 *
 * ⚠️ THE FILTERS ARE NOT APPLIED HERE, ON PURPOSE. `passes()` exists to decide what is worth
 * looking at among thousands of scraped rows. A human who read a post and chose to paste it
 * has already made that judgement, and better: re-running the title-anchored filters would
 * reject posts whose first line is a sentence rather than a job title, which is most of them.
 *
 * ⚠️ IT SPENDS A HUNTER CREDIT when the post carries no address. That is the point of the
 * feature and the user asked for it explicitly, but the pool is ~100 a MONTH shared with
 * founder outreach, so the free path is always tried first and the result says which ran.
 */

export type PasteOutcome = {
  ok: boolean;
  message: string;
  jobId?: string;
  /** True when a Hunter search credit was spent on this paste. */
  creditSpent?: boolean;
};

/** A stable id for the same post pasted twice, so a re-paste updates rather than duplicates. */
function pasteId(text: string): string {
  return `paste:${createHash('sha1').update(text.trim()).digest('hex').slice(0, 16)}`;
}

/**
 * A headline for the row. The post matcher gives a good one when it recognises the role; a
 * post it does not recognise still needs a title, and the user's own words beat a truncation.
 */
function titleFor(text: string, roleOverride: string): string {
  const role = roleOverride.trim();
  if (role) return role.slice(0, 110);

  const m = matchWhatsappPost(text);
  if (m.matched && m.matchedRole) return headline(m.roleLine, m.matchedRole);

  const firstLine = text.split('\n').map((l) => l.trim()).find(Boolean) ?? 'Hiring post';
  return firstLine.length > 110 ? `${firstLine.slice(0, 109)}…` : firstLine;
}

export type PasteInput = {
  text: string;
  company: string;
  /** Who posted it. Without a name there is nobody to greet, so no draft can be written. */
  poster?: string;
  /** Overrides the role the matcher reads out of the post. */
  role?: string;
  /** Link to the post itself, so the dashboard row can open it. */
  url?: string;
  /** The poster's LinkedIn profile, kept for the contact database rather than for sending. */
  linkedin?: string;
  /**
   * An address typed in by hand. Recorded with `added by hand` provenance, which the sender
   * already trusts — plenty of posts put the address in an image where nothing automated can
   * read it, and that was the single most common reason a pasted row could not be mailed.
   */
  email?: string;
  /** Phone number. Stored, never used for outreach: this project only sends email. */
  phone?: string;
};

/**
 * Turn a pasted hiring post into a stored job row with a contact and a draft.
 *
 * Order is the same as the cron's, and for the same reason: an address the poster wrote into
 * their own post is free and is the one they asked to be written to, so Hunter is only
 * reached for when the post gives nothing.
 */
export async function ingestHiringPost(input: PasteInput): Promise<PasteOutcome> {
  const text = input.text.trim();
  if (!text) return { ok: false, message: 'Paste the post text first.' };

  const company = input.company.trim();
  if (!company) {
    // Not a nitpick: the company fills two slots in the email body and is the only key Hunter
    // can look a domain up by. Without it the draft would read "roles at  " and the fallback
    // lookup could not run at all.
    return { ok: false, message: 'Add the company name — the email names it twice and Hunter needs it.' };
  }

  const id = pasteId(text);
  const existing = await getJob(id);
  if (existing?.status === 'contacted') {
    return { ok: false, message: 'You have already applied to this post.', jobId: id };
  }

  // A hand-typed address joins the ones found in the post, and leads: the user typed it
  // because they read the post and know it is right, which beats anything parsed out.
  const typedEmail = input.email?.trim().toLowerCase() ?? '';
  const postedEmails = [...new Set([...(typedEmail ? [typedEmail] : []), ...extractEmails(text)])];
  const url = input.url?.trim() || extractUrls(text)[0] || '';

  const job: Job = {
    id,
    source: 'paste',
    title: titleFor(text, input.role ?? ''),
    company,
    location: locationOf(text),
    url,
    postedAt: existing?.postedAt ?? new Date(),
    // The same tag shape the LinkedIn post sources use, so `contactFromJob` reads a pasted
    // post exactly as it reads a scraped one. One parser, not two.
    tags: [input.poster?.trim() ? `${POSTER_TAG}${input.poster.trim()}` : '', ...postedEmails].filter(
      Boolean
    ),
    description: text.slice(0, 2000),
    status: 'new',
  };
  await saveJobs([job]);

  // --- free first: what the post already told us ---
  let contact: JobContact | null = contactFromJob(job);
  let creditSpent = false;
  let how = 'the post';

  // The hand-typed address is re-stamped as `added by hand`. `contactFromJob` labels
  // everything it reads as "the job post itself", which for a typed address is simply untrue,
  // and provenance is read by a human on the dashboard before anything is sent.
  if (contact && typedEmail) {
    contact = {
      ...contact,
      emails: contact.emails.map((e) =>
        e.address === typedEmail
          ? {
              ...e,
              foundOn: 'added by hand',
              ...(input.poster?.trim() ? { person: input.poster.trim() } : {}),
            }
          : e
      ),
    };
  }

  const hasPerson = contact?.emails.some((e) => e.person) ?? false;
  if (!hasPerson) {
    try {
      const outcome = await enrichJobContact(job, contact, { spend: true });
      if (outcome.contact) contact = outcome.contact;
      if (outcome.creditsSpent > 0) {
        creditSpent = true;
        how = 'Hunter';
      }
    } catch (e) {
      // A Hunter failure must not lose the row: the post's own text is already saved and the
      // user can add an address by hand.
      contact = contact ?? {
        id,
        people: [],
        emails: [],
        foundAt: new Date().toISOString(),
        model: 'post',
        note: `Hunter lookup failed: ${(e as Error).message}`,
      };
    }
  }

  // The database fields ride on the contact whether or not an email was ever found: a row with
  // only a LinkedIn profile and a phone number is still worth keeping, and it is the reason
  // this form collects them.
  const linkedin = input.linkedin?.trim();
  const phone = input.phone?.trim();
  if (linkedin || phone) {
    contact = {
      ...(contact ?? {
        id,
        people: input.poster?.trim() ? [{ name: input.poster.trim() }] : [],
        emails: [],
        foundAt: new Date().toISOString(),
        model: 'added by hand',
      }),
      ...(linkedin ? { linkedin } : {}),
      ...(phone ? { phone } : {}),
    };
  }

  if (contact) await saveJobContact(id, contact);

  // Same rule as the cron: a person to greet wins, a shared HIRING inbox gets "Hi team,",
  // anything else gets no draft. One decision, made in two places, so keep them identical.
  const greeting = contact?.emails.some((e) => e.person)
    ? 'person'
    : contact?.emails.some((e) => isHiringInbox(e.address))
      ? 'team'
      : 'person';

  const draft = renderJobOutreach(job, contact, { greeting });
  if (draft) await saveJobOutreach(id, draft);

  const personal = contact?.emails.filter((e) => !isGenericEmail(e.address)) ?? [];
  const shared = contact?.emails.filter((e) => isGenericEmail(e.address)) ?? [];

  if (!contact || contact.emails.length === 0) {
    return {
      ok: true,
      jobId: id,
      creditSpent,
      message: `Saved, but no address found${creditSpent ? ' (Hunter had nothing either)' : ''}. Add one by hand on the row.`,
    };
  }
  if (!draft) {
    return {
      ok: true,
      jobId: id,
      creditSpent,
      message: `Found ${contact.emails.length} address(es) via ${how}, but none of them is a person or a hiring inbox. Add the poster's name, or an address, on the row.`,
    };
  }
  return {
    ok: true,
    jobId: id,
    creditSpent,
    message:
      `Draft ready via ${how}: ${personal.length} personal address(es)` +
      (shared.length ? `, ${shared.length} shared inbox` : '') +
      `${creditSpent ? ' · 1 Hunter credit spent' : ' · free'}. Review it below and send.`,
  };
}
