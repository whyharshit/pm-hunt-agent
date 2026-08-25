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
 * A post has no company field. The poster's name lives HERE and only here: it is the name the
 * email greets, and greeting a company name ("Hi Thinkingworld,") is worse than not sending.
 *
 * ⚠️ IT USED TO BE COPIED INTO `Job.company` AS WELL, and that was the bug the user reported
 * on 2026-08-20. The template interpolates `Job.company` into "your post about X roles at ___"
 * and "bring this mix … to ___", so a recruiter called Fathima Sajid received an application
 * about "Prompt Engineer roles at Fathima Sajid" that closed by offering to bring the sender's
 * experience "to Fathima Sajid". Every layer worked as written; the field simply held the
 * wrong kind of name, and nothing downstream could tell.
 *
 * The employer now comes from `companyOf()` and is EMPTY when the post never named one. See
 * `employerName()` for the read side, which also disbelieves rows already stored the old way.
 */
export const POSTER_TAG = 'poster:';

/** `poster:` tag for a personal author, or null for a company page (nobody to greet). */
export function posterTag(name: string | undefined, authorType: string | undefined): string | null {
  const clean = name?.trim();
  if (!clean || authorType === 'company') return null;
  return `${POSTER_TAG}${clean}`;
}

/** The poster's name off a stored row, or '' — the same tag, read back. */
export function posterName(tags: string[]): string {
  const tag = tags.find((t) => t.startsWith(POSTER_TAG));
  return tag ? tag.slice(POSTER_TAG.length).trim() : '';
}

/**
 * Words that are never an employer name, whatever the sentence around them looked like.
 *
 * `us`/`we`/`our team` catch the commonest false positive by far ("we are hiring at our
 * Bangalore office"), and the agency words catch the case where the name IS a company but is
 * not the one doing the hiring: a staffing firm posts on behalf of a client it does not name,
 * so "roles at Sharma Manpower Solutions" is a different wrong answer to the same question.
 */
const NOT_AN_EMPLOYER =
  /^(us|we|our|my|the|this|a|an|your|their|india|remote|home|office|scale|speed|pace|present|least|most|all|any|it|work|team|teams|company|startup|startups|client|clients|multiple|various|leading|top|reputed|mnc|mncs|immediate|urgent|group|groups|channel|channels|community|whatsapp|telegram|discord|linkedin|facebook|instagram|hands)$/i;

const AGENCY_TELLS =
  /\b(consultanc|consulting|staffing|recruit|placement|manpower|hr\s*solutions|talent\s*solutions|hiring\s*solutions|services\s*(?:pvt|private)|job\s*portal|jobs?)\b/i;

/** Location words that turn "hiring at Bangalore" into a false company. */
const LOCATION_TELL =
  /\b(bangalore|bengaluru|mumbai|delhi|noida|gurgaon|gurugram|pune|hyderabad|chennai|kolkata|ahmedabad|jaipur|indore|india|remote|onsite|hybrid|office|hq|headquarters)\b/i;

/**
 * Is this fragment usable as "roles at ___" in a real email?
 *
 * Deliberately strict, and the asymmetry is the point: rejecting a good name costs one dropped
 * clause in one sentence, while accepting a bad one puts a stranger's name, or a competitor's,
 * in front of the person being asked for a job.
 */
function usableEmployer(raw: string): string {
  const name = raw
    .replace(/[|•·–—]+.*$/, '')
    .replace(/[,.!?;:]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (name.length < 2 || name.length > 60) return '';
  const words = name.split(' ');
  if (words.length > 5) return '';
  // Contractions are stripped before the word is judged, because the pronoun is the half that
  // matters. "We're is Hiring: Prompt Engineer" (a real post title, typo and all) matched the
  // "X is hiring" reading and offered **We're** as the company — a plausible-looking capitalised
  // word that would have been mailed as the employer, which is this bug all over again.
  if (words.some((w) => NOT_AN_EMPLOYER.test(w.replace(/['’](?:re|s|ll|ve|m|d)$/i, '')))) return '';
  if (AGENCY_TELLS.test(name) || LOCATION_TELL.test(name)) return '';
  // A name lifted out of running prose has to look like a proper noun, or the pattern matched
  // the wrong half of the sentence ("hiring at scale", "join us in building").
  if (!/^[A-Z0-9]/.test(name)) return '';
  if (!words.every((w) => /^[A-Z0-9][\w&''.\-+]*$/.test(w) || /^(of|and|the|for|by|in)$/i.test(w))) {
    return '';
  }
  return name;
}

/**
 * Ways a hiring post names its own employer, most explicit first.
 *
 * Every one of these is something the poster WROTE. Nothing here derives a name from an email
 * domain, and that omission is deliberate: `hr@aikyamjobs.org` on a The/Nudge Institute
 * posting would yield "Aikyamjobs", the job PLATFORM rather than the employer, which is the
 * exact mistake that already sent one application to the wrong company (see
 * scripts/check-job-outreach.mts). A domain is good enough to look a contact up by and not
 * good enough to name in a sentence.
 */
const COMPANY_LEAD_INS: RegExp[] = [
  /(?:^|\n)[ \t]*(?:company|organisation|organization|employer|firm|brand)[ \t]*[:\-][ \t]*/i,
  // The 📍/🏢 label line — "📍 Vedantu | Bangalore | WFO" (a real paste, 2026-08-26). Posts
  // use the pin for the location at least as often, and those die on LOCATION_TELL.
  /(?:^|\n)[ \t]*(?:📍|🏢)[ \t]*/u,
  // `(?:my|our|the)\s+team\s+at` — "I'm hiring Product Interns for my team at Vedantu!" (the
  // same paste) names the employer only there and in the 📍 line. "team at the Bangalore
  // office" is safe: the run needs a capital, and the location words are rejected anyway.
  /\b(?:we(?:'|’)?re\s+hiring\s+at|we\s+are\s+hiring\s+at|hiring\s+at|opening\s+at|role\s+at|position\s+at|internship\s+at|opportunity\s+at|join\s+us\s+at|join\s+our\s+team\s+at|(?:my|our|the)\s+team\s+at)\s+/i,
  // "Then come Join Psyliq." — a real paste (2026-08-26) that named its employer nowhere
  // else, and the reader answered "type the company". The direct object of "join" is the
  // company; the loose cases all die downstream — "Join us"/"Join our team" on the pronoun
  // guard, "Join WhatsApp Group" on the platform words, "join hands" on the lowercase run.
  /\b(?:come\s+(?:and\s+)?)?join\s+/i,
];

/** "X is hiring", "X is looking for" — the name sits BEFORE the keyword, so it is read backwards. */
const COMPANY_TRAILERS: RegExp[] = [
  /\s+is\s+(?:hiring|looking\s+for|expanding|growing)/i,
  /\s*,?\s+we(?:'|’)?(?:re|\s+are)\s+(?:hiring|looking|growing|expanding)/i,
];

/**
 * A company name's SHAPE: a run of capitalised words, at most five.
 *
 * ⚠️ CASE-SENSITIVE, AND THAT IS LOAD-BEARING. The first version of this lived inside
 * case-insensitive patterns, where `[A-Z]` matches lowercase too — so "hiring at Zynetic for a
 * product intern" captured all five words, failed the sanity filter, and the whole extractor
 * silently returned nothing. Requiring real capitals is also what makes the run STOP at the
 * first ordinary word, which is exactly where a company name ends.
 */
// `[ \t]` and not `\s`: a name run must not step over a line break. "Company: Zynetic\nRole:
// Product Intern" is a two-field label block, and `\s` read it as the four-word company
// "Zynetic Role Product Intern".
const NAME_RUN_START = /^[A-Z][\w&'’.\-+]*(?:[ \t]+[A-Z0-9][\w&'’.\-+]*){0,4}/;
const NAME_RUN_END = /[A-Z][\w&'’.\-+]*(?:[ \t]+[A-Z0-9][\w&'’.\-+]*){0,4}$/;

/**
 * WHO IS HIRING, read out of a free-text post. `''` when the post never said.
 *
 * ONE definition, used by both LinkedIn post sources, by rule: "what counts as a target role"
 * survived as two divergent copies once (the Chief-of-Staff bug) and a second copy of this
 * would be the same mistake with worse consequences, since this string is interpolated into a
 * sentence a stranger reads.
 *
 * ⚠️ `''` IS A CORRECT ANSWER AND THE COMMON ONE. Most recruiter posts describe the role, the
 * stipend and where to send a CV without ever naming the company. The template drops the
 * clause rather than filling it, exactly as it already does for a title that is not a role;
 * the alternative is what shipped before, which was to name the person who posted.
 */
export function companyOf(
  content: string,
  author?: { name?: string; info?: string; type?: string }
): string {
  // A LinkedIn COMPANY PAGE is the one author whose name really is the employer. `posterTag`
  // reads the same field to decide there is nobody to greet, so the two agree by construction.
  if (author?.type === 'company') {
    const name = author.name?.trim() ?? '';
    if (name) return name;
  }

  // Never the poster: a post that opens "Fathima Sajid is hiring" matches a trailer below, and
  // the whole point of this function is that that answer is the wrong one.
  const poster = author?.name?.trim().toLowerCase() ?? '';
  const notThePoster = (name: string) => Boolean(name) && name.toLowerCase() !== poster;

  // ⚠️ EVERY occurrence of a pattern is tried, not just the first. The Psyliq post
  // (2026-08-26) opens "join our Live world data internship" and only later says "come Join
  // Psyliq" — a first-match-only loop tested the pronoun, got nothing usable, and never
  // reached the occurrence that carried the answer. Each candidate still has to survive
  // usableEmployer, so trying more of them admits nothing looser.
  for (const lead of COMPANY_LEAD_INS) {
    for (const m of content.matchAll(new RegExp(lead.source, 'gi'))) {
      const after = content.slice(m.index + m[0].length);
      const found = usableEmployer(NAME_RUN_START.exec(after)?.[0] ?? '');
      if (notThePoster(found)) return found;
    }
  }

  for (const trailer of COMPANY_TRAILERS) {
    for (const m of content.matchAll(new RegExp(trailer.source, 'gi'))) {
      // Only the line the keyword is on, so a name run cannot reach back across a newline
      // into the previous sentence.
      const before = content.slice(0, m.index).split('\n').at(-1) ?? '';
      const found = usableEmployer(NAME_RUN_END.exec(before)?.[0] ?? '');
      if (notThePoster(found)) return found;
    }
  }

  // Last: the recruiter's own headline, "Talent Acquisition at Acme Labs". It is a guess about
  // whose behalf they post on, so it runs only after the post's own words and is held to the
  // same agency/location filters.
  // `@` takes OPTIONAL space: LinkedIn headlines write "AI Product@Vedantu" as one word (a
  // real paste, 2026-08-26), and requiring whitespace read that headline as naming nothing.
  // An email address in a headline stays safe — its domain is lowercase and fails the run.
  const info = author?.info?.split(/[|•·]/)[0] ?? '';
  const at = /(?:\bat\b\s+|@[ \t]*)/i.exec(info);
  const fromHeadline = at
    ? usableEmployer(NAME_RUN_START.exec(info.slice(at.index + at[0].length))?.[0] ?? '')
    : '';
  if (notThePoster(fromHeadline)) return fromHeadline;

  return '';
}

/**
 * The employer name a stored row can be TRUSTED with, or '' — the read side of `companyOf`.
 *
 * Rows written before 2026-08-20 carry a person's name in `company`, and they are still in
 * storage with drafts and follow-up sequences attached. A version bump re-renders the drafts,
 * but only this check stops the re-render putting the same person's name back. It also
 * disbelieves the two placeholders the sources have always written: apify's literal
 * 'Unknown', and telegram's `via t.me/<channel>`, which is an aggregator rather than an
 * employer and would have read "roles at via t.me/jobs_india".
 */
export function employerName(job: {
  company: string;
  tags: string[];
  description?: string;
}): string {
  const name = job.company.trim();
  const poster = posterName(job.tags);
  const untrusted =
    !name ||
    /^unknown$/i.test(name) ||
    /^via\s+t\.me\//i.test(name) ||
    (poster !== '' && name.toLowerCase() === poster.toLowerCase());

  if (!untrusted) return name;

  // A row written the old way still carries the post itself in `description`, so the employer
  // can often be RECOVERED rather than merely dropped — the same reading `companyOf` does at
  // discovery time, on the same text. Worth doing: it turns "your post about Prompt Engineer
  // roles" back into "…roles at Zynetic" for rows already sitting in the queue. The author is
  // passed by name only, so the recruiter-headline guess never applies here; only what the
  // post itself said counts.
  return job.description ? companyOf(job.description, { name: poster }) : '';
}

/**
 * What a dashboard row and a send report show where the company goes.
 *
 * Distinct from `employerName` because the two answers have different jobs: an email must say
 * nothing rather than something wrong, while a human reading the queue needs the row to be
 * identifiable. "posted by Fathima Sajid" is the truth about such a row and is never mailed.
 */
export function companyLabel(job: { company: string; tags: string[] }): string {
  const employer = employerName(job);
  if (employer) return employer;
  const poster = posterName(job.tags);
  return poster ? `posted by ${poster}` : 'company not named';
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
