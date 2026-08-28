import type { FundingContact, FundingItem, FundingOutreach } from './types';

/**
 * The user's own outreach email, supplied verbatim 2026-08-08, replacing the LLM-written
 * draft for founder outreach.
 *
 * WHY THIS IS A TEMPLATE AND NOT A PROMPT:
 *  - It costs NOTHING. Drafting was 1 Gemini call per row against a 20/day/project quota;
 *    this is string interpolation, so every row in the queue can be drafted instantly and
 *    the quota goes to contact extraction, which actually needs a model.
 *  - It cannot drift. The LLM version invented its own figures run to run — it wrote
 *    "10k+ weekly hiring signals" for mylynk where the user says "2,000+ sales
 *    signals/month across 386 BFSI companies". A candidate's own numbers must not be
 *    paraphrased by a model.
 *  - The 320-char cap does not apply here. That existed to keep a generated message short;
 *    this is a deliberate long-form email the user wrote.
 *
 * Only three fields vary: the founder's first name, the company, and the raise.
 */

const SUBJECT = 'Just saw the funding news, would love to help build!';

/**
 * Suffix on `FundingOutreach.model` marking a draft a human edited on the dashboard.
 *
 * Load-bearing: `?action=template-drafts` rewrites drafts in bulk from this template, so
 * without the flag one bulk run would silently destroy every hand-edit. That action skips
 * anything carrying it.
 *
 * It lives here rather than in lib/actions.ts because that file is `'use server'`, and
 * Next.js only permits async function exports from a server-actions module — a plain
 * `export const` there fails the build.
 */
export const EDITED_MODEL_SUFFIX = '+edited';

/** Has this draft been hand-edited, and so must survive a bulk re-draft? */
export function isEditedDraft(model: string): boolean {
  return model.endsWith(EDITED_MODEL_SUFFIX);
}

/**
 * How the raise reads inside "recently raised ___". Both fields are optional on a
 * FundingItem, and the sentence has to stay grammatical in all four combinations — an empty
 * `{{Funding}}` would otherwise produce "recently raised  — congratulations!".
 */
export function renderFunding(item: Pick<FundingItem, 'amount' | 'round'>): string {
  const amount = item.amount?.trim();
  const round = item.round?.trim();
  if (amount && round) {
    // "Rs 65 Cr" + "Series A" → "Rs 65 Cr in its Series A"; avoid "Rs 65 Cr Series A round".
    return `${amount} in its ${round}`;
  }
  if (amount) return amount;
  if (round) return `its ${round}`;
  return 'funding';
}

/** First name only — "Hi Garima", never "Hi Garima Luthra". */
export function firstName(full: string): string {
  const cleaned = full.trim().replace(/^(dr|mr|mrs|ms|prof)\.?\s+/i, '');
  return cleaned.split(/\s+/)[0] ?? cleaned;
}

/**
 * Signature lines appended after every "Best, Harshit ..." sign-off, shared by the founder
 * outreach and job outreach templates so a link update never has to happen in two places.
 */
export const SIGNATURE_LINKS = [
  'Portfolio: https://harshit-verma-brown.vercel.app/',
  'GitHub: https://github.com/whyharshit',
  'Projects: https://web-cyan-one-pytx6cl84c.vercel.app/ , https://webapp-eta-ten-58.vercel.app/',
];

/**
 * Build the email. Returns null when there is no founder name: the template opens "Hi
 * {{Name}}," and a cold email that opens "Hi there" to a founder is worse than not sending
 * — so the caller is told to leave the row alone rather than being handed a degraded draft.
 */
export function renderOutreachTemplate(
  item: FundingItem,
  contact?: FundingContact | null
): FundingOutreach | null {
  const founder = contact?.founders[0]?.name;
  if (!founder) return null;

  const text = [
    `Hi ${firstName(founder)},`,
    '',
    // No em dashes anywhere in this email (user's instruction 2026-08-08). Both were mine,
    // added when fixing the source text's punctuation — a full stop and a comma read more
    // naturally here anyway, and em dashes are a common tell for machine-written copy.
    `Saw that ${item.company} recently raised ${renderFunding(item)}. Congratulations! It's an exciting stage to be at, and I'd love to explore whether I could be useful as you scale.`,
    '',
    "I'm Harshit, a student at IIT Kharagpur, and I've spent the last year building AI/ML pipelines across a few early-stage teams.",
    '',
    "A few things I've built/worked on:",
    '',
    '- AI/ML: Engineered an ESG intelligence pipeline at Fitsol, predicting corporate carbon emissions across 2,000+ firms with a stacked ensemble model (log-R² 0.78).',
    '- Applied ML: Built a filter-then-rank hiring pipeline at UnoJobs using SQL filters, vector search, and LLM reranking, cutting average time-to-hire to 7 days across 1M+ applicants.',
    '- AI Agent Ops: Shipped an automated Fireflies-to-Trello pipeline at Omnidel.ai, extracting tasks from 250+ meeting transcripts at 95% recall.',
    '- Startup: Co-founded Quiet, a privacy-first AI note-taking tool for therapists and lawyers, converting early users into paid pilots.',
    '- Execution: First runner-up among 2,000+ participants at IIM Lucknow\'s CityScape case competition; led design & media ops for Kshitij, IIT Kharagpur\'s flagship fest.',
    '',
    "I'm not looking for a narrowly defined internship. Give me a messy problem, and I'll figure it out.",
    '',
    "With the recent funding, I imagine there's a lot on your plate, and I'd love to take one or two things off it.",
    '',
    'Would you be open to a quick 15-minute chat?',
    '',
    'Best,',
    'Harshit',
    'IIT Kharagpur',
    ...SIGNATURE_LINKS,
  ].join('\n');

  return {
    id: item.id,
    text,
    angle: "generalist / founder's office",
    subject: SUBJECT,
    generatedAt: new Date().toISOString(),
    // Recorded so a reader can tell at a glance that no model wrote this, and so the
    // dashboard can distinguish template drafts from any legacy LLM ones.
    model: 'template:user-v1',
  };
}
