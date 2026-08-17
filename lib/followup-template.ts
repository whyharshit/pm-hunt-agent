import { firstName } from './outreach-template';
import type { OutreachSequence } from './types';

/**
 * The three follow-up emails, in the same idiom as lib/outreach-template.ts: string
 * interpolation, no model, nothing that can drift run to run.
 *
 * THE RULES THESE FOLLOW
 *  - Touch one is an ordinary follow-up and nothing more (user's call, 2026-08-09). It used
 *    to offer "one concrete thing I would start on at {company}", which was a fixed
 *    paragraph dressed up as a company-specific idea — the same suggestion to every founder.
 *    A plain bump is honest; a real per-company idea would need a model call, which is the
 *    thing that invented figures last time.
 *  - Touches two and three do say something new. By then the founder has read the pitch
 *    twice, and repeating it a third time is what gets cold outreach marked as spam.
 *  - They get shorter, not longer. The first email earned its length by being the pitch; a
 *    follow-up has no such licence.
 *  - The ask goes DOWN. Touch one asks for 15 minutes, touch two asks for a sentence in
 *    reply, touch three asks for nothing at all.
 *  - No em dashes (user's instruction 2026-08-08), same as the initial email.
 *  - They ride in the original thread, so they never re-introduce the sender or repeat the
 *    credentials. The founder can scroll down.
 */

/** How the follow-up subject reads. Threading is done by headers; this just avoids "Re: Re:". */
export function followUpSubject(subject: string): string {
  return /^re:\s/i.test(subject.trim()) ? subject.trim() : `Re: ${subject.trim()}`;
}

/**
 * The job-application follow-ups. Same three rules as the founder ones — shorter each time,
 * the ask goes down, no em dashes — but they cannot share the copy: the founder set opens
 * from a funding round and closes on "congratulations again on the raise", which is nonsense
 * to somebody who posted an internship. Added 2026-08-17 with the job sender.
 */
function jobBody(step: 1 | 2 | 3, greeted: string, company: string): string {
  const hi = `Hi ${firstName(greeted)},`;
  const sign = ['Best,', 'Shivansh'];

  if (step === 1) {
    return [
      hi,
      '',
      'Just following up on my note below, in case it got buried.',
      '',
      `Still very interested in the role at ${company}, and happy to share anything else that would be useful.`,
      '',
      ...sign,
    ].join('\n');
  }

  if (step === 2) {
    return [
      hi,
      '',
      'I know a CV is a thin way to judge someone, so let me offer something better.',
      '',
      'Tell me a problem the team is actually working on and I will send back a short written take on how I would approach it. No call needed, and you get to judge the thinking rather than the resume.',
      '',
      ...sign,
    ].join('\n');
  }

  return [
    hi,
    '',
    'I will stop here so I am not adding to your inbox.',
    '',
    `If the role is still open later, or something else comes up at ${company}, my details are in the thread below.`,
    '',
    ...sign,
  ].join('\n');
}

function body(step: 1 | 2 | 3, greeted: string, company: string): string {
  const hi = `Hi ${firstName(greeted)},`;
  const sign = ['Best,', 'Shivansh'];

  if (step === 1) {
    return [
      hi,
      '',
      'Just following up on my note below, in case it got buried.',
      '',
      `Still keen to help out at ${company} in whatever way is most useful, and happy to keep it to 15 minutes whenever suits you.`,
      '',
      ...sign,
    ].join('\n');
  }

  if (step === 2) {
    return [
      hi,
      '',
      'A call is a lot to give someone you have never met, so let me lower the bar.',
      '',
      'Tell me the one thing most on fire right now and I will send back a short written take on how I would approach it. No call, no commitment, and you get to judge the thinking rather than the CV.',
      '',
      ...sign,
    ].join('\n');
  }

  return [
    hi,
    '',
    'I will stop here so I am not adding to the pile. Congratulations again on the raise.',
    '',
    'If a messy problem turns up later that needs someone to just take it and run, my details are in the thread below.',
    '',
    ...sign,
  ].join('\n');
}

/**
 * Render follow-up number `step` for a sequence. Pure: the caller sends it and records it.
 *
 * Takes the sequence rather than the funding row on purpose. By touch three the row is up to
 * 24 days old and may have aged out of the read window or been deleted, and the follow-up
 * must still greet exactly whoever the first email greeted.
 */
export function renderFollowUp(
  seq: OutreachSequence,
  step: 1 | 2 | 3
): { subject: string; text: string } {
  return {
    subject: followUpSubject(seq.subject),
    // Absent `kind` means a sequence written before job outreach existed, and all of those
    // are founder outreach. Defaulting the other way would put "congratulations on the raise"
    // into every historical thread's third touch.
    text:
      seq.kind === 'job'
        ? jobBody(step, seq.greeted, seq.company)
        : body(step, seq.greeted, seq.company),
  };
}
