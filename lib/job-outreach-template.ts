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

/** Subject line. A hyphen, never an em or en dash — those are checked for and rejected. */
export function jobSubject(job: Job): string {
  return `${rolePhrase(job.title)} role at ${job.company} - Shivansh, IIT Kharagpur`;
}

/**
 * Build the application email, or null when there is nobody to greet.
 *
 * The null is the same rule the founder template follows and for the same reason: this email
 * opens "Hi <name>," and a cold application that opens "Hi there" to a person who posted a
 * role personally is worse than one that never arrives. The caller leaves the row alone
 * rather than being handed a degraded draft.
 */
export function renderJobOutreach(job: Job, contact?: JobContact | null): JobOutreach | null {
  const person = contact?.people[0]?.name;
  if (!person) return null;

  const role = rolePhrase(job.title);

  const text = [
    `Hi ${firstName(person)},`,
    '',
    `I came across your post about ${role} roles at ${job.company}, and the kind of work you described is exactly what I've been looking for.`,
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
    model: 'template:job-v1',
  };
}
