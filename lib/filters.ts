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
  /\bapm\b/i,
  /\bassociate product\b/i,
  /\bgraduate (program|trainee|scheme|rotational)\b/i,
  /\brotational\b/i,
  /\bfounder'?s office\b/i,
  /\bchief of staff\b/i,
  /\btrainee\b/i,
];

// At least one role keyword must appear in the TITLE. See isProductOrOps.
export const ROLE_PATTERNS: RegExp[] = [
  /\bproduct\b/i,
  /\bstrategy\b/i,
  /\bstrategic\b/i,
  /\boperations?\b/i,
  /\bops\b/i,
  /\bgrowth\b/i,
  /\bfounder'?s? office\b/i,
  /\bchief of staff\b/i,
  /\bprogram manager\b/i,
  /\bbusiness analyst\b/i,
  /\bpartnerships?\b/i,
  /\bgo-?to-?market\b/i,
  /\bgtm\b/i,
  /\bbiz ops\b/i,
  /\bapm\b/i,
  // Data (2026-08-05). Deliberately NOT a bare /\bdata\b/ — that admits "Data Entry
  // Intern", which is clerical work, not analysis. ("Data Engineer" used to be excluded
  // here too; since 2026-08-07 it passes on the SWE patterns below, by design.)
  /\bdata (analyst|analytics|science|scientist|engineer)\b/i,
  /\banalytics\b/i,
  /\bbusiness intelligence\b/i,
  // VC (2026-08-05).
  /\bventure capital\b/i,
  /\bvc\b/i,
  /\bventures?\b/i,
  /\binvestment (analyst|associate|team|intern)\b/i,
  // AI (2026-08-05). Originally scoped to AI-adjacent NON-engineering roles (AI product,
  // AI research, AI ops) because "AI Engineer" died on the engineer hard-reject. That
  // reject is gone as of 2026-08-07, so AI/ML engineering titles now pass too.
  /\bai\b/i,
  /\bartificial intelligence\b/i,
  /\bmachine learning\b/i,
  /\bml\b/i,
  /\bgen(erative)?[\s-]?ai\b/i,
  /\bllm\b/i,
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

// If a hard-reject term appears anywhere in title, kill it. (Description excludes are too noisy.)
export const HARD_REJECT_TITLE_PATTERNS: RegExp[] = [
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

/**
 * Roles allowed through WITHOUT being remote, when they are in India (user's decision
 * 2026-08-17: "allow onsite/hybrid if it is a product intern"). Deliberately narrower than
 * ROLE_PATTERNS — this is the product family only, not the data/AI/SWE/VC functions, which
 * stay remote-only. Widening it is one line here, but it is the user's call, not a tidy-up.
 *
 * `founder's office` was added the same day, on the user's follow-up instruction, after a
 * single live guest-search run showed the narrow list dropping 16 on-site India rows of which
 * **11 were Founder's Office** — Zamp, Hevo Data, Snapmint, Emergent, Signzy, Z1 Tech and
 * friends. The user's own outreach template pitches them as a "generalist / founder's office"
 * candidate, so those were the best-fit listings in the batch.
 *
 * ⚠️ `chief of staff` is deliberately NOT here. It is the obvious sibling and it was not
 * asked for; one such row (ResultFlow, Bengaluru) is still dropped on-site. One line to add.
 */
export const PRODUCT_PATTERNS: RegExp[] = [
  /\bproduct\b/i,
  /\bapm\b/i,
  /\bassociate product\b/i,
  /\bfounder'?s? office\b/i,
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

export function isRemote(j: Job): boolean {
  return REMOTE_PATTERNS.some((re) => re.test(broadText(j)));
}

/** A product-family title, the only kind allowed through on-site. Title-anchored like the rest. */
export function isProductRole(j: Job): boolean {
  return PRODUCT_PATTERNS.some((re) => re.test(titleText(j)));
}

/**
 * The on-site allowance, added 2026-08-17 on the user's instruction ("allow onsite/hybrid if
 * it is a product intern").
 *
 * Until now the remote gate was absolute, and because it was pushed UPSTREAM into the fetch
 * (Internshala scraped on work-from-home pages only, every LinkedIn query carrying the word
 * "remote") it looked cheap in the funnel while quietly deciding what was even looked for.
 * The good Bangalore and Gurugram internships the user finds by hand were never fetched at
 * all, let alone filtered out.
 *
 * Both halves are load-bearing. Product-only keeps this from becoming "the remote gate is
 * gone" — data, AI, SWE and VC roles are still remote-only. India-only keeps it from becoming
 * "on-site anywhere", which would fill the dashboard with US internships nobody here can take.
 */
export function isOnsiteAllowed(j: Job): boolean {
  return isProductRole(j) && isIndiaLocation(placeText(j));
}

export function passes(j: Job): boolean {
  if (isHardRejected(j)) return false;
  if (!isIntern(j) || !isProductOrOps(j)) return false;
  return isRemote(j) || isOnsiteAllowed(j);
}
