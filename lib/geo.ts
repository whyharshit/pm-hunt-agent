/**
 * Geo-reachability for remote listings, shared by the free boards (lib/sources/boards.ts)
 * and the Firecrawl pages (lib/sources/firecrawl.ts).
 *
 * The user applies from India. Remote boards are remote-by-definition, but most rows carry
 * a geo restriction ("Europe", "USA Only", "Remote • United States") — and a geo-locked
 * posting still READS as remote, so the downstream remote gate cannot catch it. Same
 * false-positive class as YC's visa gate: drop unreachable rows at the source. Unknown or
 * empty geo is kept — only a named restriction that excludes India kills. Flip this if the
 * user ever gains work authorisation elsewhere.
 */
const REACHABLE_GEO_RE = /\b(india|worldwide|anywhere|global|international|apac|asia)\b/i;

// The ISO code for India as it appears in workatastartup locations ("Bengaluru, KA, IN").
// Case-sensitive on purpose: /\bin\b/i would match the English word "in".
const INDIA_CODE_RE = /\bIN\b/;

export function geoReachable(geo: string | undefined): boolean {
  if (!geo || !geo.trim()) return true;
  return REACHABLE_GEO_RE.test(geo) || INDIA_CODE_RE.test(geo);
}

/**
 * The cities an Indian listing actually names. LinkedIn writes "Bengaluru, Karnataka, India"
 * (which `\bindia\b` alone would catch) but also plain "Gurugram" and "Hyderabad, Telangana",
 * which it would not — and those are exactly the posts the user says they find by hand.
 *
 * Needed because the remote gate stopped being the only way in on 2026-08-17: an ON-SITE
 * product internship now passes, but only in India, so "is this in India" became a decision
 * this project has to make rather than something the WFH-only fetch guaranteed.
 */
const INDIA_CITY_RE =
  /\b(bangalore|bengaluru|mumbai|thane|delhi|ncr|gurgaon|gurugram|noida|ghaziabad|faridabad|hyderabad|secunderabad|pune|chennai|kolkata|ahmedabad|gandhinagar|jaipur|indore|bhopal|chandigarh|mohali|kochi|cochin|ernakulam|coimbatore|madurai|bhubaneswar|nagpur|surat|vadodara|lucknow|kanpur|mysore|mysuru|trivandrum|thiruvananthapuram|visakhapatnam|vizag|goa|dehradun|guwahati|patna|raipur|ludhiana|amritsar|kharagpur|udaipur|nashik|rajkot|vijayawada|tiruchirappalli|jodhpur|varanasi)\b/i;

const INDIA_RE = /\bindia\b/i;

/**
 * Is this listing located in India? Deliberately takes the LOCATION (and tags), never the
 * description: a US posting whose blurb mentions "our India office" is not an Indian job, and
 * this answer is what lets a non-remote row through the filter.
 *
 * Empty means unknown, and unknown is NOT India — the on-site allowance has to be earned by a
 * named Indian location, or every locationless scrape in the world qualifies for it.
 */
export function isIndiaLocation(text: string | undefined): boolean {
  const t = text?.trim();
  if (!t) return false;
  return INDIA_RE.test(t) || INDIA_CITY_RE.test(t) || INDIA_CODE_RE.test(t);
}

/**
 * The first Indian city named anywhere in a free-text post, title-cased for display.
 *
 * Free-text sources (LinkedIn posts, Telegram, WhatsApp) have no location FIELD, so without
 * this every one of them lands with an empty location — and an empty location cannot satisfy
 * `isOnsiteAllowed`, which means the on-site product roles this whole change exists to admit
 * would still be dropped. Reading the city out of the body is the only signal available.
 *
 * Returns null when the post names no Indian city, which is the honest answer: the caller
 * then falls back to a remote signal or to no location at all, rather than inventing one.
 */
export function firstIndiaCity(text: string | undefined): string | null {
  const m = text?.match(INDIA_CITY_RE);
  if (!m) return null;
  const city = m[0];
  return city.charAt(0).toUpperCase() + city.slice(1).toLowerCase();
}

/** "Remote (Europe)" keeps the restriction visible while still reading as remote. */
export function remoteLocation(geo: string | undefined): string {
  const g = geo?.trim();
  return g && !/^(anywhere|worldwide|remote)$/i.test(g) ? `Remote (${g})` : 'Remote';
}
