import { companyOf } from './postjob';

/**
 * Read the poster and the company OUT OF a pasted post, so the user stops retyping what the
 * copy already carries (their ask, 2026-08-26: "the agent should pickup company name and
 * person who have posted automatically rather than me typing it").
 *
 * A post copied from LinkedIn arrives with UI furniture around it — the author's name
 * (often twice), their profile headline, "• 2nd", "2d • Edited", "Follow" — none of which
 * anybody typed on purpose. That block IS the answer to "who posted this", and the headline
 * inside it ("Talent Partner at Acme") is the same author-info string `companyOf` already
 * knows how to read on scraped posts. So the header is parsed, not discarded.
 *
 * ⚠️ THE POSTER NAME GETS GREETED IN AN EMAIL. A wrong company costs one odd sentence; a
 * wrong poster opens the mail "Hi We Are," to a stranger. Every guess here therefore needs a
 * STRUCTURAL signal (the duplicated name, or LinkedIn furniture adjacent to it) — a bare
 * capitalised first line is never enough, because most hiring posts open with one.
 *
 * ⚠️ TYPED VALUES ALWAYS WIN. The form fields stay as overrides: a human who bothered to type
 * a name has read the post, and that beats any parse. `autofillPaste` only fills blanks.
 */

/** Lines LinkedIn's UI adds around a post. None of them was written by a human. */
const FURNITURE: RegExp[] = [
  /^[•·]?\s*(?:1st|2nd|3rd\+?)\s*[•·]?$/i, // connection degree
  /^\+?\s*(?:follow|following|connect|message|more|subscribe)$/i,
  /^(?:edited|promoted)$/i,
  /^visible to anyone\b/i,
  // "2d", "3w •", "5h • Edited • Visible to anyone…". The unit must sit right against the
  // digits, or "3 openings" and "2 positions" would read as timestamps.
  /^\d+\s*(?:s|m|h|d|w|mo|yrs?|y)\s*(?:ago)?\s*(?:[•·].*)?$/i,
  /^\d+\s*(?:second|minute|hour|day|week|month|year)s?\s+ago\b/i,
];

/** "12,345 followers" — the tell that the copy came from a COMPANY page, not a person. */
const FOLLOWERS_RE = /^[\d,.]+\s*(?:k|m)?\+?\s*followers$/i;

/** "X reposted this" — the copy opens with the resharer; the real author's block follows. */
const RESHARE_RE = /\s(?:reposted|likes|loves|celebrates|supports|commented on)\s+this\.?$/i;

/**
 * Words that end a person-name reading on the spot, whatever the capitalisation. "We Are
 * Hiring" is 1–5 capitalised words and opens more posts than any human name does.
 */
const NOT_A_PERSON_WORD =
  /^(?:we|are|is|am|be|hiring|hire|urgent|urgently|job|jobs|vacancy|vacancies|opening|openings|internship|interns?|apply|applications?|looking|join|team|announcement|opportunity|opportunities|now|new|immediate|immediately|remote|wfh|onsite|hybrid|paid|unpaid|the|a|an|our|us|your|for|at|to|off|campus|drive|alert|update|linkedin|attention|great|exciting|calling|wanted|required)$/i;

/**
 * A line that could be a person's name: 1–5 capitalised words, no digits. Pronoun
 * parentheticals ("(She/Her)") and decoration are stripped first, and a `, MBA` / `| Hiring`
 * suffix is cut — LinkedIn renders those on the name line but they are not the name.
 */
export function personName(raw: string): string {
  const cleaned = raw
    .replace(/\((?:he|she|they)[^)]*\)/gi, '')
    .replace(/[,|•·].*$/, '')
    .replace(/[^\p{L}\p{M}'’.\- ]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (cleaned.length < 2 || cleaned.length > 60) return '';
  const words = cleaned.split(' ');
  if (words.length > 5) return '';
  if (words.some((w) => NOT_A_PERSON_WORD.test(w))) return '';
  if (!words.every((w) => /^[A-Z][A-Za-z'’.\-]*$/.test(w))) return '';
  return cleaned;
}

export type PastedHeader = {
  /** The human whose profile block opens the copy, '' when there is no header to read. */
  poster: string;
  /** Their profile headline ("Talent Partner at Acme"), for `companyOf`'s author-info path. */
  posterHeadline: string;
  /** Set instead of `poster` when the block is a company PAGE — the author IS the employer, and there is nobody to greet. */
  pageCompany: string;
  /** The post with the header cut off; the input untouched when no header was found. */
  body: string;
};

/** How many non-empty lines a header can span. Past this, it is just a long post. */
const WINDOW = 8;

export function readPastedPost(text: string): PastedHeader {
  const none: PastedHeader = { poster: '', posterHeadline: '', pageCompany: '', body: text };
  const lines = text.split('\n');
  const idx = lines.flatMap((l, i) => (l.trim() ? [i] : []));
  if (idx.length < 2) return none;

  // A reshare banner belongs to the resharer; the author's own block starts under it.
  let k = 0;
  if (RESHARE_RE.test(lines[idx[0]].trim())) k = 1;

  const name = personName(lines[idx[k]]?.trim() ?? '');
  if (!name) return none;

  // Walk the window collecting what provably belongs to the header. `last` only advances on
  // structural lines (duplicate name, furniture, followers) — the tentative headline never
  // moves it, which is what lets the resolution below tell a headline from the first body line.
  let last = k;
  let sawFurniture = false;
  let duplicated = false;
  let followers = false;
  let headlineLine = '';
  let headlinePos = -1;
  for (let p = k + 1; p < idx.length && p <= k + WINDOW; p++) {
    const line = lines[idx[p]].trim();
    if (personName(line) === name) {
      duplicated = true;
      last = p;
      continue;
    }
    if (FOLLOWERS_RE.test(line)) {
      followers = true;
      sawFurniture = true;
      last = p;
      continue;
    }
    if (FURNITURE.some((re) => re.test(line))) {
      sawFurniture = true;
      last = p;
      continue;
    }
    if (!headlineLine && p === last + 1) {
      headlineLine = line;
      headlinePos = p;
      continue;
    }
    break;
  }

  // The structural signal is mandatory: a capitalised first line alone is how most hiring
  // posts open, and mis-reading one costs a stranger a "Hi We Are," greeting.
  if (!duplicated && !sawFurniture) return none;

  // A tentative headline is header content only when structure follows it (case: name,
  // degree, headline, timestamp). One trailing the last structural line is the first body
  // line (case: duplicated name straight into the post), and the body must keep it.
  const headline = headlinePos !== -1 && headlinePos < last ? headlineLine : '';
  const bodyFrom = headlinePos > last ? headlinePos : last + 1;
  const body = bodyFrom < idx.length ? lines.slice(idx[bodyFrom]).join('\n').trim() : '';

  if (followers) return { poster: '', posterHeadline: '', pageCompany: name, body };
  return { poster: name, posterHeadline: headline, pageCompany: '', body };
}

export type PasteAutofill = {
  company: string;
  poster: string;
  /** True when the value came out of the post rather than the form — the result message says so, so a wrong read is caught before Send. */
  companyRead: boolean;
  posterRead: boolean;
  /** The post with any LinkedIn header stripped. Titles, locations and the stored description read THIS, or the poster's name becomes the row title. */
  body: string;
};

/**
 * Fill the company and poster blanks from the post itself. Typed values pass through
 * untouched; only an empty field is ever guessed at, and the guess is flagged as such.
 */
export function autofillPaste(input: {
  text: string;
  company?: string;
  poster?: string;
}): PasteAutofill {
  const read = readPastedPost(input.text);
  const typedPoster = input.poster?.trim() ?? '';
  const poster = typedPoster || read.poster;

  const typedCompany = input.company?.trim() ?? '';
  let company = typedCompany;
  let companyRead = false;
  if (!company) {
    // The page-company (a copy from a company page) is the one case where the author IS the
    // employer. Otherwise `companyOf` reads the post's own words, with the poster passed so
    // "Kajol is hiring" can never answer "Kajol", and the profile headline as the same
    // author-info fallback the scraped lane uses.
    company =
      read.pageCompany ||
      companyOf(read.body, {
        ...(poster ? { name: poster } : {}),
        ...(read.posterHeadline ? { info: read.posterHeadline } : {}),
      });
    companyRead = Boolean(company);
  }

  return {
    company,
    poster,
    companyRead,
    posterRead: !typedPoster && Boolean(poster),
    body: read.body,
  };
}
