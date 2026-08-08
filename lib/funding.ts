import { GoogleGenAI, Type } from '@google/genai';
import resumeData from '@/profile/resume.json';
import { fetchTechCrunchFundingDetailed, type FundingRaw } from './sources/techcrunch';
import {
  getFundingSeen,
  markFundingSeen,
  recordAgentRun,
  saveFundingItems,
  setAgentRunning,
} from './storage';
import type { FundingContact, FundingItem, FundingOutreach } from './types';

const MODEL = 'gemini-2.5-flash';
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

async function extractFunding(raws: FundingRaw[]): Promise<Extracted[]> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const ai = new GoogleGenAI({ apiKey });
  const prompt = [
    'Normalise these funding items (return one record per item, same order):',
    '',
    JSON.stringify(
      raws.map((r, i) => ({ i, title: r.title, summary: r.summary })),
      null,
      2
    ),
  ].join('\n');

  const response = await ai.models.generateContent({
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
    const { items: raws, stats } = await fetchTechCrunchFundingDetailed();
    const seen = await getFundingSeen();
    const fresh = raws.filter((r) => !seen.has(r.sourceId));

    let usedFallback = false;
    let extracted: Extracted[] | null = null;
    if (fresh.length > 0) {
      try {
        extracted = await extractFunding(fresh);
      } catch {
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

    if (items.length > 0) {
      await saveFundingItems(items);
      await markFundingSeen(items.map((i) => i.id));
    }

    await recordAgentRun('funding', {
      state: 'ok',
      summary:
        `${stats.fetched} posts → ${stats.afterRaiseGate} raises → ${stats.afterAgeGate} fresh · ` +
        `${items.length} new${usedFallback ? ' (raw — Gemini fallback)' : ''}` +
        (stats.errors.length ? ` · feed errors: ${stats.errors.length}` : ''),
      stats: {
        fetched: stats.fetched,
        raises: stats.afterRaiseGate,
        fresh: stats.afterAgeGate,
        new: items.length,
      },
      error: null,
    });

    return {
      fetched: raws.length,
      newCount: items.length,
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
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const recipient = contact?.founders[0];
  const ai = new GoogleGenAI({ apiKey });
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
    const response = await ai.models.generateContent({
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
