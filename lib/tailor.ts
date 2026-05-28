import { GoogleGenAI, Type } from '@google/genai';
import resumeData from '@/profile/resume.json';
import type { ScrapedJd, TailoredResume } from './types';

const MODEL = 'gemini-2.5-flash';

type ResumeShape = {
  name: string;
  summary: string;
  experience: Array<{
    role: string;
    company: string;
    dates?: string;
    location?: string;
    bullets: string[];
  }>;
  skills?: unknown;
};

const RESUME = resumeData as ResumeShape;

const SYSTEM = `You tailor an existing resume to a specific job description.

HARD RULES — these are not suggestions:
1. NEVER invent facts, numbers, employers, skills, or accomplishments not present in the input resume.
2. Keep the same number of bullets per role as the input.
3. Keep the same roles and companies in the same order.
4. Each bullet must remain a faithful reframing of the original bullet at the same index — not a new claim, not a merged claim.
5. Surface JD keywords ONLY when they are honestly applicable to what the original bullet already describes. If a keyword does not apply, do not force it.
6. Preserve quantified outcomes (numbers, %, scale) exactly as written.
7. Bullets stay action-led, one sentence, under 200 characters.
8. The summary stays 2-3 sentences, mirrors the seniority and role focus of the JD, and stays factually grounded in the resume.

You are rewording, not rewriting. If the JD diverges sharply from the resume's history, do minimal tailoring rather than fabricating fit.`;

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    experience: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          role: { type: Type.STRING },
          company: { type: Type.STRING },
          bullets: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ['role', 'company', 'bullets'],
        propertyOrdering: ['role', 'company', 'bullets'],
      },
    },
  },
  required: ['summary', 'experience'],
  propertyOrdering: ['summary', 'experience'],
};

function buildPrompt(jd: ScrapedJd): string {
  const head = [
    jd.role ? `Role: ${jd.role}` : null,
    jd.company ? `Company: ${jd.company}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const resumeBlock = JSON.stringify(
    {
      summary: RESUME.summary,
      experience: RESUME.experience.map((e) => ({
        role: e.role,
        company: e.company,
        bullets: e.bullets,
      })),
    },
    null,
    2
  );

  return [
    'JOB DESCRIPTION:',
    head,
    '',
    jd.text,
    '',
    '---',
    '',
    'CURRENT RESUME (do not invent anything beyond this):',
    resumeBlock,
    '',
    '---',
    '',
    'Return tailored summary + experience bullets per the schema. Same roles, same companies, same bullet counts.',
  ]
    .filter((s) => s !== null)
    .join('\n');
}

function validateShape(
  raw: unknown
): { summary: string; experience: Array<{ role: string; company: string; bullets: string[] }> } {
  if (!raw || typeof raw !== 'object') throw new Error('LLM returned non-object');
  const obj = raw as Record<string, unknown>;
  if (typeof obj.summary !== 'string') throw new Error('missing summary');
  if (!Array.isArray(obj.experience)) throw new Error('missing experience array');

  const expected = RESUME.experience;
  if (obj.experience.length !== expected.length) {
    throw new Error(`expected ${expected.length} experience entries, got ${obj.experience.length}`);
  }

  const experience = obj.experience.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`experience[${i}] not an object`);
    const e = entry as Record<string, unknown>;
    if (typeof e.role !== 'string' || typeof e.company !== 'string') {
      throw new Error(`experience[${i}] missing role/company`);
    }
    if (!Array.isArray(e.bullets)) throw new Error(`experience[${i}] missing bullets`);
    const bullets = e.bullets.map((b, j) => {
      if (typeof b !== 'string') throw new Error(`experience[${i}].bullets[${j}] not a string`);
      return b.trim();
    });
    const expectedCount = expected[i].bullets.length;
    if (bullets.length !== expectedCount) {
      throw new Error(
        `experience[${i}] (${expected[i].company}): expected ${expectedCount} bullets, got ${bullets.length}`
      );
    }
    return { role: e.role, company: e.company, bullets };
  });

  return { summary: obj.summary, experience };
}

export async function tailorResume(
  trackerId: string,
  jd: ScrapedJd
): Promise<TailoredResume> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: buildPrompt(jd),
    config: {
      systemInstruction: SYSTEM,
      responseMimeType: 'application/json',
      responseSchema,
      temperature: 0.4,
    },
  });

  const text = response.text;
  if (!text) throw new Error('Gemini returned empty response');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(`Gemini returned invalid JSON: ${(e as Error).message}`);
  }

  const { summary, experience } = validateShape(parsed);

  return {
    trackerId,
    summary,
    experience,
    generatedAt: new Date().toISOString(),
    model: MODEL,
    jdScrapedAt: jd.scrapedAt,
  };
}
