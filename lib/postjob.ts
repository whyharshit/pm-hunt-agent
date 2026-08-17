import { HARD_REJECT_TITLE_PATTERNS, INTERN_PATTERNS, ROLE_PATTERNS } from './filters';

/**
 * Shared helpers for sources whose items are FREE-TEXT POSTS rather than structured
 * listings — LinkedIn posts (lib/sources/apify.ts) and Telegram channel posts
 * (lib/sources/telegram.ts). Both reuse `matchWhatsappPost()` for relevance, and both
 * then need to turn the matched role line into a dashboard row title.
 *
 * This lives in one place on purpose. The Chief-of-Staff bug survived precisely because
 * "what counts as a target role" existed as two divergent copies; a second copy of the
 * headline narrowing would be the same mistake one layer down.
 */

/** A dashboard row needs a headline, not a paragraph. */
const MAX_TITLE_CHARS = 110;

/**
 * Tag prefix carrying the HUMAN who wrote a free-text post, e.g. `poster:Aayush Jain`.
 *
 * A post has no company field, so `Job.company` gets the author's name — which for a personal
 * LinkedIn profile is a person, not a company. Outreach needs to know the difference: it is
 * the name the email greets, and greeting a company name ("Hi Thinkingworld,") is worse than
 * not sending. Tagging it keeps that fact attached to the row instead of being re-guessed
 * later from a name that could be either.
 */
export const POSTER_TAG = 'poster:';

/** `poster:` tag for a personal author, or null for a company page (nobody to greet). */
export function posterTag(name: string | undefined, authorType: string | undefined): string | null {
  const clean = name?.trim();
  if (!clean || authorType === 'company') return null;
  return `${POSTER_TAG}${clean}`;
}

export const isInternText = (s: string) => INTERN_PATTERNS.some((re) => re.test(s));
export const isRoleText = (s: string) => ROLE_PATTERNS.some((re) => re.test(s));
export const isRejectedText = (s: string) => HARD_REJECT_TITLE_PATTERNS.some((re) => re.test(s));

/**
 * Pick a headline for the dashboard.
 *
 * `matchWhatsappPost` tests the whole reconstructed role line before its split parts, so
 * when that whole line carries both signals it is returned verbatim — which for a chatty
 * post is a three-line paragraph, useless as a row title. Narrow it back down to the
 * shortest self-sufficient fragment, then fall back through progressively looser options.
 *
 * Whatever comes out must still satisfy Discover's title-anchored `passes()`, which
 * re-tests the title alone — so a fragment is only accepted when it carries the intern
 * AND role signals by itself. Callers are expected to re-check with `titleSurvives()`.
 */
export function headline(roleLine: string, matchedRole: string): string {
  const fragments = roleLine
    .split(/\s+·\s+|(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const selfSufficient = fragments
    .filter((f) => isInternText(f) && isRoleText(f) && !isRejectedText(f))
    .sort((a, b) => a.length - b.length)[0];

  const chosen = selfSufficient ?? matchedRole;
  return chosen.length > MAX_TITLE_CHARS
    ? `${chosen.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`
    : chosen;
}

/**
 * Guard the contract with Discover: a headline that lost a signal during narrowing would
 * be silently dropped downstream by `passes()`, which would look like the source finding
 * nothing rather than the title being malformed.
 */
export function titleSurvives(title: string): boolean {
  return isInternText(title) && isRoleText(title) && !isRejectedText(title);
}
