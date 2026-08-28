import { categoryLabel } from './job-category';
import { isPitchTarget } from './filters';
import { firstName, SIGNATURE_LINKS } from './outreach-template';
import { employerName, isRoleText } from './postjob';
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
 * The hiring-announcement noise a post's first line opens with.
 *
 * Anchored to the START only, on purpose: the role is in the TAIL ("Hiring: Product Intern"
 * keeps "Product Intern"), and an unanchored version would eat the middle of a legitimate
 * title like "Talent Acquisition Intern".
 */
const HIRING_PREFIX_RE =
  // The `(?:is|are)` after the "we" group is not a typo of MINE: the post this was written for
  // was titled "We're is Hiring: Prompt Engineer Generative AI". Posters write what they write,
  // and a prefix stripper that only handles grammatical English leaves the ungrammatical ones
  // in the email.
  //
  // `i'm`/`i am` joined `we're` on 2026-08-26, off a real draft: "🚀 I'm hiring Product
  // Interns for my team at Vedantu!" kept its whole announcement and the email read "your
  // post about I'm hiring Product for my team roles at Vedantu". The required announcement
  // word after the pronoun is what keeps this safe — "Immediate opening" backtracks out of
  // the "Im" reading because "mediate opening" announces nothing.
  /^(?:(?:we(?:'|’)?(?:re|\s+are|\s+is)?|i(?:'|’)?m|i\s+am)\s*)?(?:\s*(?:is|are)\s+)?(?:#?\s*(?:now|urgently|immediately|currently)\s+)?(?:#?\s*hiring|job\s+(?:alert|opening|opportunit(?:y|ies))s?|(?:immediate|urgent)\s+(?:opening|requirement|vacanc(?:y|ies))s?|vacanc(?:y|ies)|looking\s+for|apply\s+now)\s*(?:for|:|-|–|—|!|\.)*\s*/i;

/**
 * Where a title stops being a role and starts being a qualifier.
 *
 * A SPACED hyphen only, so "Full-stack Developer" keeps its hyphen while "Founder's Office -
 * Growth" is cut. En and em dashes are cut wherever they appear: they are never inside a word,
 * and the standing no-dash rule (2026-08-08) means one must never reach the body anyway.
 */
/**
 * ⚠️ ` at ` IS A SEPARATOR TOO, added 2026-08-21. "Strategy & Ops Intern at District" cut to
 * "Strategy & Ops at District", and the sentence read "your post about Strategy & Ops at
 * District roles at District" - the employer welded onto the role and then named again by the
 * clause that already names it. In a job title everything after " at " is the employer, which
 * `employerName` answers separately. Spaces on both sides, so a role that merely starts with
 * those letters is untouched.
 */
// ⚠️ ` for my/our/the/your ` is a separator too, added 2026-08-26 from the same Vedantu
// draft: "Product Interns for my team" is a role plus WHOSE team it joins, and the email
// already addresses that person. Bare ` for ` is deliberately NOT cut - "Product Manager for
// fintech" would lose its domain.
const ROLE_TAIL_RE = /[|•·()\[\]{}\/,;:]|\s[-–—]\s|[–—]|\s+at\s+|\s+for\s+(?:my|our|the|your)\s+/i;

/**
 * Filler a fragment can open with once its announcement prefix is gone: "we are hiring a
 * Strategy & Ops Intern" leaves "a Strategy & Ops", and "about a Strategy & Ops roles" is not
 * a sentence anybody wrote.
 */
const LEADING_FILLER_RE = /^(?:an?|the|our|your|this|for)\s+/i;

/** One fragment of a title, stripped of everything that is not the role itself. */
function cleanFragment(fragment: string): string {
  return fragment
    // ⚠️ TRIMMED FIRST. Both prefix patterns are anchored to the start, and a fragment cut out
    // of the MIDDLE of a title arrives with the separator's whitespace still attached - so an
    // untrimmed " we are hiring a Strategy & Ops Intern" kept its announcement whole and put
    // it in the email.
    .trim()
    .replace(HIRING_PREFIX_RE, '')
    .replace(LEADING_FILLER_RE, '')
    .replace(/\b(intern|internship|interns|internships)\b/gi, ' ')
    // Trailing punctuation, `.` and `!` included. "…Gift Cards (India)." used to keep its full
    // stop and read "about Product Manager Gift Cards India . roles".
    .replace(/[\s.,;:!?\-–—]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The role as it reads inside "your post about ___ roles".
 *
 * Titles arrive as "Product Management Internship", "Data Analyst Intern", or a whole
 * sentence lifted from a LinkedIn post. The intern words are stripped because the sentence
 * supplies the noun itself: "your post about Product Management Intern roles" is clumsy where
 * "your post about Product Management roles" is what the user actually wrote.
 *
 * ⚠️ IT ALSO STRIPS THE ANNOUNCEMENT, added 2026-08-20 from a real send. A post titled
 * "We're is Hiring: Prompt Engineer Generative AI" (the poster's own typo) went out as "your
 * post about We're is Hiring: Prompt Engineer Generative AI roles" — the sentence already
 * says somebody posted about hiring, so repeating it inside the clause is both redundant and
 * a way for a stranger's typos to end up in the user's email.
 */
export function rolePhrase(title: string): string {
  const fragments = title
    // Leading emoji and rule characters sit in FRONT of the announcement, so they come off
    // first or HIRING_PREFIX_RE never gets to match.
    .replace(/^[^\p{L}\p{N}]+/u, '')
    // ⚠️ CUT AT A SEPARATOR, do not delete it. This used to strip brackets and pipes and leave
    // the fragments touching, which WELDED the qualifier onto the role: the user's own live
    // rows produced "your post about Product Management Mobile Premier League MPL US roles at
    // Mobile Premier League (MPL)" and "about Product Manager Remote Entry-Level roles".
    // Everything after a pipe, a bracket, a spaced dash, a comma or " at " is a qualifier -
    // the company, the city, the seniority, the contract type.
    .split(ROLE_TAIL_RE)
    .map(cleanFragment)
    .filter(Boolean);

  // ⚠️ THE ROLE IS NOT ALWAYS THE HEAD, and assuming it was is the bug the user reported on
  // 2026-08-21. A row titled "At District, we are hiring a Strategy & Ops Intern" - which is
  // what `titleFor` produces when the matcher reads no role and the post's FIRST LINE becomes
  // the title - has a head of "At District", so an application went out about "At District
  // roles at District". The head was a context clause; the role was two fragments later.
  //
  // So take the first fragment that actually carries a role signal, and fall back to the head
  // only when no fragment does. `isRoleText` is Discover's own definition of a target role
  // (lib/filters.ts ROLE_PATTERNS) rather than a second opinion invented here - the
  // Chief-of-Staff bug survived for exactly as long as there were two of those.
  const chosen = fragments.find(isRoleText) ?? fragments[0] ?? '';
  // '' rather than 'the'. A title that is ALL announcement ("We are hiring!") has to drop the
  // clause, not write "your post about the roles"; the callers below check for the empty string.
  return chosen;
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
  // ⚠️ THE POSITIVE TEST, added 2026-08-21, and it is the half that was missing. Every rule
  // below is a tell that a string is NOT a role - too long, sentence punctuation, currency,
  // funding words - and "At District" has none of them: two words, no punctuation, waved
  // straight through into "your post about At District roles at District". A role has to LOOK
  // LIKE a role, not merely fail to look like a headline. Same source of truth as the rest of
  // the pipeline, so a role family Discover admits is a role family this can name.
  if (!isRoleText(t)) return false;
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
  // ⚠️ VERBATIM, INCLUDING THE CASING. Supplied 2026-08-18 as "use this subject line as it
  // is": lower-case "saw", lower-case "shivansh", "linkedIn" and "Kgp" exactly as written.
  // It reads as something typed in a hurry by a person, which is the point of it, and a
  // tidy-up to sentence case would quietly undo that. The smiley is theirs too.
  return linkedIn
    ? 'saw your linkedIn post, harshit from IIT Kgp :)'
    : 'saw your post, harshit from IIT Kgp :)';
}

/**
 * The four projects plus the IIT KGP line, in the user's own words and their own figures.
 *
 * ⚠️ DO NOT PARAPHRASE THE NUMBERS. 85%, 2,000+, 386, 14, 50+, Rs 7.5L+ and 1000+ are the
 * user's claims about their own work. The founder pipeline learned this the hard way when a
 * model was allowed near them and invented "10k+ weekly hiring signals" for a project the
 * user describes as "2,000+ sales signals/month".
 *
 * ONE definition, used by BOTH the application and the pitch draft. They carried separate
 * copies for about an hour on 2026-08-18 and the pitch immediately fell behind — it shipped
 * with no bullets at all, which the user noticed as "you have dropped my experiences from it".
 * The IIT KGP line was supplied in the same message and belongs in both.
 */
const EXPERIENCE_BULLETS = [
  "A few things I've worked on:",
  '',
  '- Fitsol: Engineered an ESG intelligence pipeline predicting corporate carbon emissions across 2,000+ firms with a stacked ensemble model (log-R² 0.78).',
  '- UnoJobs: Built a filter-then-rank hiring pipeline using SQL filters, vector search, and LLM reranking, cutting average time-to-hire to 7 days across 1M+ applicants.',
  '- Omnidel.ai: Shipped an automated Fireflies-to-Trello task-extraction pipeline processing 250+ meeting transcripts at 95% recall.',
  '- Quiet: Co-founded a privacy-first AI note-taking tool for therapists and lawyers, converting early users into paid pilots.',
  "- IIT KGP: First runner-up among 2,000+ participants at IIM Lucknow's CityScape case competition; led design & media ops for Kshitij, IIT Kharagpur's flagship fest.",
];

/** The line that introduces the candidate. Shared for the same reason the bullets are. */
const INTRO =
  "I'm Harshit, a student at IIT Kharagpur. I've worked across AI/ML, data, and early-stage startups, and enjoy solving ambiguous problems and taking them from 0 to 1.";

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

  // ⚠️ TWO SLOTS, TWO SEPARATE QUESTIONS, AND EITHER CAN BE UNANSWERABLE. `role` is empty when
  // the title is a post headline rather than a job title (see looksLikeRole); `company` is
  // empty when nothing ever told us who is hiring (see employerName). Each missing answer
  // drops its own clause. Interpolating whatever happened to be in the field is precisely the
  // bug the user reported on 2026-08-20 — "roles at Fathima Sajid", the poster's own name.
  // ⚠️ THE TEST RUNS ON THE CLEANED PHRASE, NOT THE RAW TITLE. Judge the string you are about
  // to interpolate: "We're hiring: Product Manager – Prepaid Cards & Gift Cards (India)." is 66
  // characters and fails the raw test, yet its role is plainly "Product Manager" and naming it
  // is better than the degraded sentence. The junk cases still fail - a funding headline is
  // still nine words and still carries a currency symbol after the cut.
  const phrase = rolePhrase(job.title);
  const role = looksLikeRole(phrase) ? phrase : '';
  const company = employerName(job);

  const opener = role
    ? company
      ? `I came across your post about ${role} roles at ${company}, and the kind of work you described is exactly what I've been looking for.`
      : `I came across your post about ${role} roles, and the kind of work you described is exactly what I've been looking for.`
    : company
      ? `I came across your hiring post for ${company}, and the kind of work you described is exactly what I've been looking for.`
      : `I came across your hiring post, and the kind of work you described is exactly what I've been looking for.`;

  // A senior posting that published an address gets the PITCH copy instead of the application
  // copy. Applying to a Senior Product Manager opening would be the wrong email entirely; this
  // one asks the person hiring for that team whether there is an internship going.
  //
  // ⚠️ THE CONDITION IS `isPitchTarget`, NOT `!isIntern`. The looser version routed the Kily
  // row here — a real paste whose title was a funding announcement, so it named no role and no
  // seniority — and pitched "about roles at Kily" instead of falling through to the degraded
  // application sentence that case was written for. A pitch needs a recognised FUNCTION and a
  // published address, which is exactly what the user asked to pitch to.
  if (isPitchTarget(job)) {
    return renderInternshipPitch(job, greeting, person, company);
  }

  const text = [
    greeting === 'person' ? `Hi ${firstName(person as string)},` : 'Hi team,',
    '',
    opener,
    '',
    INTRO,
    '',
    ...EXPERIENCE_BULLETS,
    '',
    // Same rule as the opener: with no company to name, the sentence keeps the user's words
    // and simply stops at the team. "to  and learn alongside the engineering team" is the
    // shape of email that gets deleted on sight.
    company
      ? `I'd love to bring this mix of AI/ML and execution to ${company} and learn alongside ${teamPhrase(job.title)}.`
      : `I'd love to bring this mix of AI/ML and execution to ${teamPhrase(job.title)}.`,
    '',
    'Best,',
    'Harshit Verma',
    'IIT Kharagpur',
    ...SIGNATURE_LINKS,
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

/**
 * The internship PITCH, for a posting that is not itself an internship.
 *
 * User's instruction and wording, 2026-08-18: "if someone has posted for APM or senior roles
 * and have mentioned emails then pitch them for internship", followed by the draft to use.
 * The body below is their text, kept as they wrote it. It differs from the application copy
 * only in its opening and closing sentences: the opener says they saw a post about {category}
 * roles and are asking about a {category} internship, and the closing asks to contribute to
 * that team as an intern rather than applying to the advertised role.
 *
 * ⚠️ IT CARRIES THE FULL EXPERIENCE BULLETS. A first version shipped without them, on the
 * reasoning that a pitch asks a question rather than making a case. The user's correction was
 * immediate and explicit: "use this draft you have dropped my experiences from it". A cold
 * pitch is exactly where the evidence has to be, because there is no advertised role to
 * anchor it.
 *
 * ⚠️ THE CATEGORY IS INTERPOLATED THREE TIMES AND CAN BE EMPTY. `categoryLabel` returns '' for
 * a title that resolves to no family, and the sentences degrade to "about roles at X …
 * regarding internship opportunities … contribute to the team" rather than saying "Other
 * roles". Same rule as `looksLikeRole`: nothing invented reaches a real person's inbox.
 */
function renderInternshipPitch(
  job: Job,
  greeting: JobGreeting,
  person: string | undefined,
  // Passed in rather than re-derived, so the pitch and the application can never disagree
  // about whether the employer is known. Empty means the post never named one.
  company: string
): JobOutreach {
  const cat = categoryLabel(job.title);
  const about = cat ? `${cat} roles` : 'roles';
  const regarding = cat ? `${cat} internship opportunities` : 'internship opportunities';
  const team = cat ? `the ${cat} team` : 'the team';
  const source = job.source === 'linkedin' || job.source === 'apify' || job.source === 'paste'
    ? 'LinkedIn hiring post'
    : 'hiring post';

  const text = [
    greeting === 'person' ? `Hi ${firstName(person as string)},` : 'Hi team,',
    '',
    company
      ? `I came across your ${source} about ${about} at ${company} and wanted to reach out regarding ${regarding}.`
      : `I came across your ${source} about ${about} and wanted to reach out regarding ${regarding}.`,
    '',
    INTRO,
    '',
    ...EXPERIENCE_BULLETS,
    '',
    `I'd love to explore if there's an opportunity to contribute to ${team} as an intern.`,
    '',
    'Best,',
    'Harshit Verma',
    'IIT Kharagpur',
    ...SIGNATURE_LINKS,
  ].join('\n');

  return {
    id: job.id,
    subject: jobSubject(job),
    text,
    generatedAt: new Date().toISOString(),
    // Its own model prefix, so `isTeamDraft` still reads the greeting correctly and a pitch
    // draft is distinguishable from an application on the dashboard and in storage.
    model:
      greeting === 'person'
        ? `template:job-pitch-${JOB_TEMPLATE_VERSION}`
        : `template:job-team-pitch-${JOB_TEMPLATE_VERSION}`,
  };
}

/** Is this draft the shared-inbox variant? Read off the model string, which is stored. */
export function isTeamDraft(model: string): boolean {
  return model.startsWith('template:job-team');
}

/** Is this the pitch variant rather than an application? */
export function isPitchDraft(model: string): boolean {
  return model.includes('-pitch-');
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
// v4, 2026-08-20: the employer slot no longer accepts the poster's name, and the role slot no
// longer accepts a "We're hiring:" announcement. Every untouched v3 draft in the queue was
// written with one or both, so they MUST be re-rendered rather than sent.
//
// v5, 2026-08-21: the role slot no longer takes the head of the title on faith. A real v4 send
// opened "your post about At District roles at District" — the row's title was the post's first
// line, "At District, …", and the head of it is a context clause, not a role. Any v4 draft whose
// title opens that way is holding the same sentence right now, so they are re-rendered.
//
// v6, 2026-08-26: first-person announcements are stripped ("I'm hiring", not just "we're
// hiring") and " for my/our/the/your …" is a qualifier cut. A real v5 draft read "your post
// about I'm hiring Product for my team roles at Vedantu" — that draft, and any v5 sibling
// with a first-person title, is holding the same sentence and must be re-rendered.
export const JOB_TEMPLATE_VERSION = 'v6';

export function isCurrentJobTemplate(model: string): boolean {
  return (
    model === `template:job-${JOB_TEMPLATE_VERSION}` ||
    model === `template:job-team-${JOB_TEMPLATE_VERSION}` ||
    model === `template:job-pitch-${JOB_TEMPLATE_VERSION}` ||
    model === `template:job-team-pitch-${JOB_TEMPLATE_VERSION}`
  );
}

/**
 * Is this draft machine-written copy from an OLDER template, i.e. must it be re-rendered
 * before anyone sees it?
 *
 * ⚠️ THE `isEditedJobDraft` HALF IS NOT A REFINEMENT, IT IS THE WHOLE SAFETY PROPERTY. A
 * hand-edited draft also fails `isCurrentJobTemplate` (its model carries the `+edited` suffix,
 * which is pinned in the check script), so a stale test written as `!isCurrentJobTemplate`
 * alone would call every hand-edited draft stale and re-render it — throwing the edit away,
 * which is the one thing the edit flag exists to prevent.
 *
 * It is one function because three send-side callers and the dashboard's own "stale" badge all
 * have to agree. When they were four copies of the same two-clause expression, the badge could
 * have told the user a row was fine while the sender rewrote it on the way out.
 */
export function isStaleJobDraft(model: string): boolean {
  return !isEditedJobDraft(model) && !isCurrentJobTemplate(model);
}
