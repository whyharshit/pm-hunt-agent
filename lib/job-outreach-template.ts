import { firstName } from './outreach-template';
import type { Job, JobContact, JobOutreach } from './types';

/**
 * The user's own application email for JOB rows, supplied verbatim 2026-08-17, in the same
 * idiom as lib/outreach-template.ts: string interpolation, no model, nothing that can drift
 * between runs and no quota spent to write it.
 *
 * ⚠️ THE SUPPLIED TEXT NAMED TWO DIFFERENT COMPANIES — it opened "your post about Product
 * Management roles at Policybazaar" and closed "bring this mix ... to Justdial". They are
 * plainly leftovers from two separate emails the user had sent by hand, and both are the same
 * slot: the company this row is for. Sending it as written would name a competitor in the
 * closing line of every email, which is the single most damaging typo available here.
 *
 * Everything else is the user's own wording and their own figures. Do not paraphrase the
 * numbers: 85%, 2,000+, 386 and 14 are the user's claims about their own work, and the last
 * time a model was allowed near them it invented "10k+ weekly hiring signals".
 * No em dashes (standing instruction, 2026-08-08).
 */

/**
 * Who the email opens to.
 *
 * `team` exists because most postings publish `careers@` or `hr@` and nothing else, and the
 * sender refuses to put "Hi Sharad," in front of a shared inbox — that pairing is the botched
 * mail-merge this project already burned itself on. A shared HIRING inbox is not the same as
 * a shared company inbox, though: it exists to receive applications, so an email that greets
 * nobody in particular is exactly right for it. User's call, 2026-08-18.
 */
export type JobGreeting = 'person' | 'team';

/** Suffix marking a draft a human edited, so a bulk re-draft leaves it alone. */
export const EDITED_JOB_MODEL_SUFFIX = '+edited';

export function isEditedJobDraft(model: string): boolean {
  return model.endsWith(EDITED_JOB_MODEL_SUFFIX);
}

/**
 * The role as it reads inside "your post about ___ roles".
 *
 * Titles arrive as "Product Management Internship", "Data Analyst Intern", or a whole
 * sentence lifted from a LinkedIn post. The intern words are stripped because the sentence
 * supplies the noun itself: "your post about Product Management Intern roles" is clumsy where
 * "your post about Product Management roles" is what the user actually wrote.
 */
export function rolePhrase(title: string): string {
  const cleaned = title
    .replace(/\b(intern|internship|interns|internships)\b/gi, ' ')
    .replace(/[(){}\[\]|]/g, ' ')
    .replace(/\s*[-–—:,]\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  return cleaned || 'the';
}

/**
 * Is this title actually a JOB TITLE, or just the first line of a post?
 *
 * ⚠️ WRITTEN AFTER A REAL DRAFT WENT WRONG. A pasted post opened "Out of Stealth! We raised
 * ~$3.1M in seed funding, led by Sorin Investments…", the role matcher did not recognise a
 * role in it, and the first line became the title. That title then flowed into BOTH the
 * subject and the body, producing "I came across your post about Out of Stealth! We raised
 * ~$3.1M in seed funding … roles at Kily". Every part of the machinery worked; nothing
 * checked whether the string it was interpolating was a role at all.
 *
 * So the template now asks first, and writes a different, shorter sentence when the answer is
 * no. Rejects on the tells a headline has and a job title does not: length, sentence
 * punctuation, ellipsis, currency and funding words.
 */
export function looksLikeRole(title: string): boolean {
  const t = title.trim();
  if (!t || t.length > 60) return false;
  if (t.split(/\s+/).length > 8) return false;
  if (/[!?…]|\.\.\./.test(t)) return false;
  if (/[$₹€£]|\b(\d+(\.\d+)?\s*(m|k|cr|lakh|crore|mn)|seed|series [a-e]|funding|raised|stealth)\b/i.test(t)) {
    return false;
  }
  return true;
}

/**
 * Which team the closing line names. The user's text says "the product team", written while
 * they were applying to a product role — but remote SWE, data and AI rows pass the filters
 * too, and telling an engineering lead you want to learn alongside their product team reads
 * as a mail-merge that did not fit.
 *
 * A generic "the team" is the fallback, never a guess at a department that may not exist.
 */
export function teamPhrase(title: string): string {
  if (/\bproduct\b|\bapm\b/i.test(title)) return 'the product team';
  if (/\bengineer|developer|software|sde\b|\bfull[- ]?stack\b|\bfront[- ]?end\b|\bback[- ]?end\b/i.test(title)) {
    return 'the engineering team';
  }
  if (/\bdata\b|\banalytics\b|\bbusiness intelligence\b/i.test(title)) return 'the data team';
  if (/\bai\b|\bmachine learning\b|\bml\b|\bartificial intelligence\b/i.test(title)) return 'the AI team';
  return 'the team';
}

/**
 * Subject line — the user's own wording, supplied 2026-08-18.
 *
 * ⚠️ IT DELIBERATELY CARRIES NO ROLE AND NO COMPANY. The previous version was
 * `${rolePhrase} role at ${company} - Shivansh, IIT Kharagpur`, which on a post whose title
 * was not a role produced a subject line 130 characters long containing somebody's funding
 * announcement. A fixed human sentence cannot fail that way, and the user asked for exactly
 * this one. Nothing interpolated means nothing to get wrong.
 *
 * The smiley is theirs and is not a typo. No em or en dashes, per the standing rule.
 */
export function jobSubject(job: Job): string {
  const linkedIn = job.source === 'linkedin' || job.source === 'apify' || job.source === 'paste';
  return linkedIn
    ? 'Saw your LinkedIn post, Shivansh from IIT KGP :)'
    : 'Saw your post, Shivansh from IIT KGP :)';
}

/**
 * Build the application email, or null when there is nobody to greet.
 *
 * The null is the same rule the founder template follows and for the same reason: this email
 * opens "Hi <name>," and a cold application that opens "Hi there" to a person who posted a
 * role personally is worse than one that never arrives. The caller leaves the row alone
 * rather than being handed a degraded draft.
 */
export function renderJobOutreach(
  job: Job,
  contact?: JobContact | null,
  opts: { greeting?: JobGreeting } = {}
): JobOutreach | null {
  const person = contact?.people[0]?.name;
  // Defaults to 'person', so an absent contact still returns null and the "no name means no
  // draft" rule survives. A team draft has to be asked for by a caller that has checked there
  // is a hiring inbox to send it to.
  const greeting = opts.greeting ?? 'person';
  if (greeting === 'person' && !person) return null;

  // Only name the role when the title really is one. Otherwise the sentence drops the clause
  // rather than interpolating a headline into it — see looksLikeRole.
  const opener = looksLikeRole(job.title)
    ? `I came across your post about ${rolePhrase(job.title)} roles at ${job.company}, and the kind of work you described is exactly what I've been looking for.`
    : `I came across your hiring post for ${job.company}, and the kind of work you described is exactly what I've been looking for.`;

  const text = [
    greeting === 'person' ? `Hi ${firstName(person as string)},` : 'Hi team,',
    '',
    opener,
    '',
    "I'm Shivansh, a pre-final year student at IIT Kharagpur. I've worked across AI, product, growth and startups, and enjoy solving ambiguous problems and taking them from 0 to 1.",
    '',
    "A few things I've worked on:",
    '',
    '- Omnidel.ai: Built agentic AI products, including one that cut quote turnaround time by 85%.',
    '- mylynk.ai: Built AI-agent GTM systems generating 2,000+ monthly sales signals across 386 BFSI accounts.',
    '- FabTech: Shipped web products end-to-end for SMB clients, from discovery to launch and optimisation.',
    '- Lovng: Founding team member of a live-events marketplace operating across 14 cities.',
    '',
    `I'd love to bring this mix of AI, product and execution to ${job.company} and learn alongside ${teamPhrase(job.title)}.`,
    '',
    'Best,',
    'Shivansh Chaudhary',
    'IIT Kharagpur',
  ].join('\n');

  return {
    id: job.id,
    subject: jobSubject(job),
    text,
    generatedAt: new Date().toISOString(),
    // The greeting is recorded IN the model string because the sender has to know which kind
    // of draft it is holding before choosing a recipient. A "Hi team," draft may go to
    // careers@; a "Hi Sharad," draft may not.
    model:
      greeting === 'person'
        ? `template:job-${JOB_TEMPLATE_VERSION}`
        : `template:job-team-${JOB_TEMPLATE_VERSION}`,
  };
}

/** Is this draft the shared-inbox variant? Read off the model string, which is stored. */
export function isTeamDraft(model: string): boolean {
  return model.startsWith('template:job-team');
}

/**
 * Was this draft written by the CURRENT template?
 *
 * ⚠️ BUMP `JOB_TEMPLATE_VERSION` WHENEVER THE COPY CHANGES. Drafts are written once and then
 * skipped, so without a version a template fix silently applies only to rows discovered after
 * it — the already-drafted rows keep the broken copy forever and go out with it. That is not
 * hypothetical: v1 put a pasted post's opening line ("Out of Stealth! We raised ~$3.1M…")
 * into both the subject and the body, and those drafts were sitting in the queue ready to send.
 *
 * Hand-edited drafts are exempt (`isEditedJobDraft`) and sent ones are never touched, so a
 * bump re-renders exactly the untouched machine-written drafts and nothing else.
 */
export const JOB_TEMPLATE_VERSION = 'v2';

export function isCurrentJobTemplate(model: string): boolean {
  return (
    model === `template:job-${JOB_TEMPLATE_VERSION}` ||
    model === `template:job-team-${JOB_TEMPLATE_VERSION}`
  );
}
