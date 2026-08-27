import { extractEmails } from './classify';
import { isIndiaLocation } from './geo';
import type { Job } from './types';

// Strict non-tech intern filter. Word-boundary matching so "intern" never matches "internal".

// Patterns must be word-bounded. Use `\b` regex.
// Exported so lib/whatsapp/match.ts scores free-text group posts against the *same*
// spec as the job boards. Two divergent copies of "what counts as a target role" is
// exactly how the Chief-of-Staff bug survived unnoticed in two places.
export const INTERN_PATTERNS: RegExp[] = [
  /\bintern\b/i,
  /\binternship\b/i,
  /\bgraduate (program|trainee|scheme|rotational)\b/i,
  /\brotational\b/i,
  /\btrainee\b/i,
];

// At least one role keyword must appear in the TITLE. See isProductOrOps.
// Narrowed 2026-08-27 to AI/ML, data, and software-engineering roles for this profile
// (AI Engineer / Applied ML / AI Agent Ops background) — PM/growth/ops/VC patterns dropped.
export const ROLE_PATTERNS: RegExp[] = [
  // Data (2026-08-05). Deliberately NOT a bare /\bdata\b/ — that admits "Data Entry
  // Intern", which is clerical work, not analysis. ("Data Engineer" used to be excluded
  // here too; since 2026-08-07 it passes on the SWE patterns below, by design.)
  /\bdata (analyst|analytics|science|scientist|engineer)\b/i,
  /\banalytics\b/i,
  /\bbusiness intelligence\b/i,
  // AI (2026-08-05). Originally scoped to AI-adjacent NON-engineering roles (AI product,
  // AI research, AI ops) because "AI Engineer" died on the engineer hard-reject. That
  // reject is gone as of 2026-08-07, so AI/ML engineering titles now pass too.
  /\bai\b/i,
  /\bartificial intelligence\b/i,
  /\bmachine learning\b/i,
  /\bml\b/i,
  /\bgen(erative)?[\s-]?ai\b/i,
  /\bllm\b/i,
  // Forward Deployed Engineer (2026-08-27) — often abbreviated "FDE" with no "engineer"
  // spelled out in the title at all, so the generic /\bengineer(ing)?\b/ below won't
  // always catch it on its own.
  /\bfde\b/i,
  /\bforward deployed\b/i,
  // Growth Engineer (2026-08-27) — a software/AI role at growth-stage companies, not the
  // marketing-flavoured "growth" role dropped in the PM-filter narrowing above. Explicit
  // here so it still matches titles that write "Growth Eng" without the full word.
  /\bgrowth engineer(ing)?\b/i,
  /\bgrowth eng\b/i,
  // Software engineering (2026-08-07, explicit user decision: "add SWE posts also in all
  // sources, don't reject them"). Until now `engineer`/`developer` were HARD-REJECTED, so
  // every SWE posting died in the title bank regardless of source.
  //
  // The intern gate is unchanged and still applies: `isIntern` runs first, so a bare
  // "Software Engineer" does NOT pass — only "Software Engineer Intern", "SDE Graduate
  // Trainee" and friends do. SWE is now treated exactly like product/data/AI: a target
  // FUNCTION, still required to be an early-career posting. Seniority rejects below
  // (senior/staff/principal/lead/head of/director) also still apply.
  //
  // `engineer(ing)` is deliberately broad here rather than an enumeration of stacks —
  // "Engineering Intern" at a startup is a software role. Non-software disciplines are
  // excluded by discipline in HARD_REJECT_TITLE_PATTERNS instead, which is a much
  // shorter and more stable list than trying to name every software stack.
  /\bengineer(ing)?\b/i,
  /\bdeveloper\b/i,
  /\bsoftware\b/i,
  /\bsde\b/i,
  /\bprogrammer\b/i,
  /\bfront[- ]?end\b/i,
  /\bback[- ]?end\b/i,
  /\bfull[- ]?stack\b/i,
  /\bweb (developer|development)\b/i,
  /\bmobile (developer|development)\b/i,
  /\bandroid\b/i,
  /\bios\b/i,
  /\bdevops\b/i,
  /\bsre\b/i,
  /\bqa\b/i,
  /\bcyber ?security\b/i,
  /\bblockchain\b/i,
];

/**
 * WRONG DISCIPLINE. Never wanted at any level, so these reject unconditionally.
 *
 * Split from the seniority rejects below on 2026-08-18, when the user asked that senior and
 * APM postings carrying an email be kept and pitched for an internship. That request only
 * makes sense against the seniority half: a "Senior Product Manager" post is a person worth
 * writing to, a "Senior Graphic Designer" post is still the wrong discipline. One merged bank
 * is what made "too senior" and "wrong job" indistinguishable.
 */
export const DISCIPLINE_REJECT_TITLE_PATTERNS: RegExp[] = [
  // Non-software engineering disciplines. These replace the blanket `engineer|developer`
  // reject removed on 2026-08-07 when SWE became a target function: "SWE" means software,
  // so a Mechanical/Civil/Chemical Engineering Intern is still off-target. Naming the ~12
  // non-software disciplines is far more stable than enumerating every software stack.
  /\b(mechanical|civil|electrical|electronics|chemical|mining|industrial|aerospace|aeronautical|automotive|structural|petroleum|biomedical|biotech|environmental|marine|metallurg\w*|agricultur\w*)\s+engineer(ing)?\b/i,
  /\bdesigner\b/i,
  /\billustrator\b/i,
  /\bcopywriter\b/i,
  /\bcontent writer\b/i,
  /\b(sales|account)\s+(rep|representative|executive|manager)\b/i,
  /\bSDR\b/,
  /\bBDR\b/,
  /\brecruiter\b/i,
  /\btalent acquisition\b/i,
  /\baccountant\b/i,
  /\bbookkeeper\b/i,
  /\bnurse\b/i,
  /\bphysician\b/i,
  /\bdoctor\b/i,
  /\bcounselor\b/i,
  /\bcounseling\b/i,
  /\bclerk\b/i,
  /\btypist\b/i,
];

/**
 * TOO SENIOR to be an internship posting. Rejected for ordinary rows, and deliberately NOT
 * rejected on the internship-pitch path (`isPitchTarget`): the user's instruction 2026-08-18
 * was that a senior or APM post which publishes an email is a person to write to about an
 * internship, not a row to discard.
 */
export const SENIORITY_REJECT_TITLE_PATTERNS: RegExp[] = [
  /\bdirector\b/i,
  /\bchief executive\b/i,
  /\bchief operating\b/i,
  /\bchief financial\b/i,
  /\bchief marketing\b/i,
  /\bchief technology\b/i,
  /\bCEO\b/,
  /\bCOO\b/,
  /\bCFO\b/,
  /\bCMO\b/,
  /\bCTO\b/,
  /\bhead of\b/i,
  /\bvp\b/i,
  /\bvice president\b/i,
  /\bsenior\b/i,
  /\bsr\.?\s/i,
  /\bprincipal\b/i,
  // "Staff Engineer" is seniority and must go; "Chief of Staff" is a target role.
  /(?<!\bchief of )\bstaff\b/i,
  /\blead\b/i,
];

/**
 * The two banks together. Kept as one exported name because the free-text matcher and the
 * headline narrowing both test "everything that disqualifies a title", and splitting that
 * contract would put the seniority question in three places instead of one.
 */
export const HARD_REJECT_TITLE_PATTERNS: RegExp[] = [
  ...DISCIPLINE_REJECT_TITLE_PATTERNS,
  ...SENIORITY_REJECT_TITLE_PATTERNS,
];

// Description-level excludes only fire when title also includes excluded role.
// Kept short and word-bounded to avoid noise.
export const REMOTE_PATTERNS: RegExp[] = [
  /\bremote\b/i,
  /\banywhere\b/i,
  /\bworldwide\b/i,
  /\bdistributed\b/i,
  /\bglobal\b/i,
  /\bwork from home\b/i,
  /\bwfh\b/i,
];

function titleText(j: Job): string {
  return j.title;
}

function broadText(j: Job): string {
  return [j.title, j.location, j.description ?? '', ...j.tags].join(' ');
}

/**
 * Where the listing IS. Not `broadText` on purpose: the description is prose and mentions
 * cities it is not located in ("we work with teams in Bangalore and London"), and this text
 * is what admits a non-remote row.
 */
function placeText(j: Job): string {
  return [j.location, ...j.tags].join(' ');
}

// Both role signals are TITLE-anchored. Matching them against the description instead
// admits anything that merely *mentions* the words: a Video Editor whose blurb says
// "work with our growth team", a KYC Analyst listing "internship programme" in its
// boilerplate. Observed live — RemoteOK/WWR/HN produced only false positives this way.
// A posting that never names the role in its title is not the role.
export function isIntern(j: Job): boolean {
  return INTERN_PATTERNS.some((re) => re.test(titleText(j)));
}

export function isProductOrOps(j: Job): boolean {
  return ROLE_PATTERNS.some((re) => re.test(titleText(j)));
}

export function isHardRejected(j: Job): boolean {
  return HARD_REJECT_TITLE_PATTERNS.some((re) => re.test(j.title));
}

/** Wrong job entirely, at any level. The half of the reject bank the pitch path still obeys. */
export function isDisciplineRejected(j: Job): boolean {
  return DISCIPLINE_REJECT_TITLE_PATTERNS.some((re) => re.test(j.title));
}

export function isRemote(j: Job): boolean {
  return REMOTE_PATTERNS.some((re) => re.test(broadText(j)));
}

/**
 * Roles allowed through WITHOUT being remote, when they are in India.
 *
 * HISTORY, because this gate has moved twice and the reasons are not obvious:
 *  - until 2026-08-17 the remote gate was absolute;
 *  - then on-site was allowed for the PRODUCT family only (user: "allow onsite/hybrid if it
 *    is a product intern");
 *  - since 2026-08-18 it is allowed for every target function. Asked directly whether data
 *    and SWE should join, the user answered "prefer product most then strategy, growth,
 *    founder's office etc then data/sde" — which is a yes to all of them WITH an order. The
 *    order lives in lib/job-category.ts and decides queue position; it is not a gate.
 *
 * ⚠️ THE INDIA HALF IS STILL LOAD-BEARING AND IS THE ONLY THING LEFT HERE. Without it this
 * function is `true` and the remote gate is simply gone, which would fill the dashboard with
 * on-site US internships nobody here can take. `placeText`, not `broadText`: a US posting
 * whose blurb mentions "our Bangalore office" is not an Indian job.
 */
export function isOnsiteAllowed(j: Job): boolean {
  return isIndiaLocation(placeText(j));
}

/** Addresses the posting itself published, from the tags a post source stores and the body. */
export function publishedEmails(j: Job): string[] {
  return [
    ...new Set([
      ...j.tags.filter((t) => t.includes('@')).flatMap(extractEmails),
      ...extractEmails(j.description ?? ''),
    ]),
  ];
}

/**
 * Is the posting itself an INTERNSHIP, as opposed to a role this profile is early-career for?
 *
 * Deliberately narrower than `isIntern`, which also matches APM, "associate product",
 * "founder's office" and "chief of staff" — those are target ROLES for this candidate, but
 * they are full-time junior postings, not internships. The user named APM alongside senior
 * roles when asking for the pitch path ("if someone has posted for APM or senior roles and
 * have mentioned emails then pitch them for internship"), so applying to one as though it
 * were an internship listing is the wrong email.
 */
const INTERNSHIP_WORD_RE =
  /\bintern\b|\binternship\b|\binterns\b|\btrainee\b|\brotational\b/i;

export function isInternshipPosting(j: Job): boolean {
  return INTERNSHIP_WORD_RE.test(j.title);
}

/**
 * A posting that is NOT an internship, but whose poster is worth writing to about one.
 *
 * User's instruction 2026-08-18: "if someone has posted for APM or senior roles and have
 * mentioned emails then pitch them for internship." Somebody hiring a Senior Product Manager
 * is hiring for that team, and they published an address to be written to — so the row is a
 * lead rather than a miss. lib/job-outreach-template.ts renders these with the pitch copy,
 * which asks about an internship instead of applying to the advertised role.
 *
 * THE THREE CONDITIONS ARE ALL NARROW ON PURPOSE, because this admits senior postings that
 * every previous version of the filters existed to reject:
 *  0. NOT ITSELF AN INTERNSHIP (`isInternshipPosting`) — those already have a path.
 *  1. A PUBLISHED ADDRESS. The user's own condition, and it is what makes the row actionable
 *     rather than another listing. No address, no pitch — Hunter is not asked to find one.
 *  2. A TARGET FUNCTION, and no rejected discipline. "Senior Product Manager" qualifies;
 *     "Senior Graphic Designer" does not.
 *  3. REACHABLE — remote, or in India. Same rule as everything else.
 */
export function isPitchTarget(j: Job): boolean {
  if (isDisciplineRejected(j)) return false;
  // NOT `isIntern`: that matches APM and founder's office, which are exactly the full-time
  // junior postings the user asked to pitch rather than apply to.
  if (isInternshipPosting(j)) return false;
  if (!isProductOrOps(j)) return false;
  if (publishedEmails(j).length === 0) return false;
  return isRemote(j) || isIndiaLocation(placeText(j));
}

export function passes(j: Job): boolean {
  // The pitch path is checked FIRST because it deliberately survives the seniority rejects
  // that the ordinary path applies. It carries its own discipline check, so a Senior Graphic
  // Designer still dies here.
  if (isPitchTarget(j)) return true;
  if (isHardRejected(j)) return false;
  if (!isIntern(j) || !isProductOrOps(j)) return false;
  return isRemote(j) || isOnsiteAllowed(j);
}
