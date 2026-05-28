import { GoogleGenAI, Type } from '@google/genai';
import resumeData from '@/profile/resume.json';
import type { Blurb, ScrapedJd, TailoredResume } from './types';

const MODEL = 'gemini-2.5-flash';
const MAX_CHARS = 200;

type ResumeShape = {
  name: string;
  summary: string;
  experience: Array<{ role: string; company: string; bullets: string[] }>;
};

const RESUME = resumeData as ResumeShape;

const SYSTEM = `You write 200-character cold first-touch DMs / email openers from a candidate to a hiring contact.

HARD RULES:
1. Output ≤ 200 characters total (count every char including spaces and punctuation).
2. Reference exactly ONE specific, name-able detail from the job description — a product, initiative, team, tech stack, recent launch, or stated problem. Generic phrases like "your team" or "your mission" do NOT count.
3. Lead with the JD reference, not with "Hi" or a self-intro.
4. Pair the reference with ONE concrete credential from the candidate's resume (a specific company they worked at, a quantified outcome, or a specific tool they shipped). Do not invent.
5. End with a low-friction ask ("worth a quick chat?", "open to a 15-min intro?"). No "I look forward to...".
6. No "Dear", no "Hiring Manager", no "I'm writing to apply". This is a DM, not a letter.
7. Plain text only — no emojis, no markdown, no greeting line.

Also output the JD detail you referenced, verbatim, in the "reference" field so a human can sanity-check that the reference is specific (not generic) before sending.`;

const responseSchema = {
  type: Type.OBJECT,
  properties: {
    text: { type: Type.STRING },
    reference: { type: Type.STRING },
  },
  required: ['text', 'reference'],
  propertyOrdering: ['reference', 'text'],
};

function buildPrompt(jd: ScrapedJd, tailored: TailoredResume | null): string {
  const head = [
    jd.role ? `Role: ${jd.role}` : null,
    jd.company ? `Company: ${jd.company}` : null,
  ]
    .filter(Boolean)
    .join('\n');

  const summary = tailored?.summary ?? RESUME.summary;
  const experience = (tailored?.experience ?? RESUME.experience).map((e) => ({
    role: e.role,
    company: e.company,
    bullets: e.bullets,
  }));

  return [
    'JOB DESCRIPTION:',
    head,
    '',
    jd.text,
    '',
    '---',
    '',
    'CANDIDATE (do not invent beyond this):',
    `Name: ${RESUME.name}`,
    `Summary: ${summary}`,
    'Experience:',
    JSON.stringify(experience, null, 2),
    '',
    '---',
    '',
    'Write the 200-char message + the JD detail you referenced.',
  ]
    .filter((s) => s !== null)
    .join('\n');
}

export async function writeBlurb(
  trackerId: string,
  jd: ScrapedJd,
  tailored: TailoredResume | null
): Promise<Blurb> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const ai = new GoogleGenAI({ apiKey });
  const response = await ai.models.generateContent({
    model: MODEL,
    contents: buildPrompt(jd, tailored),
    config: {
      systemInstruction: SYSTEM,
      responseMimeType: 'application/json',
      responseSchema,
      temperature: 0.7,
    },
  });

  const raw = response.text;
  if (!raw) throw new Error('Gemini returned empty response');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error(`Gemini returned invalid JSON: ${(e as Error).message}`);
  }

  if (!parsed || typeof parsed !== 'object') throw new Error('non-object response');
  const obj = parsed as Record<string, unknown>;
  if (typeof obj.text !== 'string' || typeof obj.reference !== 'string') {
    throw new Error('missing text/reference fields');
  }
  const text = obj.text.trim();
  const reference = obj.reference.trim();
  if (text.length === 0) throw new Error('empty blurb text');
  if (text.length > MAX_CHARS) {
    throw new Error(`blurb is ${text.length} chars, exceeds ${MAX_CHARS}-char cap`);
  }

  return {
    trackerId,
    text,
    reference,
    generatedAt: new Date().toISOString(),
    model: MODEL,
    jdScrapedAt: jd.scrapedAt,
  };
}
