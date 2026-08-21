/**
 * Reading LinkedIn's notification mail, because there is no other way to know.
 *
 * ⚠️ THERE IS NO LINKEDIN API FOR THIS. The Connections and Invitations APIs are closed to
 * third parties; a "who accepted my invitation" endpoint does not exist at any tier. The only
 * machine-readable signal LinkedIn emits is the email it sends the account owner, so this
 * project reads that — the same IMAP session the follow-up pass already uses (lib/imap.ts).
 * The alternative is scraping with a session cookie, which is against LinkedIn's terms and
 * risks the account, and is deliberately not done here.
 *
 * ⚠️ AND IT IS NOT IN THIS MAILBOX YET. Measured 2026-08-21: 120 days of INBOX and All Mail
 * contain ZERO messages from linkedin.com, so LinkedIn mails a different address. This parser
 * is therefore built and pinned but idle until those notifications are forwarded here (the
 * user's choice, 2026-08-21). Nothing breaks in the meantime: the scan finds nothing and the
 * /linkedin page runs on hand-logged invitations.
 *
 * WHAT MAKES THIS DANGEROUS, and it is the whole reason the matching is an ALLOWLIST. LinkedIn
 * sends far more "you might know this person" mail than "this person accepted", and the
 * suggestion subjects use the same vocabulary: "Add Aayush Jain to your network", "Aayush Jain
 * is on LinkedIn — connect", "invitations you may be interested in". Counting one of those as
 * an acceptance would put a stranger in the tracker as a confirmed connection and, with name
 * matching on, tie them to a job row. So: the sender must be LinkedIn, the subject must match
 * one of the acceptance phrasings exactly, and everything else is `other`.
 */

/** What a LinkedIn notification is telling us. */
export type LinkedInEventKind =
  /** They accepted an invitation WE sent. The only thing the tracker records as a connection. */
  | 'accepted'
  /** Somebody invited US. A different event, and never an acceptance. */
  | 'invite-received'
  /** A message, an InMail, a digest, a suggestion, a job alert: not a connection event. */
  | 'other';

export type LinkedInEvent = {
  kind: LinkedInEventKind;
  /** The other person, when the subject names them. */
  name?: string;
};

/**
 * Only LinkedIn's own domains. Gmail forwarding preserves the original `From`, so this still
 * holds for mail forwarded from another account — which is how it will arrive here.
 *
 * ⚠️ THE SENDER GATE IS NOT DECORATION. Without it, any email anywhere titled "X accepted your
 * invitation to connect" — a phishing mail, a newsletter quoting one, a test message — writes
 * a connection into the tracker.
 */
const LINKEDIN_SENDER_RE = /@([a-z0-9-]+\.)*linkedin\.com$/i;

export function isLinkedInSender(address: string): boolean {
  return LINKEDIN_SENDER_RE.test(address.trim().toLowerCase());
}

/**
 * The acceptance subjects, as LinkedIn has actually phrased them. Each one captures the name.
 *
 * Several phrasings because LinkedIn has changed this line repeatedly and old accounts keep
 * receiving old formats; all of them are still in the wild. A phrasing this list does not know
 * reads as `other`, which loses a connection but never invents one — the safe direction, and
 * the /linkedin page always allows logging it by hand.
 */
const ACCEPTED_PATTERNS: RegExp[] = [
  // "Aayush Jain accepted your invitation to connect"
  /^(.+?)\s+(?:has\s+)?accepted your (?:connection )?invitation\b/i,
  // "Congrats, you and Aayush Jain are now connected!" · "You and Aayush Jain are now connected"
  /\byou and\s+(.+?)\s+are now connected\b/i,
  // "Aayush Jain and you are now connected"
  /^(.+?)\s+and you are now connected\b/i,
  // "You're now connected to Aayush Jain" · "You are now connected with Aayush Jain"
  /\byou(?:'|’)?(?:re| are) now connected (?:to|with)\s+(.+?)$/i,
  // "Congratulations! You are now connected to Aayush Jain"
  /\bnow connected (?:to|with)\s+(.+?)$/i,
];

/**
 * Inbound invitations. Matched BEFORE the acceptance list is trusted, because "invitation" is
 * the shared word and an inbound invite is not something we did.
 */
const INVITE_RECEIVED_PATTERNS: RegExp[] = [
  /^(?:invitation from|invite from)\s+(.+?)$/i,
  /^(.+?)\s+(?:wants|would like) to connect\b/i,
  /^(.+?)\s+(?:has\s+)?(?:sent|invited) you (?:an invitation|to connect)\b/i,
  /\bhas invited you to connect\b/i,
];

/**
 * Subjects that must never reach the acceptance list, whatever words they share with it.
 *
 * ⚠️ EVERY ENTRY HERE IS A SUGGESTION OR A DIGEST — a person LinkedIn thinks we should know,
 * not a person who accepted anything. "Add X to your network" is one edit away from reading as
 * a connection, and it arrives weekly.
 */
const NOT_A_CONNECTION_PATTERNS: RegExp[] = [
  /\badd\b.+\bto your network\b/i,
  /\bpeople you may know\b/i,
  /\bis on linkedin\b/i,
  /\byou may (?:know|be interested)\b/i,
  /\binvitations? you may\b/i,
  /\bgrow your network\b/i,
  /\bsuggestions? for you\b/i,
  /\bviewed your profile\b/i,
  /\bappeared in\b.*\bsearches\b/i,
  /\bsent you a message\b/i,
  /\bnew message\b/i,
  /\bjobs? for you\b/i,
  /\bjob alert\b/i,
  /\bhiring\b/i,
  /\bposted\b/i,
  /\byour network (?:is growing|update)\b/i,
  /\btrending\b/i,
  /\bnewsletter\b/i,
  /\bpremium\b/i,
  /\bsecurity alert\b/i,
  /\bverify your\b/i,
];

/** Decoration LinkedIn puts around a name in a subject line. */
function cleanName(raw: string): string {
  const name = raw
    // Emoji, stars and the trailing exclamation LinkedIn likes.
    .replace(/[\p{Extended_Pictographic}☀-➿]/gu, '')
    .replace(/^[\s"'“”‘’]+|[\s"'“”‘’!.,;:]+$/g, '')
    // "Aayush Jain, Founder at Rovia" — the headline is not part of the name.
    .split(/\s+[-–—|,]\s+|,\s/)[0]
    .replace(/\s+/g, ' ')
    .trim();
  // A "name" this long is a sentence that happened to match, and a one-character one is noise.
  if (name.length < 2 || name.length > 60) return '';
  // Must contain a letter. "12345" is not somebody's name.
  if (!/\p{L}/u.test(name)) return '';
  return name;
}

/**
 * What this notification is, from its sender and subject alone.
 *
 * Envelope-only on purpose: bodies are never read. This project has one rule about the user's
 * mailbox — it reads metadata to answer yes/no questions and nothing else (see lib/imap.ts) —
 * and a subject line carries everything the tracker needs.
 */
export function parseLinkedInNotification(msg: { from: string; subject: string }): LinkedInEvent {
  if (!isLinkedInSender(msg.from)) return { kind: 'other' };
  const subject = (msg.subject ?? '').replace(/\s+/g, ' ').trim();
  if (!subject) return { kind: 'other' };

  // Rejects first. A suggestion digest can contain an acceptance-shaped clause, and the
  // ordering is what stops it being read as one.
  if (NOT_A_CONNECTION_PATTERNS.some((re) => re.test(subject))) return { kind: 'other' };

  for (const re of INVITE_RECEIVED_PATTERNS) {
    const m = re.exec(subject);
    if (m) return { kind: 'invite-received', ...(m[1] ? { name: cleanName(m[1]) } : {}) };
  }

  for (const re of ACCEPTED_PATTERNS) {
    const m = re.exec(subject);
    if (!m) continue;
    const name = cleanName(m[1] ?? '');
    // ⚠️ NO NAME, NO EVENT. A connection with nobody's name in it cannot be shown, cannot be
    // matched to a job row, and cannot be deduplicated — it would just be a mystery row that
    // reappears on every scan.
    if (!name) return { kind: 'other' };
    return { kind: 'accepted', name };
  }

  return { kind: 'other' };
}

/**
 * The key two spellings of the same person collapse to, for matching a connection against a
 * post's `poster:` tag and for keeping one row per person.
 *
 * Deliberately blunt — case, punctuation and spacing removed — because the two sides come from
 * different places: a LinkedIn subject line and a scraped post author. "Aayush  Jain",
 * "aayush jain" and "Aayush Jain." are one person.
 */
export function personKey(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '');
}

/** A stable row id, so the same person logged twice updates one row instead of making two. */
export function linkedInInviteId(name: string): string {
  return `li:${personKey(name)}`;
}
