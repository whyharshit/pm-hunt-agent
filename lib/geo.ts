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

/** "Remote (Europe)" keeps the restriction visible while still reading as remote. */
export function remoteLocation(geo: string | undefined): string {
  const g = geo?.trim();
  return g && !/^(anywhere|worldwide|remote)$/i.test(g) ? `Remote (${g})` : 'Remote';
}
