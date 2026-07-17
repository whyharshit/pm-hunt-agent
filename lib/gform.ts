import { GoogleGenAI, Type } from '@google/genai';
import answersData from '@/profile/answers.json';
import { decodeEntities } from './html';
import type { GformField, GformPrefill } from './types';

const MODEL = 'gemini-2.5-flash';
const FETCH_TIMEOUT_MS = 15_000;

// Google's question-type codes (from FB_PUBLIC_LOAD_DATA_). File uploads can't be
// URL-pre-filled — Google requires an interactive picker — so we always skip them.
const TYPE_NAMES: Record<number, string> = {
  0: 'short answer',
  1: 'paragraph',
  2: 'multiple choice',
  3: 'dropdown',
  4: 'checkboxes',
  5: 'linear scale',
  7: 'grid',
  9: 'date',
  10: 'time',
  13: 'file upload',
};

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const answers = answersData as Record<string, string>;

export function answersFilled(): boolean {
  return Object.entries(answers).some(
    ([k, v]) => !k.startsWith('_') && typeof v === 'string' && v.trim() !== ''
  );
}

async function fetchForm(url: string): Promise<{ html: string; finalUrl: string }> {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, accept: 'text/html' },
    redirect: 'follow',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`form fetch ${res.status}`);
  return { html: await res.text(), finalUrl: res.url };
}

/**
 * Google embeds the whole form as `FB_PUBLIC_LOAD_DATA_ = [...]`. Extract that array
 * by brace-matching from its first `[` (respecting string literals), so a `]` inside a
 * question title can't end the match early.
 */
function extractLoadData(html: string): unknown {
  const marker = 'FB_PUBLIC_LOAD_DATA_ = ';
  const at = html.indexOf(marker);
  if (at === -1) throw new Error('not a public Google Form (no form data found)');
  const begin = html.indexOf('[', at);
  if (begin === -1) throw new Error('malformed form data');

  let depth = 0;
  let inStr = false;
  let quote = '';
  let i = begin;
  for (; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") {
      inStr = true;
      quote = c;
    } else if (c === '[') {
      depth++;
    } else if (c === ']') {
      depth--;
      if (depth === 0) {
        i++;
        break;
      }
    }
  }
  return JSON.parse(html.slice(begin, i));
}

type LoadArray = unknown[];
const asArr = (x: unknown): LoadArray => (Array.isArray(x) ? x : []);

export type ParsedForm = { title: string; viewUrl: string; fields: GformField[] };

function parseForm(html: string, finalUrl: string): ParsedForm {
  const data = asArr(extractLoadData(html));
  const body = asArr(data[1]);
  const items = asArr(body[1]);

  const fields: GformField[] = [];
  for (const raw of items) {
    const q = asArr(raw);
    const title = decodeEntities(String(q[1] ?? '')).trim();
    const type = typeof q[3] === 'number' ? q[3] : -1;
    const entries = q[4];
    if (!Array.isArray(entries)) continue; // section headers / images carry no entry

    for (const rawEntry of entries) {
      const e = asArr(rawEntry);
      const entryId = e[0];
      if (entryId == null) continue;
      const rawOpts = e[1];
      const options = Array.isArray(rawOpts)
        ? rawOpts
            .map((o) => decodeEntities(String(asArr(o)[0] ?? '')).trim())
            .filter(Boolean)
        : undefined;
      fields.push({
        entryId: String(entryId),
        title,
        type,
        typeName: TYPE_NAMES[type] ?? `type ${type}`,
        required: e[2] === 1,
        options: options && options.length ? options : undefined,
      });
    }
  }

  const viewUrl = finalUrl.split('?')[0].split('#')[0];
  const title = decodeEntities(String(body[8] ?? 'Google Form')).trim() || 'Google Form';
  return { title, viewUrl, fields };
}

const mapSchema = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      entryId: { type: Type.STRING },
      value: { type: Type.STRING },
    },
    required: ['entryId', 'value'],
    propertyOrdering: ['entryId', 'value'],
  },
};

const MAP_SYSTEM = `You map a candidate's saved answers onto a job-application form's fields.

For each field you can confidently answer FROM THE PROVIDED ANSWERS, return { entryId, value }.

RULES:
- Use only the candidate's answers. Never invent a value that isn't supported by them.
- If the answers don't cover a field, OMIT it — a human will fill it. Do not guess.
- For multiple choice / dropdown / checkboxes, the value MUST be copied EXACTLY from that field's options list. If no option matches the candidate's answer, omit the field.
- For a name field asking full name, use the full name; if it clearly wants first or last only, use that part.
- Match on meaning, not wording ("E-mail", "Contact email", "Your email address" all map to the email answer).
- Return only fields you are filling. Omit everything else.`;

async function mapAnswers(fields: GformField[]): Promise<Map<string, string>> {
  const fillable = fields.filter((f) => f.type !== 13 && f.entryId);
  if (fillable.length === 0) return new Map();

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');
  const ai = new GoogleGenAI({ apiKey });

  const prompt = [
    'CANDIDATE ANSWERS:',
    JSON.stringify(answers, null, 2),
    '',
    'FORM FIELDS:',
    JSON.stringify(
      fillable.map((f) => ({
        entryId: f.entryId,
        question: f.title,
        type: f.typeName,
        required: f.required,
        options: f.options,
      })),
      null,
      2
    ),
  ].join('\n');

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      systemInstruction: MAP_SYSTEM,
      responseMimeType: 'application/json',
      responseSchema: mapSchema,
      temperature: 0.1,
    },
  });

  const text = response.text;
  if (!text) throw new Error('Gemini returned empty response');
  const parsed = JSON.parse(text) as Array<{ entryId?: string; value?: string }>;

  const byId = new Map(fillable.map((f) => [f.entryId, f]));
  const out = new Map<string, string>();
  for (const m of parsed) {
    if (!m.entryId || m.value == null || m.value === '') continue;
    const field = byId.get(String(m.entryId));
    if (!field) continue;
    // Guard the model's option constraint deterministically — a pre-fill value that
    // isn't an exact option is silently dropped by Google, so never emit one.
    if (field.options && !field.options.includes(m.value)) continue;
    out.set(field.entryId, m.value);
  }
  return out;
}

function buildPrefillUrl(viewUrl: string, filled: Map<string, string>): string {
  const u = new URL(viewUrl);
  u.search = '';
  u.searchParams.set('usp', 'pp_url');
  for (const [entryId, value] of filled) u.searchParams.append(`entry.${entryId}`, value);
  return u.toString();
}

/**
 * Turn a public Google Form URL into a pre-filled link: read its fields, map the
 * candidate's saved answers onto them, and encode those as a `usp=pp_url` link. The
 * user opens it, eyeballs it, uploads any resume file by hand, and submits — we never
 * submit for them. Returns which fields got filled and which were left (and why).
 */
export async function generatePrefill(trackerId: string, url: string): Promise<GformPrefill> {
  const { html, finalUrl } = await fetchForm(url);
  const { title, viewUrl, fields } = parseForm(html, finalUrl);
  const filledMap = await mapAnswers(fields);

  const filled: GformPrefill['filled'] = [];
  const skipped: GformPrefill['skipped'] = [];
  for (const f of fields) {
    if (!f.entryId) continue;
    const value = filledMap.get(f.entryId);
    if (value != null) {
      filled.push({ title: f.title, value });
    } else {
      skipped.push({
        title: f.title,
        reason: f.type === 13 ? 'file upload — attach by hand' : 'no matching answer',
      });
    }
  }

  return {
    trackerId,
    formTitle: title,
    prefillUrl: buildPrefillUrl(viewUrl, filledMap),
    filled,
    skipped,
    fieldCount: fields.filter((f) => f.entryId).length,
    generatedAt: new Date().toISOString(),
    model: MODEL,
  };
}
