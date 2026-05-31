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

// Gemini overshoots the 200-char cap at temp 0.7 fairly often. Retry with the
// overshoot fed back and the temperature tightened rather than failing the
// whole tailor pipeline on a single long draft.
const MAX_ATTEMPTS = 3;

function parseBlurb(raw: string | undefined): { text: string; reference: string } {
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
  if (text.length === 0) throw new Error('empty blurb text');
  return { text, reference: obj.reference.trim() };
}

export async function writeBlurb(
  trackerId: string,
  jd: ScrapedJd,
  tailored: TailoredResume | null
): Promise<Blurb> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY not set');

  const ai = new GoogleGenAI({ apiKey });
  const basePrompt = buildPrompt(jd, tailored);
  let lastError = '';

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    // First try keeps the original temperature for phrasing variety; retries
    // tighten it and append the prior overshoot as explicit feedback.
    const contents =
      attempt === 1
        ? basePrompt
        : `${basePrompt}\n\n---\n\nYour previous attempt was rejected: ${lastError}. The text field MUST be ${MAX_CHARS} characters or fewer — count every character and cut words until it fits.`;

    const response = await ai.models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: SYSTEM,
        responseMimeType: 'application/json',
        responseSchema,
        temperature: attempt === 1 ? 0.7 : 0.4,
      },
    });

    let candidate: { text: string; reference: string };
    try {
      candidate = parseBlurb(response.text);
    } catch (e) {
      lastError = (e as Error).message;
      continue;
    }

    if (candidate.text.length > MAX_CHARS) {
      lastError = `blurb is ${candidate.text.length} chars, exceeds ${MAX_CHARS}-char cap`;
      continue;
    }

    return {
      trackerId,
      text: candidate.text,
      reference: candidate.reference,
      generatedAt: new Date().toISOString(),
      model: MODEL,
      jdScrapedAt: jd.scrapedAt,
    };
  }

  throw new Error(`blurb failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
}
