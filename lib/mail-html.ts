/**
 * Bold the metrics and the labels in an outreach email.
 *
 * User's instruction 2026-08-09: "make the keywords and numbers in bold". That needs HTML,
 * so outreach now goes out as multipart: this HTML part plus the existing plain text as the
 * fallback. Sending HTML is not a step away from looking genuine — Gmail's own compose box
 * produces HTML with bold, so a plain-text-only message is the more unusual of the two. The
 * markup is kept to `<strong>` and `<br>` with no styling, no images and no tracking, which
 * is roughly what a person typing in Gmail actually sends.
 *
 * WHY DERIVED, NOT STORED. The draft's `text` stays the single source of truth. The
 * dashboard editor, "edited by hand", the copy button and the sent-draft record all keep
 * working untouched, and a hand-edited email gets its numbers bolded for free. Storing a
 * second HTML field would mean two representations that drift the moment anyone edits one.
 */

/** Matches the things worth emphasising, in ONE pass so matches can never overlap. */
const BOLD = new RegExp(
  [
    // Bullet labels: only when followed by a colon, so "Startup" in ordinary prose is safe.
    // Listed first so their digits ("0 to 1 Products") cannot be claimed by a number rule.
    '(?:AI & Product|GTM|0 to 1 Products|Startup|Execution)(?=:)',
    // The places he has actually worked, named in the bullets. All of them, or the one that
    // is left plain reads like an afterthought next to its bolded neighbours.
    'Omnidel\\.ai|mylynk\\.ai|Lovng|IIT Kharagpur',
    // Money, including the Indian forms the funding line produces: ₹7.5L+, Rs 65 Cr, $12M.
    '(?:₹|\\$|£|€|Rs\\.?\\s?)\\s?\\d[\\d,.]*\\s?(?:Cr|crore|L|lakh|K|M|B|bn|mn)?\\+?',
    // Counts carrying a "+": 2,000+, 1,000+, 10k+.
    '\\d[\\d,]*(?:\\.\\d+)?\\s?(?:k|m|bn|mn)?\\+',
    // Percentages.
    '\\d+(?:\\.\\d+)?%',
    // Durations, which is where the concrete before/after claims live: 2 hours, 15 minutes.
    '\\d+(?:\\.\\d+)?[-\\s](?:hours?|hrs?|minutes?|mins?|days?|weeks?|months?|years?)\\b',
    // Bare counts. Two digits, so "14 cities" is emphasised like every other figure in the
    // bullets; single digits stay plain, which is what keeps "4th-year" and "0 to 1" clean.
    '\\d{2,}',
  ].join('|'),
  'g'
);

export type Segment = { text: string; bold: boolean };

/**
 * Split text into bold and plain runs. Shared by the HTML builder and the dashboard, so what
 * a founder received and what the dashboard shows can never disagree about the emphasis.
 */
export function boldSegments(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(BOLD)) {
    const start = m.index;
    const end = start + m[0].length;
    // A match that occupies a whole line by itself is a signature or a heading, not
    // emphasis. Without this the "IIT Kharagpur" under "Best, Shivansh" comes out bold,
    // which reads like a letterhead rather than someone signing off.
    const ownsTheLine =
      (start === 0 || text[start - 1] === '\n') && (end === text.length || text[end] === '\n');
    if (ownsTheLine) continue;

    if (start > last) out.push({ text: text.slice(last, start), bold: false });
    out.push({ text: m[0], bold: true });
    last = end;
  }
  if (last < text.length) out.push({ text: text.slice(last), bold: false });
  return out;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * The HTML part of an outreach email. Escaping happens per segment and the tags are added
 * after, so a "<" in the body can never become markup.
 */
export function toHtml(text: string): string {
  const inner = boldSegments(text)
    .map((s) => (s.bold ? `<strong>${escapeHtml(s.text)}</strong>` : escapeHtml(s.text)))
    .join('')
    .replace(/\n/g, '<br>');
  return `<div>${inner}</div>`;
}
