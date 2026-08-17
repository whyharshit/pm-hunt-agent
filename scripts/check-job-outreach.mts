/**
 * Job-outreach contract check — free, no network, no model, no credits:
 *   npx tsx scripts/check-job-outreach.mts
 *
 * Three things are pinned here, each because getting it wrong sends a real email that cannot
 * be recalled:
 *
 *  1. THE TEMPLATE. The user supplied it naming TWO different companies (Policybazaar in the
 *     opening line, Justdial in the closing one) because it was pasted from two emails they
 *     had sent by hand. Both are the same slot. If a refactor ever re-hardcodes either, every
 *     application would name a competitor in its last sentence.
 *  2. THEIR FIGURES, VERBATIM. 85%, 2,000+, 386 and 14 are the user's claims about their own
 *     work. The founder pipeline learned this the hard way when a model wrote "10k+ weekly
 *     hiring signals" for a project the user describes as "2,000+ sales signals/month".
 *  3. THE ON-SITE ALLOWANCE. On-site is admitted for PRODUCT roles in INDIA and nothing else.
 *     Losing either half turns "allow on-site product interns" into "the remote gate is gone".
 */
import { isOnsiteAllowed, passes } from '../lib/filters';
import { renderJobOutreach, rolePhrase, teamPhrase } from '../lib/job-outreach-template';
import { contactFromJob, isHiringInbox } from '../lib/job-contact';
import { hasHumanPoster } from '../lib/job-prepare';
import { POSTER_TAG } from '../lib/postjob';
import type { Job, JobContact } from '../lib/types';

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) {
    failures += 1;
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    console.log(`  ✓ ${label}`);
  }
};

const job = (over: Partial<Job> = {}): Job => ({
  id: 'j1',
  source: 'linkedin',
  title: 'Product Management Intern',
  company: 'Acme',
  location: 'Bengaluru, Karnataka, India',
  url: 'https://x.test',
  postedAt: new Date(),
  tags: [],
  ...over,
});

console.log('\n--- filters: the on-site allowance ---');
check(passes(job()), 'on-site product intern in India passes');
check(
  passes(job({ location: 'Gurugram', title: 'APM Intern' })),
  'a bare Indian city counts as India'
);
check(
  passes(job({ title: "Founder's Office - Growth", location: 'Bengaluru, Karnataka, India' })),
  "on-site Founder's Office in India passes",
  'added 2026-08-17 on the user\'s follow-up instruction'
);
check(
  passes(job({ title: 'Founders office Associate', location: 'Mumbai, Maharashtra, India' })),
  'the apostrophe-less spelling counts too'
);
check(
  !passes(job({ title: 'Software Engineer Intern' })),
  'on-site SWE in India is still rejected',
  'on-site is product + founder\'s office only'
);
check(
  passes(job({ title: 'Software Engineer Intern', location: 'Remote' })),
  'remote SWE still passes'
);
check(
  !passes(job({ location: 'New York, NY' })),
  'on-site product in the US is rejected',
  'on-site is India-only'
);
check(
  !passes(job({ location: '' })),
  'an unknown location does not earn the on-site allowance'
);
check(
  !isOnsiteAllowed(job({ location: 'Remote', description: 'our Bangalore office' })),
  'a city named only in the description does not make the row Indian'
);

console.log('\n--- template: the two-company trap ---');
const contact: JobContact = {
  id: 'j1',
  people: [{ name: 'Ananya Rao' }],
  emails: [{ address: 'ananya@acme.com', foundOn: 'the job post itself', person: 'Ananya Rao' }],
  foundAt: new Date().toISOString(),
  model: 'post',
};
const draft = renderJobOutreach(job(), contact);
check(Boolean(draft), 'a named contact produces a draft');
const text = draft?.text ?? '';
check(!/policybazaar/i.test(text), 'Policybazaar is not hardcoded');
check(!/justdial/i.test(text), 'Justdial is not hardcoded');
check(
  (text.match(/\bAcme\b/g) ?? []).length === 2,
  'the company fills BOTH slots',
  `found ${(text.match(/\bAcme\b/g) ?? []).length}`
);
check(text.startsWith('Hi Ananya,'), 'opens with the first name only');
check(!renderJobOutreach(job(), null), 'no name means no draft, never "Hi there"');

console.log('\n--- template: the user\'s own figures, verbatim ---');
for (const figure of [
  'cut quote turnaround time by 85%',
  '2,000+ monthly sales signals across 386 BFSI accounts',
  'live-events marketplace operating across 14 cities',
  'pre-final year student at IIT Kharagpur',
]) {
  check(text.includes(figure), `verbatim: "${figure.slice(0, 40)}…"`);
}
check(!/[—–]/.test(text), 'no em or en dashes anywhere in the body');
check(!/[—–]/.test(draft?.subject ?? ''), 'no em or en dashes in the subject');

console.log('\n--- template: the role and team phrases ---');
check(rolePhrase('Product Management Intern') === 'Product Management', 'intern words stripped');
check(teamPhrase('Product Manager Intern') === 'the product team', 'product role names the product team');
check(
  teamPhrase('Software Engineer Intern') === 'the engineering team',
  'an engineering role does not say "product team"'
);
check(teamPhrase('Chief of Staff') === 'the team', 'an unknown function falls back to "the team"');

console.log('\n--- outreach targeting: portals have no poster to email ---');
check(!hasHumanPoster(job({ source: 'internshala' })), 'Internshala is apply-on-the-site');
check(!hasHumanPoster(job({ source: 'unstop' })), 'Unstop is apply-on-the-site');
check(hasHumanPoster(job({ source: 'linkedin' })), 'a LinkedIn posting has a poster');
check(hasHumanPoster(job({ source: 'apify' })), 'a LinkedIn feed post has a poster');
check(hasHumanPoster(job({ source: 'paste' })), 'a pasted post has a poster');

console.log('\n--- contact: reading the address out of the post ---');
const posted = contactFromJob(
  job({
    tags: [`${POSTER_TAG}Ananya Rao`, 'ananya@acme.com'],
    description: 'DM me or write to ananya@acme.com',
  })
);
check(posted?.emails[0]?.address === 'ananya@acme.com', 'address lifted from the post');
check(posted?.emails[0]?.person === 'Ananya Rao', 'the poster is attached to their own address');
check(posted?.emails[0]?.foundOn === 'the job post itself', 'provenance recorded');

const shared = contactFromJob(
  job({ tags: [`${POSTER_TAG}Ananya Rao`], description: 'send your CV to hr@acme.com' })
);
check(
  shared?.emails[0]?.person === undefined,
  'a named poster is NOT attached to a shared inbox',
  'that pairing is what queued "Hi Paolo," to booking@weroad.com'
);
check(isHiringInbox('careers@acme.com'), 'careers@ is recognised as a hiring inbox');
check(!isHiringInbox('ananya@acme.com'), 'a personal address is not a hiring inbox');

console.log(
  failures === 0 ? '\nALL GOOD\n' : `\n${failures} FAILURE(S) — do not deploy\n`
);
process.exit(failures === 0 ? 0 : 1);
