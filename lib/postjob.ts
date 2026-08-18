import { HARD_REJECT_TITLE_PATTERNS, INTERN_PATTERNS, ROLE_PATTERNS } from './filters';
import { firstIndiaCity } from './geo';

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

const REMOTE_IN_POST_RE = /\bremote\b|\bwork from home\b|\bwfh\b/i;

/**
 * Where a free-text post says it is. No location FIELD exists on a LinkedIn or Telegram
 * post, so this reads it out of the body.
 *
 * A named Indian city wins over a remote signal: "Product Intern, Bangalore, hybrid" is a
 * Bangalore job, and calling it Remote would send it through the wrong branch of `passes()`.
 * An empty string is the honest answer when the post names neither — it is also the only
 * answer that cannot satisfy `isOnsiteAllowed`, which is correct for a post that never said
 * where it is.
 *
 * ⚠️ MOVED HERE FROM lib/sources/apify-posts.ts on 2026-08-18, and it is now the ONLY
 * definition. `telegram.ts` and `apify.ts` both used to hardcode `location: 'Remote'` on the
 * reasoning that the matcher had already proved a remote signal. That reasoning expired the
 * moment the matcher started admitting on-site India product roles (lib/whatsapp/match.ts):
 * a hardcoded 'Remote' would have relabelled an on-site Bangalore role as remote, and since
 * `isRemote()` reads the location back out of the row, it would have carried EVERY on-site
 * row past the remote gate — silently turning a narrow product-only allowance into no gate
 * at all. The two facts have to come from one place.
 */
export function locationOf(content: string): string {
  const city = firstIndiaCity(content);
  if (city) return `${city}, India`;
  return REMOTE_IN_POST_RE.test(content) ? 'Remote' : '';
}
