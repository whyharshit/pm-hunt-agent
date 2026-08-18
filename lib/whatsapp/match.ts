import {
  HARD_REJECT_TITLE_PATTERNS,
  INTERN_PATTERNS,
  PRODUCT_PATTERNS,
  REMOTE_PATTERNS,
  ROLE_PATTERNS,
} from '../filters';
import { extractUrls } from '../classify';
import { firstIndiaCity } from '../geo';

/**
 * Relevance matching for free-text WhatsApp group posts.
 *
 * The job-board filters are TITLE-anchored on purpose (see lib/filters.ts) — matching
 * against a whole description admits anything that merely *mentions* the words. A
 * WhatsApp post has no title field, so the naive port is to match the whole message,
 * which reintroduces exactly the bug that was fixed. Instead we reconstruct a
 * title-equivalent surface — the ROLE LINE — and anchor on that.
 *
 * The pattern banks themselves are imported from lib/filters.ts, never re-declared.
 */

/** Lines that name the role, e.g. "Role: Product Intern", "Hiring for - APM". */
const ROLE_LABEL_RE =
  /^\s*(?:role|roles|position|positions|profile|designation|job\s*title|title|opening|openings|vacancy|hiring\s*for|we\s*are\s*hiring|urgently\s*hiring|hiring)\s*[:\-–—]\s*(.+)$/i;

/** Labels whose values are never the role — keeps them out of the fallback surface. */
const NON_ROLE_LABEL_RE =
  /^\s*(?:company|organisation|organization|org|client|location|stipend|salary|ctc|package|duration|experience|exp|qualification|eligibility|batch|apply|apply\s*here|link|email|contact|deadline|last\s*date|skills?|mode|type|start\s*date)\s*[:\-–—]/i;

/** How many leading lines to treat as the headline when no role label is present. */
const HEADLINE_LINES = 3;

/** Role phrases are split on these before matching, so a bulk post listing several
 *  openings is judged per-role instead of being killed by one rejected sibling. */
const ROLE_SPLIT_RE = /\s*(?:[,/|•·]|\band\b|&)\s*/i;

const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** "DM me", "ping me", "inbox", "send your CV" — an apply route with no address. */
const DM_ASK_RE =
  /\b(dm|inbox|ping\s+me|message\s+me|whatsapp\s+me|share\s+(?:your\s+)?(?:cv|resume|profile)|send\s+(?:your\s+)?(?:cv|resume|profile)|drop\s+(?:your\s+)?(?:cv|resume))\b/i;

/** Cheap pre-gate. The bridge runs this locally so family chatter never leaves the box. */
const JOBISH_RE =
  /\b(hiring|hire|intern|internship|opening|openings|vacancy|vacancies|recruit\w*|apply|applications?\s+open|job|role|position|stipend|fresher|walk[-\s]?in|placement|opportunity|opportunities)\b/i;

export type WhatsappMatch = {
  matched: boolean;
  /** The title-equivalent surface the role signals were tested against. */
  roleLine: string;
  /** Why it failed, in evaluation order. Empty when matched. */
  reasons: string[];
  /** The role phrase that actually passed, for the dashboard/ping. */
  matchedRole?: string;
  urls: string[];
  emails: string[];
  hasDmAsk: boolean;
};

/** Strip WhatsApp markdown, emoji decoration and list bullets from a line. */
function clean(line: string): string {
  return line
    .replace(/[*_~`]/g, '')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}]/gu, ' ')
    .replace(/^[\s\-–—•·>#]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Reconstruct the title-equivalent surface. Prefers an explicit `Role:` label;
 * falls back to the first few non-empty lines, which is where WhatsApp posts put
 * the headline. Lines carrying a non-role label (Company:, Stipend:, …) are dropped
 * from the fallback so "Company: Lead Squared" can't trip the `\blead\b` reject.
 */
export function extractRoleLine(text: string): string {
  const lines = text.split(/\r?\n/).map(clean).filter(Boolean);

  const labelled = lines
    .map((l) => l.match(ROLE_LABEL_RE)?.[1]?.trim())
    .filter((v): v is string => Boolean(v));
  if (labelled.length > 0) return labelled.join(', ');

  return lines
    .filter((l) => !NON_ROLE_LABEL_RE.test(l))
    .slice(0, HEADLINE_LINES)
    .join(' · ');
}

/** Candidate role phrases: the whole surface plus each split component. */
function roleCandidates(roleLine: string): string[] {
  const parts = roleLine.split(ROLE_SPLIT_RE).map((p) => p.trim()).filter(Boolean);
  return Array.from(new Set([roleLine, ...parts]));
}

export function looksJobish(text: string): boolean {
  return JOBISH_RE.test(text);
}

export function extractEmails(text: string): string[] {
  return Array.from(new Set(text.match(EMAIL_RE) ?? [])).map((e) => e.toLowerCase());
}

/**
 * Score one group post. A post matches when at least one candidate role phrase is
 * both an intern signal and a target-function signal without being hard-rejected, and
 * the post is reachable from India — either remote, or an on-site product role in a
 * named Indian city, which is the same pair of ways in that `passes()` allows.
 */
export function matchWhatsappPost(text: string): WhatsappMatch {
  const urls = extractUrls(text);
  const emails = extractEmails(text);
  const hasDmAsk = DM_ASK_RE.test(text);
  const roleLine = extractRoleLine(text);
  const reasons: string[] = [];

  if (!roleLine) {
    return { matched: false, roleLine, reasons: ['no readable role line'], urls, emails, hasDmAsk };
  }

  const candidates = roleCandidates(roleLine);
  const viable = candidates.filter((c) => !HARD_REJECT_TITLE_PATTERNS.some((re) => re.test(c)));
  if (viable.length === 0) reasons.push('every role phrase hard-rejected');

  const isIntern = (s: string) => INTERN_PATTERNS.some((re) => re.test(s));
  const isRole = (s: string) => ROLE_PATTERNS.some((re) => re.test(s));

  // An intern signal on any viable phrase, paired with a function signal on that
  // phrase or on the surface as a whole ("Internship: Product & Strategy" splits the
  // two signals across phrases, and that is still a match).
  const surfaceHasRole = viable.some(isRole);
  const matchedRole = viable.find((c) => isIntern(c) && (isRole(c) || surfaceHasRole));

  if (viable.length > 0) {
    if (!viable.some(isIntern)) reasons.push('no intern/early-career signal in the role line');
    else if (!matchedRole) reasons.push('no product/ops/strategy signal in the role line');
  }

  // The location gate MIRRORS `passes()` — it does not re-decide the policy. Until
  // 2026-08-18 this was an absolute remote requirement, which was a verbatim copy of the
  // rule `passes()` used to enforce and STOPPED enforcing on 2026-08-17, when the user
  // asked for on-site product internships in India. The copy here was never updated, so
  // every free-text source (Telegram, LinkedIn post search, the comment miner, the
  // WhatsApp bridge) went on rejecting exactly the posts the change existed to admit —
  // and it rejected them HERE, upstream of `passes()`, so the new allowance never even
  // got asked. The same two-divergent-copies failure as the Chief-of-Staff bug.
  //
  // Measured before changing it (scripts/check-post-match.mts, 152 live Telegram posts):
  // 99 of 121 job-ish posts died on this one line, and 37 died on it ALONE with every
  // role signal already satisfied — 6 of those being product roles in a named Indian
  // city, i.e. rows `passes()` would admit today if they ever reached it.
  //
  // ⚠️ The India test is a NAMED CITY, deliberately, and not `isIndiaLocation`. The
  // sources derive `Job.location` from `firstIndiaCity` too, so admitting on exactly the
  // signal that will populate the location keeps this decision and the downstream
  // `isOnsiteAllowed` one in agreement by construction. Admitting on a bare "India" would
  // let a row through here that `passes()` then drops for having no location — and
  // `isIndiaLocation` is documented as taking a location field, never prose like this.
  const remote = REMOTE_PATTERNS.some((re) => re.test(text));
  const onsiteIndiaProduct =
    matchedRole !== undefined &&
    PRODUCT_PATTERNS.some((re) => re.test(matchedRole)) &&
    firstIndiaCity(text) !== null;
  if (!remote && !onsiteIndiaProduct) {
    reasons.push('not remote, and not an on-site product role in a named Indian city');
  }

  return {
    matched: reasons.length === 0,
    roleLine,
    reasons,
    matchedRole,
    urls,
    emails,
    hasDmAsk,
  };
}
