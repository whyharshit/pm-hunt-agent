import { GoogleGenAI, Type } from '@google/genai';
import resumeData from '@/profile/resume.json';
import { fetchTechCrunchFunding, type FundingRaw } from './sources/techcrunch';
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

export type FundingScanResult = { fetched: number; newCount: number; usedFallback: boolean };

/**
 * Watch new funding announcements: fetch the feed, dedupe, enrich via one
 * batched Gemini call (falls back to the raw headline if Gemini is unavailable
 * — the user asked to surface everything), persist, and report run-state.
 */
export async function runFundingScan(): Promise<FundingScanResult> {
  await setAgentRunning('funding');
  try {
    const raws = await fetchTechCrunchFunding();
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
      summary: `fetched ${raws.length} · ${items.length} new${usedFallback ? ' (raw — Gemini fallback)' : ''}`,
      stats: { fetched: raws.length, new: items.length },
      error: null,
    });

    return { fetched: raws.length, newCount: items.length, usedFallback };
  } catch (e) {
    await recordAgentRun('funding', { state: 'error', error: (e as Error).message });
    throw e;
  }
}

// ---- Per-company cold outreach draft ----

const OUTREACH_SYSTEM = `You write a short cold first-touch outreach message from a candidate to the FOUNDER of a startup that just raised funding.

HARD RULES:
1. Output ≤ ${MAX_OUTREACH} characters total (count every char).
2. Infer the single best-fit early-stage role to pitch FOR THIS company from its funding/business context — e.g. founder's office / chief of staff / generalist for a fresh seed raise, ops for a logistics raise, product for a clear SaaS product. Pick one; don't hedge.
3. Open by referencing the raise specifically (amount/round/what they do) — not "congrats on your funding" generically.
4. Pair it with ONE concrete credential from the candidate's resume (a real company, a quantified outcome, or a tool they shipped). Never invent.
5. End with a low-friction ask ("worth a quick chat?", "open to a 15-min intro?").
6. Plain text only — no markdown, no emojis, no "Dear", no letter formatting.
7. If a RECIPIENT is named, open with a bare first-name greeting ("Hi Maya —") before the raise reference. If no recipient is named, use no greeting at all.
8. Also write "subject": an email subject line, ≤ 60 chars, concrete and specific to this company. No clickbait, no "Job application", no exclamation marks.

Also output the role angle you chose in the "angle" field.`;

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

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      systemInstruction: OUTREACH_SYSTEM,
      responseMimeType: 'application/json',
      responseSchema: outreachSchema,
      temperature: 0.7,
    },
  });

  const text = response.text;
  if (!text) throw new Error('Gemini returned empty response');
  const parsed = JSON.parse(text) as { text?: string; angle?: string; subject?: string };
  if (!parsed.text || !parsed.angle) throw new Error('Gemini response missing text/angle');
  if (parsed.text.length > MAX_OUTREACH) {
    throw new Error(`outreach too long: ${parsed.text.length} > ${MAX_OUTREACH}`);
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
