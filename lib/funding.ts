import { Type } from '@google/genai';
import { FLASH_MODEL, GeminiQuotaError, generateContent } from './gemini';
import resumeData from '@/profile/resume.json';
import { fetchFundingNews, isUnresolvableNewsLink } from './sources/fundingnews';
import { MAX_AGE_DAYS, fetchTechCrunchFundingDetailed, type FundingRaw } from './sources/techcrunch';
import {
  getFundingSeen,
  getRecentFunding,
  markFundingSeen,
  recordAgentRun,
  saveFundingItems,
  setAgentRunning,
} from './storage';
import type { FundingContact, FundingItem, FundingOutreach } from './types';

const MODEL = FLASH_MODEL;
const MAX_OUTREACH = 320;

type ResumeShape = {
  name: string;
  summary: string;
  experience: Array<{ role: string; company: string; bullets: string[] }>;
};
const RESUME = resumeData as ResumeShape;

// ---- Extraction: raw headlines → structured { company, amount, round, summary } ----

const EXTRACT_SYSTEM = `You normalise startup funding-announcement headlines into structured records.
For each input item, return:
- company: the startup that RAISED money (not the investor/VC fund). If the item is not a company raising money (e.g. a VC fund launch, an opinion piece, an event), set company to the best available subject name.
- amount: the raise size as written (e.g. "$58M", "€75B"), or "" if none stated.
- round: the round/stage if stated (e.g. "Seed", "Series A"), else "".
- summary: one short factual sentence (≤ 160 chars) on what the company does + the raise.
Do not invent facts not present in the title or summary. Preserve input order and count exactly.`;

const extractSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      company: { type: Type.STRING },
      amount: { type: Type.STRING },
      round: { type: Type.STRING },
      summary: { type: Type.STRING },
    },
    required: ['company', 'amount', 'round', 'summary'],
    propertyOrdering: ['company', 'amount', 'round', 'summary'],
  },
};

type Extracted = { company: string; amount: string; round: string; summary: string };

/**
 * Company names for equality checks only. Strips punctuation, spacing and the legal and
 * descriptive suffixes outlets vary on, so "Smallest.ai", "Smallest AI" and "Smallest
 * Technologies" collapse. Deliberately loose: a false merge costs one missed row, a false
 * split costs a second cold email to a founder who already got one.
 */
function normaliseCompany(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(inc|llc|ltd|limited|pvt|private|corp|corporation|co|gmbh|bv|sas|plc)\b/g, '')
    .replace(/\b(technologies|technology|labs|lab|systems|solutions|software|group|holdings)\b/g, '')
    .replace(/[^a-z0-9]/g, '');
}

async function extractFunding(raws: FundingRaw[]): Promise<Extracted[]> {
  const prompt = [
    'Normalise these funding items (return one record per item, same order):',
    '',
    JSON.stringify(
      raws.map((r, i) => ({ i, title: r.title, summary: r.summary })),
      null,
      2
    ),
  ].join('\n');

  const response = await generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      systemInstruction: EXTRACT_SYSTEM,
      responseMimeType: 'application/json',
      responseSchema: extractSchema,
      temperature: 0.2,
    },
  });

  const text = response.text;
  if (!text) throw new Error('Gemini returned empty response');
  const parsed = JSON.parse(text) as unknown;
  if (!Array.isArray(parsed) || parsed.length !== raws.length) {
    throw new Error(`extraction count drift: got ${Array.isArray(parsed) ? parsed.length : 'non-array'}, expected ${raws.length}`);
  }
  return parsed as Extracted[];
}

export type FundingScanResult = {
  fetched: number;
  newCount: number;
  usedFallback: boolean;
  /** Feed-level funnel. `afterRaiseGate`/`afterAgeGate` are what expose a feed going stale. */
  afterRaiseGate: number;
  afterAgeGate: number;
  perFeed: Record<string, number>;
  feedErrors: string[];
};

/**
 * Watch new funding announcements: fetch the feed, dedupe, enrich via one
 * batched Gemini call (falls back to the raw headline if Gemini is unavailable
 * — the user asked to surface everything), persist, and report run-state.
 */
export async function runFundingScan(): Promise<FundingScanResult> {
  await setAgentRunning('funding');
  try {
    // TechCrunch and the news feeds run together; neither can take the run down.
    const [tcResult, newsResult] = await Promise.all([
      fetchTechCrunchFundingDetailed(),
      fetchFundingNews().catch((e) => ({
        items: [] as FundingRaw[],
        perSource: {},
        errors: [`fundingnews: ${(e as Error).message}`],
      })),
    ]);

    // The news feeds apply the raise gate themselves but not the age gate — Google News
    // `when:7d` already bounds them, and Serper rows have no reliable date. Apply it here
    // so one rule decides freshness for every source.
    const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
    const byId = new Map<string, FundingRaw>();
    for (const item of [...tcResult.items, ...newsResult.items]) {
      const t = Date.parse(item.postedAt);
      if (!Number.isNaN(t) && t < cutoff) continue;
      if (!byId.has(item.sourceId)) byId.set(item.sourceId, item);
    }
    const raws = [...byId.values()].sort((a, b) => Date.parse(b.postedAt) - Date.parse(a.postedAt));

    const stats = {
      ...tcResult.stats,
      perFeed: { ...tcResult.stats.perFeed, ...newsResult.perSource },
      errors: [...tcResult.stats.errors, ...newsResult.errors],
      afterAgeGate: raws.length,
    };

    const seen = await getFundingSeen();
    const fresh = raws.filter((r) => !seen.has(r.sourceId));

    let usedFallback = false;
    let extracted: Extracted[] | null = null;
    if (fresh.length > 0) {
      try {
        extracted = await extractFunding(fresh);
      } catch (e) {
        // The raw-title fallback exists so a Gemini outage still surfaces everything (the
        // user's call). But a QUOTA failure is different in kind: it is expected daily on
        // the free tier, and saving under it would permanently stamp dozens of rows with
        // the headline as the company name — `markFundingSeen` means they never get a
        // second chance at proper extraction. Better to save nothing and let the next run,
        // or another key in the pool, do it right. Nothing is lost: they stay unseen.
        if (e instanceof GeminiQuotaError || /RESOURCE_EXHAUSTED|\b429\b/i.test((e as Error).message)) {
          await recordAgentRun('funding', {
            state: 'error',
            summary: `${fresh.length} raises found but Gemini quota is spent — not saved, will retry next run`,
            error: (e as Error).message,
          });
          return {
            fetched: raws.length,
            newCount: 0,
            usedFallback: false,
            afterRaiseGate: stats.afterRaiseGate,
            afterAgeGate: stats.afterAgeGate,
            perFeed: stats.perFeed,
            feedErrors: stats.errors,
          };
        }
        usedFallback = true; // surface everything anyway, using raw titles
      }
    }

    const items: FundingItem[] = fresh.map((r, i) => {
      const e = extracted?.[i];
      return {
        id: r.sourceId,
        company: e?.company?.trim() || r.title,
        amount: e?.amount?.trim() || undefined,
        round: e?.round?.trim() || undefined,
        summary: e?.summary?.trim() || r.summary || r.title,
        url: r.url,
        source: 'techcrunch',
        postedAt: r.postedAt,
        status: 'new',
      };
    });

    // Dedupe by COMPANY against rows already in the queue, not just by URL.
    //
    // Adding Serper broke the old assumption. The same raise is now reported through two
    // sources with two different URLs — a Google News interstitial and a real publisher
    // link — so `funding:seen` (keyed on URL) treats the second as brand new. Left alone
    // that means two rows for one company, two drafts, and eventually two cold emails to
    // the same founder, which is worse than missing them entirely.
    //
    // Runs after extraction because the company name is what Gemini produces; the
    // fetch-time `storyKey` heuristic can only see headlines.
    const existingByCompany = new Map<string, FundingItem>();
    for (const i of await getRecentFunding(200)) {
      const key = normaliseCompany(i.company);
      if (key && !existingByCompany.has(key)) existingByCompany.set(key, i);
    }

    const deduped: FundingItem[] = [];
    const supersededIds: string[] = [];
    const upgraded: FundingItem[] = [];

    for (const item of items) {
      const key = normaliseCompany(item.company);
      const existing = key ? existingByCompany.get(key) : undefined;

      if (existing) {
        // Same company, already in the queue. Don't add a second row — but if the row we
        // already have points at a link no server can follow (a Google News interstitial)
        // and this one is a real publisher URL, swap the URL in. That converts a row stuck
        // without a founder name into one the contact pipeline can actually read, which is
        // the whole reason Serper was added. Status and id are preserved, so any draft,
        // 'skipped' or 'contacted' state on the row survives.
        if (isUnresolvableNewsLink(existing.url) && !isUnresolvableNewsLink(item.url)) {
          upgraded.push({ ...existing, url: item.url });
        }
        supersededIds.push(item.id);
        continue;
      }

      if (key) existingByCompany.set(key, item);
      deduped.push(item);
    }

    if (deduped.length > 0) await saveFundingItems(deduped);
    if (upgraded.length > 0) await saveFundingItems(upgraded);
    const toMark = [...deduped.map((i) => i.id), ...supersededIds];
    if (toMark.length > 0) await markFundingSeen(toMark);

    await recordAgentRun('funding', {
      state: 'ok',
      summary:
        `${stats.fetched} posts → ${stats.afterRaiseGate} raises → ${stats.afterAgeGate} fresh · ` +
        `${deduped.length} new${supersededIds.length ? ` · ${supersededIds.length} dup company` : ''}${upgraded.length ? ` · ${upgraded.length} link upgraded` : ''}${usedFallback ? ' (raw — Gemini fallback)' : ''}` +
        (stats.errors.length ? ` · feed errors: ${stats.errors.length}` : ''),
      stats: {
        fetched: stats.fetched,
        raises: stats.afterRaiseGate,
        fresh: stats.afterAgeGate,
        new: deduped.length,
        dupCompany: supersededIds.length,
        urlUpgraded: upgraded.length,
      },
      error: null,
    });

    return {
      fetched: raws.length,
      newCount: deduped.length,
      usedFallback,
      afterRaiseGate: stats.afterRaiseGate,
      afterAgeGate: stats.afterAgeGate,
      perFeed: stats.perFeed,
      feedErrors: stats.errors,
    };
  } catch (e) {
    await recordAgentRun('funding', { state: 'error', error: (e as Error).message });
    throw e;
  }
}

// ---- Per-company cold outreach draft ----

const OUTREACH_SYSTEM = `You write a short cold first-touch outreach message from a student/early-career candidate to the FOUNDER of a startup that just raised funding. The candidate is asking for an INTERNSHIP — not a full-time job.

HARD RULES:
1. Output ≤ ${MAX_OUTREACH} characters total (count every char).
2. The ask is explicitly an INTERNSHIP. The word "intern" or "internship" must appear, describing what the candidate wants NOW — never only as a description of past experience. Do not pitch the candidate as a full-time hire.
3. Infer the single best-fit early-stage internship to ask for AT THIS company from its funding/business context — e.g. founder's office / chief-of-staff intern for a fresh seed raise, ops intern for a logistics raise, product intern for a clear SaaS product. Pick one; don't hedge.
4. Open by congratulating them on the raise SPECIFICALLY — name the amount/round/what they do. Never a generic "congrats on your funding".
5. Pair it with ONE concrete credential from the candidate's resume (a real company, a quantified outcome, or a tool they shipped). Never invent.
6. End with a low-friction ask ("worth a quick chat?", "open to a 15-min intro?").
7. Plain text only — no markdown, no emojis, no "Dear", no letter formatting.
8. If a RECIPIENT is named, open with a bare first-name greeting ("Hi Maya —") before the congratulation. If no recipient is named, use no greeting at all.
9. Also write "subject": an email subject line, ≤ 60 chars, concrete and specific to this company. No clickbait, no "Job application", no exclamation marks.

Also output the internship angle you chose in the "angle" field.`;

const outreachSchema = {
  type: Type.OBJECT,
  properties: {
    text: { type: Type.STRING },
    angle: { type: Type.STRING },
    subject: { type: Type.STRING },
  },
  required: ['text', 'angle', 'subject'],
  propertyOrdering: ['angle', 'subject', 'text'],
};

export async function draftOutreach(
  item: FundingItem,
  contact?: FundingContact | null
): Promise<FundingOutreach> {

  const recipient = contact?.founders[0];
  const prompt = [
    'FUNDING CONTEXT:',
    `Company: ${item.company}`,
    item.amount ? `Amount: ${item.amount}` : null,
    item.round ? `Round: ${item.round}` : null,
    `Summary: ${item.summary}`,
    recipient ? `Recipient: ${recipient.name}${recipient.title ? ` (${recipient.title})` : ''}` : null,
    '',
    '---',
    'CANDIDATE (do not invent beyond this):',
    `Name: ${RESUME.name}`,
    `Summary: ${RESUME.summary}`,
    'Experience:',
    JSON.stringify(
      RESUME.experience.map((e) => ({ role: e.role, company: e.company, bullets: e.bullets })),
      null,
      2
    ),
    '',
    '---',
    `Write the ≤ ${MAX_OUTREACH}-char outreach message + the role angle you chose.`,
  ]
    .filter((s) => s !== null)
    .join('\n');

  // Gemini cannot reliably count its own characters, so it overshoots the cap every few
  // drafts. Throwing on the first overflow loses the whole row mid-session; telling it the
  // exact miss and asking again recovers it. Only a persistent overflow is a real failure.
  let parsed: { text: string; angle: string; subject?: string } | null = null;
  let overflow = 0;

  for (let attempt = 0; attempt < 2; attempt++) {
    const response = await generateContent({
      model: MODEL,
      contents: overflow
        ? `${prompt}\n\nYour previous attempt was ${overflow} characters — ${overflow - MAX_OUTREACH} too many. Rewrite it under ${MAX_OUTREACH} characters, keeping the congratulation, the credential and the internship ask.`
        : prompt,
      config: {
        systemInstruction: OUTREACH_SYSTEM,
        responseMimeType: 'application/json',
        responseSchema: outreachSchema,
        temperature: 0.7,
      },
    });

    const text = response.text;
    if (!text) throw new Error('Gemini returned empty response');
    const candidate = JSON.parse(text) as { text?: string; angle?: string; subject?: string };
    if (!candidate.text || !candidate.angle) throw new Error('Gemini response missing text/angle');

    if (candidate.text.length <= MAX_OUTREACH) {
      parsed = { text: candidate.text, angle: candidate.angle, subject: candidate.subject };
      break;
    }
    overflow = candidate.text.length;
  }

  if (!parsed) {
    throw new Error(`outreach too long after retry: ${overflow} > ${MAX_OUTREACH}`);
  }

  return {
    id: item.id,
    text: parsed.text,
    angle: parsed.angle,
    subject: parsed.subject?.trim() || `${item.company} — quick note`,
    generatedAt: new Date().toISOString(),
    model: MODEL,
  };
}
