import type { Job } from './types';

// Strict non-tech intern filter. Word-boundary matching so "intern" never matches "internal".

// Patterns must be word-bounded. Use `\b` regex.
const INTERN_PATTERNS: RegExp[] = [
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

// At least one role keyword must appear, preferably in the TITLE (we score titles higher).
const ROLE_PATTERNS: RegExp[] = [
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
];

// If a hard-reject term appears anywhere in title, kill it. (Description excludes are too noisy.)
const HARD_REJECT_TITLE_PATTERNS: RegExp[] = [
  /\b(software|frontend|backend|full[- ]?stack|mobile|ios|android|qa|test|security|platform|infrastructure|cloud|data|ml|ai|devops|sre)\s+(engineer|developer)\b/i,
  /\bengineer(ing)?\b/i,
  /\bdeveloper\b/i,
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
  /\bstaff\b/i,
  /\blead\b/i,
];

// Description-level excludes only fire when title also includes excluded role.
// Kept short and word-bounded to avoid noise.
const REMOTE_PATTERNS: RegExp[] = [
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

export function isIntern(j: Job): boolean {
  const t = titleText(j);
  const b = broadText(j);
  // Require intern signal in TITLE preferred; otherwise allow tag/description but only via exact patterns.
  return INTERN_PATTERNS.some((re) => re.test(t)) || INTERN_PATTERNS.some((re) => re.test(b));
}

export function isProductOrOps(j: Job): boolean {
  return ROLE_PATTERNS.some((re) => re.test(broadText(j)));
}

export function isHardRejected(j: Job): boolean {
  return HARD_REJECT_TITLE_PATTERNS.some((re) => re.test(j.title));
}

export function isRemote(j: Job): boolean {
  return REMOTE_PATTERNS.some((re) => re.test(broadText(j)));
}

export function passes(j: Job): boolean {
  if (isHardRejected(j)) return false;
  return isIntern(j) && isProductOrOps(j) && isRemote(j);
}
