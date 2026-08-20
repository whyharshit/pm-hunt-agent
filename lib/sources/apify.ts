import { classifyUrl } from '../classify';
import { apifyRequireContact, apifyTokens, isTokenExhausted } from './apify-posts';
import { companyOf, headline, locationOf, posterTag, titleSurvives } from '../postjob';
import { matchWhatsappPost } from '../whatsapp/match';
import type { Job } from '../types';

// LinkedIn recruiter posts, mined indirectly through job-aggregator COMMENT feeds.
//
// The idea (the user's): the big Indian job aggregators run paid dashboards, but they
// find their listings by commenting "added to our dashboard" on recruiters' ORIGINAL
// posts. Scraping an aggregator's comment feed therefore surfaces the original posts —
// the same leads, at the source, for free.
//
// Actor: harvestapi/linkedin-profile-comments. Chosen specifically because it needs NO
// cookies and no LinkedIn account — cookie-based actors put the account whose cookies
// they use at risk, and the standing no-AIHawk / no-account-risk rule still holds. We
// never authenticate to LinkedIn; we read public pages through Apify.
//
// Requires BOTH env vars. Missing either returns [] silently — an unset optional source
// must not put a daily error on the agent card.
//   APIFY_TOKENS              — apify.com API tokens, pooled (`APIFY_TOKEN` still works)
//   APIFY_LINKEDIN_PROFILES   — comma-separated aggregator profile URLs
//   APIFY_MINE_COMMENTS       — the switch that runs this at all; see lib/discover.ts
//
// This is the FIFTH scraper of the set the user asked for on 2026-08-18 (product, founder's
// office/strategy, data, SWE, and this one). The other four are role-family lanes over post
// SEARCH in lib/sources/apify-posts.ts; this one reaches posts a search never surfaces,
// which is why it earns a slot rather than being folded in.
const ACTOR = 'harvestapi~linkedin-profile-comments';
const ENDPOINT = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items`;

// Cost control, and it is tight. The actor bills $0.002 per comment and the free plan
// carries $5/month, so the daily cron costs `profiles × MAX_ITEMS × $0.06` per month:
// 4 profiles × 15 = $3.60/month, which fits. At 20 it would be $4.80 — inside the plan
// on paper, but with no headroom for a re-run or a fifth profile. Raise only alongside
// the plan, and check here first if Apify credit runs out unexpectedly.
const MAX_ITEMS_PER_PROFILE = 15;

// The Discover cron runs on Vercel Hobby, where a function is killed at 60s. A sync
// Apify run that hangs would take the whole cron down with it, so it is bounded well
// short of that; safe() in runDiscovery turns a timeout into one line in the summary.
const RUN_TIMEOUT_MS = 45_000;

type ApifyComment = {
  createdAt?: string;
  post?: {
    linkedinUrl?: string;
    content?: string;
    author?: { name?: string; info?: string; linkedinUrl?: string };
  };
};

function profiles(): string[] {
  return (process.env.APIFY_LINKEDIN_PROFILES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Mine aggregator comment feeds for the recruiter posts underneath. [] when unconfigured. */
export async function fetchLinkedInPostsViaApify(): Promise<Job[]> {
  const tokens = apifyTokens();
  const profileUrls = profiles();
  if (tokens.length === 0 || profileUrls.length === 0) return [];

  // Starts on the LAST account, so with several configured the comment miner does not bill the
  // same one as the product lane, then walks backwards through the pool on exhaustion. Same
  // reasoning as the post lanes: $5 is per account, so an unusable balance elsewhere in the
  // pool is real money left unspent.
  let res: Response | null = null;
  let lastError = '';
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[(tokens.length - 1 - i + tokens.length) % tokens.length];
    const attempt = await fetch(`${ENDPOINT}?token=${encodeURIComponent(token)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ profiles: profileUrls, maxItems: MAX_ITEMS_PER_PROFILE }),
      signal: AbortSignal.timeout(RUN_TIMEOUT_MS),
      next: { revalidate: 0 },
    });
    if (attempt.ok) {
      res = attempt;
      break;
    }
    const body = (await attempt.text()).slice(0, 200);
    lastError = `apify ${attempt.status}: ${body}`;
    if (!isTokenExhausted(attempt.status, body)) throw new Error(lastError);
  }
  if (!res) throw new Error(`every apify token exhausted or refused · ${lastError}`);

  const items = (await res.json()) as ApifyComment[];
  if (!Array.isArray(items)) throw new Error('apify returned a non-array dataset');

  const jobs: Job[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const post = item.post;
    const content = post?.content?.trim();
    const url = post?.linkedinUrl;
    if (!content || !url) continue;

    // A LinkedIn post has no title field, exactly like a WhatsApp group post — so it
    // goes through the same matcher rather than a second, divergent copy of "what
    // counts as a target role". That shared-bank discipline is what kept the
    // Chief-of-Staff bug from surviving in two places.
    const m = matchWhatsappPost(content);
    if (!m.matched || !m.matchedRole) continue;

    const id = `apify:${url.match(/activity[:-](\d+)/)?.[1] ?? url}`;
    if (seen.has(id)) continue; // several aggregators comment on the same post
    seen.add(id);

    const title = headline(m.roleLine, m.matchedRole);
    if (!titleSurvives(title)) continue;

    // Same "a direct way to apply, or it is not worth the money" rule as the post lanes.
    // A mined comment is billed exactly like a bought post, so the economics are identical.
    const forms = m.urls.filter((u) => classifyUrl(u) !== 'red');
    if (apifyRequireContact() && m.emails.length === 0 && forms.length === 0) continue;

    const applyUrl = forms[0] ?? m.urls[0];
    jobs.push({
      id,
      source: 'apify',
      title,
      // WHO IS HIRING, read out of the post — NOT the author's name, which until 2026-08-20
      // was copied here and mailed as the employer. See companyOf() in lib/postjob.ts.
      company: companyOf(content, post?.author),
      // Read out of the post body, not hardcoded 'Remote' — see locationOf() in
      // lib/postjob.ts for why that assertion stopped being true on 2026-08-18.
      location: locationOf(content),
      url,
      ...(applyUrl ? { applyUrl } : {}),
      postedAt: item.createdAt ? new Date(item.createdAt) : new Date(),
      // The poster's name rides in a tag, and ONLY in the tag: it is who the draft greets, and
      // `company` is who the draft names as the employer. Two different questions.
      tags: [
        posterTag(post?.author?.name, undefined),
        post?.author?.info,
        'lane:comments',
        ...m.emails,
      ].filter((t): t is string => Boolean(t)),
      description: content.slice(0, 600),
    });
  }

  return jobs;
}
