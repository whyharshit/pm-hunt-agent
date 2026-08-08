import answersData from '@/profile/answers.json';
import resumeData from '@/profile/resume.json';
import type { TrackedUrl } from './types';

/**
 * A copy-paste prompt for Claude in Chrome, so a human-supervised assistant fills whatever
 * application form is on screen.
 *
 * WHY THIS INSTEAD OF MORE AUTOMATION. The server-side pre-filler only works on public
 * Google Forms, and two whole classes fall outside it:
 *   - Google Forms restricted to signed-in accounts — Google 401s the view, so no server
 *     can ever read the fields (measured, see lib/gform.ts).
 *   - Everything that isn't a Google Form: Melento, Lever, Greenhouse, Internshala. Those
 *     have no prefill-by-URL feature at all.
 * A browser assistant is already logged in as the user and sees the rendered page, so it
 * reaches both. The user chose this over building an extension.
 *
 * It is also the answer to "automate Internshala applications" that does NOT involve
 * driving a logged-in session with Playwright — the AIHawk class of tool this project
 * refuses on account-ban grounds. A human watches, and a human presses submit.
 *
 * The prompt carries the answers rather than pointing at them, because the browser
 * assistant cannot read this repo.
 */

type Answers = Record<string, string>;
const ANSWERS = answersData as unknown as Answers;

type Resume = {
  name: string;
  summary: string;
  experience: Array<{ role: string; company: string; bullets: string[] }>;
};
const RESUME = resumeData as Resume;

/** Field labels, in the order a form usually asks for them. `_comment` and blanks are dropped. */
const LABELS: Array<[keyof Answers & string, string]> = [
  ['fullName', 'Full name'],
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['email', 'Email'],
  ['phone', 'Phone'],
  ['whatsapp', 'WhatsApp'],
  ['city', 'City'],
  ['country', 'Country'],
  ['timezone', 'Timezone'],
  ['bestTimeToCall', 'Best time to call'],
  ['linkedin', 'LinkedIn'],
  ['portfolio', 'Portfolio'],
  ['github', 'GitHub'],
  ['resumeLink', 'Resume link'],
  ['workSamplesLink', 'Work samples'],
  ['currentRole', 'Current role'],
  ['currentCompany', 'Current company'],
  ['yearsExperience', 'Experience'],
  ['education', 'Education'],
  ['workAuthorization', 'Work authorisation'],
  ['canWorkUsHours', 'Can work US hours'],
  ['openToRemote', 'Open to remote'],
  ['noticePeriodDays', 'Notice period (days)'],
  ['earliestStartDate', 'Earliest start date'],
  ['expectedStipend', 'Expected stipend'],
  ['englishProficiency', 'English proficiency'],
  ['gender', 'Gender'],
  ['pronouns', 'Pronouns'],
  ['hearAboutUs', 'How I heard about you'],
];

/**
 * The prompt tells the assistant to write without em dashes, but the saved answers and
 * resume bullets contain a few of their own ("...marketplace — I turn ambiguity into..."),
 * and text handed to a model as source material is text it will echo. Normalising here
 * keeps the instruction and the example consistent, and matches the same call made for the
 * outreach email.
 */
function noDashes(s: string): string {
  return (
    s
      // An em dash usually joins two independent clauses, so a comma there is a splice:
      // "...a live-events marketplace, I turn ambiguity into a roadmap" reads worse than the
      // dash did. A following capital signals a new clause and gets a full stop; a lowercase
      // continuation is an aside and gets a comma.
      .replace(/\s*[—–]\s*(?=[A-Z])/g, '. ')
      .replace(/\s*[—–]\s*/g, ', ')
      .replace(/,\s*,/g, ',')
      .replace(/\.\s*,/g, '.')
  );
}

function factLines(): string {
  return LABELS.filter(([key]) => (ANSWERS[key] ?? '').trim() !== '')
    .map(([key, label]) => `- ${label}: ${noDashes(ANSWERS[key].trim())}`)
    .join('\n');
}

function longAnswers(): string {
  const out: string[] = [];
  if (ANSWERS.whyThisRole?.trim()) {
    out.push(
      `WHY THIS ROLE (adapt to the specific company, keep every fact true):\n${noDashes(ANSWERS.whyThisRole.trim())}`
    );
  }
  if (ANSWERS.aboutMe?.trim()) out.push(`ABOUT ME:\n${noDashes(ANSWERS.aboutMe.trim())}`);
  if (ANSWERS.additional?.trim()) out.push(`ANYTHING ELSE:\n${noDashes(ANSWERS.additional.trim())}`);
  return out.join('\n\n');
}

function resumeEvidence(): string {
  return RESUME.experience
    .slice(0, 5)
    .map((e) => noDashes(`- ${e.role}, ${e.company}: ${e.bullets.slice(0, 2).join(' ')}`))
    .join('\n');
}

/**
 * `tracked` is optional. Without it the prompt is generic and works on any form; with it
 * the assistant is told which role it is applying to, which is what makes a free-text
 * "why do you want this job" answer specific rather than boilerplate.
 */
export function buildFormFillPrompt(tracked?: Pick<TrackedUrl, 'url' | 'role' | 'company'>): string {
  const target = tracked
    ? [
        'THIS APPLICATION:',
        tracked.role ? `- Role: ${tracked.role}` : null,
        tracked.company ? `- Company: ${tracked.company}` : null,
        `- Posting: ${tracked.url}`,
        '',
      ]
        .filter((l) => l !== null)
        .join('\n')
    : '';

  return `You are filling in a job application form that is open in this browser tab. Fill it using ONLY the facts below.

${target}RULES
1. DO NOT SUBMIT. Fill the fields and stop, so I can review everything before submitting myself. Never click Submit, Apply, Send or Continue-to-submit.
2. Never invent a fact. If a field asks for something not listed below, leave it blank and tell me at the end which fields you left and why.
3. Match the form's own format: if it wants a dropdown option, pick the closest real option; if it wants a number, give digits only; if it caps length, respect the cap.
4. For free-text questions (why this role, why you, cover letter), write 3-5 sentences in first person using the evidence below. Plain, specific, no buzzwords, no em dashes, and do not claim any skill or number that is not listed here.
5. If the form asks to upload a resume, stop and tell me. I will attach it by hand.
6. If anything is ambiguous, ask me instead of guessing.
7. When you are done, list: fields filled, fields left blank, and anything you were unsure about.

MY DETAILS
${factLines()}

${longAnswers()}

EVIDENCE I CAN CITE (do not exaggerate these)
${resumeEvidence()}
`;
}
