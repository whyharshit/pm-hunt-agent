/**
 * Job-outreach contract check — free, no network, no model, no credits:
 *   npx tsx scripts/check-job-outreach.mts
 *
 * Five things are pinned here, each because getting it wrong sends a real email that cannot
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
 *  4. WHOSE DOMAIN IT IS. Hunter's domain-finder matches fuzzily, and on 2026-08-18 its one
 *     candidate for a The/Nudge Institute internship was `aikyamjobs.org` - the job PLATFORM
 *     the role was listed on. A named person there was sent an application for another
 *     company's role. A domain must correspond to the company before anything is mailed at it.
 *  5. WHO THE EMPLOYER IS, as opposed to who POSTED. A LinkedIn post has no company field, so
 *     both apify sources used to copy the post's author into `Job.company` - and the template
 *     interpolates that field twice. A recruiter called Fathima Sajid was therefore mailed an
 *     application about "Prompt Engineer Generative AI roles at Fathima Sajid" that closed by
 *     offering to bring the sender's experience "to Fathima Sajid". The greeting and the
 *     employer are two different questions, and this file keeps them apart.
 */
import { categoryLabel, categoryRank } from '../lib/job-category';
import { domainMatchesCompany } from '../lib/enrich';
import { isOnsiteAllowed, isPitchTarget, passes } from '../lib/filters';
import {
  isCurrentJobTemplate,
  isTeamDraft,
  looksLikeRole,
  renderJobOutreach,
  rolePhrase,
  teamPhrase,
} from '../lib/job-outreach-template';
import { contactFromJob, isHiringInbox } from '../lib/job-contact';
import { hasHumanPoster } from '../lib/job-prepare';
import { renderFollowUp } from '../lib/followup-template';
import { companyOf, employerName, POSTER_TAG } from '../lib/postjob';
import type { Job, JobContact, OutreachSequence } from '../lib/types';

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
// REVERSED 2026-08-18. This asserted the opposite until that date, when the user was asked
// directly whether on-site India should cover data and SWE and answered "prefer product most
// then strategy, growth, founder's office etc then data/sde" - a yes with an order. The order
// is enforced by categoryRank below, not by this gate.
check(
  passes(job({ title: 'Software Engineer Intern' })),
  'on-site SWE in India now passes',
  'ranked last by categoryRank, but no longer gated out'
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

console.log('\n--- template: a post headline is NOT a role ---');
// The real failure, 2026-08-18: this became both the subject line and the middle of the
// opening sentence, as "your post about Out of Stealth! We raised ~$3.1M … roles at Kily".
const HEADLINE =
  'Out of Stealth! We raised ~$3.1M in seed funding, led by Sorin Investments, with participation from Razorpay …';
check(!looksLikeRole(HEADLINE), 'a funding announcement is not a role');
check(!looksLikeRole('We are hiring for multiple positions across our growing team!'), 'a sentence is not a role');
check(looksLikeRole('Product Management Intern'), 'an actual title is a role');
check(looksLikeRole("Founder's Office - Growth"), 'a hyphenated title is a role');

const headlineDraft = renderJobOutreach(job({ title: HEADLINE, company: 'Kily' }), {
  ...contact,
  people: [{ name: 'Sharad Gupta' }],
});
check(
  !headlineDraft?.text.includes('Sorin Investments'),
  'the headline never reaches the body',
  headlineDraft?.text.split('\n')[2]?.slice(0, 70)
);
check(
  Boolean(headlineDraft?.text.includes('I came across your hiring post for Kily')),
  'the sentence degrades gracefully instead of interpolating junk'
);
check(
  headlineDraft?.subject === 'saw your linkedIn post, shivansh from IIT Kgp :)',
  'the subject is the fixed human line, in the casing the user supplied',
  headlineDraft?.subject
);
check(
  !headlineDraft?.subject.includes('Sorin'),
  'the headline never reaches the subject either'
);

console.log('\n--- template: the poster is not the employer (the 2026-08-20 bug) ---');
// THE REAL SEND. A LinkedIn post by a recruiter called Fathima Sajid became a row with
// `company: 'Fathima Sajid'`, because the source copied the post's AUTHOR into the employer
// field. The template then mailed HER an application about "Prompt Engineer Generative AI
// roles at Fathima Sajid" which closed by offering to bring the sender's experience "to
// Fathima Sajid". Both slots, one wrong field, and nothing in between could tell.
const POSTER = 'Fathima Sajid';
const posterRow = job({
  source: 'apify',
  title: "We're is Hiring: Prompt Engineer Generative AI",
  company: POSTER,
  tags: [`${POSTER_TAG}${POSTER}`],
  location: 'Remote',
});
const posterContact: JobContact = {
  id: 'j1',
  people: [{ name: POSTER }],
  emails: [{ address: 'fathima@example.com', foundOn: 'the job post itself', person: POSTER }],
  foundAt: new Date().toISOString(),
  model: 'post',
};
const posterText = renderJobOutreach(posterRow, posterContact)?.text ?? '';
check(posterText.startsWith('Hi Fathima,'), 'the poster is still who the email GREETS');
check(
  !/(roles|execution) (at|to) Fathima/i.test(posterText),
  'and is never named as the employer',
  posterText.split('\n')[2]
);
check(
  (posterText.match(/Fathima/g) ?? []).length === 1,
  'their name appears exactly once, in the greeting',
  `found ${(posterText.match(/Fathima/g) ?? []).length}`
);
check(
  posterText.includes('I came across your post about Prompt Engineer Generative AI roles,'),
  'the announcement is stripped and the clause just ends',
  posterText.split('\n')[2]
);
check(!/ {2,}/.test(posterText), 'no double space where the company used to be');
check(!/\b(at|to)\s*[,.]/.test(posterText), 'no preposition dangling off a dropped clause');
check(
  posterText.includes(
    "I'd love to bring this mix of AI, product and execution to the engineering team."
  ),
  "the closing keeps the user's words and stops at the team",
  posterText.split('\n').at(-5)
);

console.log('\n--- rolePhrase: the announcement is not the role ---');
check(
  rolePhrase("We're is Hiring: Prompt Engineer Generative AI") === 'Prompt Engineer Generative AI',
  "the poster's own typo never reaches the email",
  rolePhrase("We're is Hiring: Prompt Engineer Generative AI")
);
check(rolePhrase('Hiring: Product Intern') === 'Product', 'a bare "Hiring:" prefix comes off');
check(
  rolePhrase('Urgent opening for Data Analyst Intern') === 'Data Analyst',
  'so does "Urgent opening for"',
  rolePhrase('Urgent opening for Data Analyst Intern')
);
check(rolePhrase('#Hiring - Growth Intern') === 'Growth', 'the hashtag-and-dash form too');
check(
  rolePhrase('Talent Acquisition Intern') === 'Talent Acquisition',
  'a legitimate title is NOT eaten from the middle'
);
check(rolePhrase('We are hiring!') === '', 'an all-announcement title yields nothing at all');
check(
  rolePhrase('Product Management Intern') === 'Product Management',
  'and the ordinary case is unchanged'
);

// THE USER'S OWN LIVE ROWS, read off /paste on 2026-08-20. The separators used to be deleted
// rather than cut at, which welded the qualifier onto the role: the MPL row went out saying
// "your post about Product Management Mobile Premier League MPL US roles at Mobile Premier
// League (MPL)". A title's role is its HEAD.
const REAL_TITLES: Array<[string, string]> = [
  ["We're hiring: Product Manager – Prepaid Cards & Gift Cards (India).", 'Product Manager'],
  ["We're Hiring: Product Management Intern | Mobile Premier League (MPL) US", 'Product Management'],
  ['Hiring: Product Manager (Remote | Entry-Level)', 'Product Manager'],
  ["Founder's Office - Growth", "Founder's Office"],
  // The hyphen INSIDE a word must survive. Only a spaced dash separates.
  ['Full-stack Developer Intern', 'Full-stack Developer'],
  ['Data Analyst, Bengaluru', 'Data Analyst'],
];
for (const [title, want] of REAL_TITLES) {
  check(rolePhrase(title) === want, `"${title.slice(0, 42)}…" -> "${want}"`, rolePhrase(title));
}
check(
  REAL_TITLES.every(([, want]) => !/[–—]/.test(want)),
  'no en or em dash can reach the body through a title',
  'standing rule, 2026-08-08'
);
// And the two junk shapes must STILL degrade, now that the role test runs on the cut phrase.
check(!looksLikeRole(rolePhrase(HEADLINE)), 'a funding headline still fails after the cut');
check(
  !looksLikeRole(
    rolePhrase("Kirana Club is entering its next phase of growth — and we're looking for builders.")
  ),
  'and so does a chatty growth announcement'
);
check(!looksLikeRole(rolePhrase('Viamedia.ai is hiring! 🚀')), 'and a bare "X is hiring!" line');

console.log('\n--- companyOf: who is hiring, read out of the post ---');
const co = (text: string, author?: { name?: string; info?: string; type?: string }) =>
  companyOf(text, author ?? { name: POSTER });
check(co('We are hiring at Zynetic for a product intern') === 'Zynetic', 'reads "hiring at X"');
check(co('Zynetic Labs is hiring a product intern') === 'Zynetic Labs', '"X is hiring"');
check(co('Company: Zynetic\nRole: Product Intern') === 'Zynetic', 'an explicit label');
check(
  co(`${POSTER} is hiring a product intern`) === '',
  'the POSTER is never the answer, however the sentence reads'
);
check(
  co('Hiring a product intern. Share your CV at hr@zynetic.com') === '',
  'an email DOMAIN is never turned into a company name',
  'aikyamjobs.org was the platform, not the employer whose role it listed'
);
check(co('We are hiring at Bangalore for a product intern') === '', 'a city is not a company');
check(co('We are hiring at scale across our team') === '', '"at scale" is not a company');
check(
  co('We are hiring at Sharma Manpower Solutions for a client') === '',
  'a staffing agency is not the employer doing the hiring'
);
check(
  co('Product intern wanted, DM me', { name: 'Acme Inc', type: 'company' }) === 'Acme Inc',
  'a company PAGE really is the employer'
);
check(
  co('Product intern wanted, DM me', { name: POSTER, info: 'Talent Acquisition at Zynetic' }) ===
    'Zynetic',
  'the recruiter headline is the last resort'
);
check(
  co("We're is Hiring: Prompt Engineer Generative AI\nMail fathima@example.com") === '',
  'a contraction is not a company, however capitalised',
  'the reported post title itself offered "We\'re" as the employer'
);
check(co('Hiring a product intern, DM me') === '', 'and otherwise: nothing');

console.log('\n--- employerName: the rows already in storage ---');
check(employerName(posterRow) === '', 'a stored poster name is disbelieved');
check(
  employerName(job({ company: 'Unknown', tags: [] })) === '',
  "apify's 'Unknown' placeholder is not a company"
);
check(
  employerName(job({ company: 'via t.me/jobs_india', tags: [] })) === '',
  'nor is a telegram aggregator'
);
check(employerName(job({ company: 'Acme', tags: [] })) === 'Acme', 'a real name is trusted');
// No address in this one: a published address plus a senior function makes the row a PITCH
// target, which is a different sentence and would not test what this is testing.
const oldRow = {
  ...posterRow,
  description: 'Great news! Zynetic is hiring a product intern. Apply on our careers page.',
};
check(
  employerName(oldRow) === 'Zynetic',
  'and the real employer is RECOVERED from the stored post when it is in there',
  employerName(oldRow)
);
check(
  Boolean(renderJobOutreach(oldRow, posterContact)?.text.includes('roles at Zynetic,')),
  'so an old row can still name the right company',
  renderJobOutreach(oldRow, posterContact)?.text.split('\n')[2]
);

console.log('\n--- versioning: the drafts already in the queue ---');
// The bump is what re-renders them, and it only works if a v3 string reads as stale to
// EVERYTHING that can send: the prepare pass, the unattended sender, and the dashboard button.
// All three ask this one function.
for (const old of [
  'template:job-v3',
  'template:job-team-v3',
  'template:job-pitch-v3',
  'template:job-team-pitch-v3',
]) {
  check(!isCurrentJobTemplate(old), `${old} is stale and must be re-rendered`);
}
const fresh = renderJobOutreach(job(), contact);
check(isCurrentJobTemplate(fresh?.model ?? ''), 'a freshly rendered draft is current');
check(
  isCurrentJobTemplate(renderJobOutreach(job(), contact, { greeting: 'team' })?.model ?? ''),
  'and so is a team draft'
);
check(
  !isCurrentJobTemplate(`${fresh?.model}+edited`),
  'a hand-edited draft is never "current", so nothing rewrites it'
);

console.log('\n--- template: the "Hi team," variant ---');
const teamDraft = renderJobOutreach(job(), contact, { greeting: 'team' });
check(Boolean(teamDraft?.text.startsWith('Hi team,')), 'team draft greets nobody by name');
check(!teamDraft?.text.includes('Ananya'), 'no name leaks into a team draft');
check(isTeamDraft(teamDraft?.model ?? ''), 'the model string records that it is a team draft');
check(!isTeamDraft(draft?.model ?? ''), 'a person draft is not mistaken for a team draft');
check(
  !renderJobOutreach(job(), null),
  'no contact still means no draft, even now that team drafts exist'
);

console.log('\n--- template: the role and team phrases ---');
check(rolePhrase('Product Management Intern') === 'Product Management', 'intern words stripped');
check(teamPhrase('Product Manager Intern') === 'the product team', 'product role names the product team');
check(
  teamPhrase('Software Engineer Intern') === 'the engineering team',
  'an engineering role does not say "product team"'
);
check(teamPhrase('Chief of Staff') === 'the team', 'an unknown function falls back to "the team"');

console.log('\n--- follow-ups: job sequences get job copy, and team sends get followed up ---');
const seq = (over: Partial<OutreachSequence> = {}): OutreachSequence => ({
  id: 'j1',
  kind: 'job',
  company: 'Kily',
  to: 'sharad@kily.com',
  greeted: 'Sharad',
  subject: 'saw your linkedIn post, shivansh from IIT Kgp :)',
  sends: [],
  step: 0,
  state: 'active',
  ...over,
});
for (const step of [1, 2, 3] as const) {
  const f = renderFollowUp(seq(), step);
  check(!/raise|funding|congratulations/i.test(f.text), `follow-up ${step} says nothing about a raise`);
  check(!/[—–]/.test(f.text), `follow-up ${step} has no em or en dashes`);
}
check(
  /congratulations again on the raise/i.test(renderFollowUp(seq({ kind: undefined }), 3).text),
  'a sequence with no kind still gets the FOUNDER copy',
  'every sequence written before job outreach existed is founder outreach'
);
// The bug this pins: runJobAutoSend used to pass greeted:'' for a team draft, and
// runFollowUps refuses an empty greeted, so every shared-inbox send was stranded with no
// follow-ups and reported as a failure three days later.
check(
  renderFollowUp(seq({ greeted: 'team' }), 1).text.startsWith('Hi team,'),
  'a team sequence follows up with "Hi team,"'
);

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

// 4. Whose domain is it? These are the live probe results from the incident, not invented
//    strings: "The/Nudge Institute" really did return these near-miss candidates.
check(
  !domainMatchesCompany('The/Nudge Institute', 'aikyamjobs.org', 'Aikyam Jobs'),
  'a job PLATFORM is not the employer whose role it lists',
  "this exact pairing mailed a stranger about another company's internship on 2026-08-18"
);
check(
  !domainMatchesCompany('The/Nudge Institute', 'thenodeinstitute.org', 'The Node Institute'),
  'a one-character near-miss is not the company'
);
check(
  !domainMatchesCompany('The/Nudge Institute', 'theedgeinstitute.org', 'The Edge Institute'),
  'nor is a same-shape different name'
);
check(
  domainMatchesCompany('The/Nudge Institute', 'thenudge.org', 'The/Nudge'),
  'the REAL domain still resolves - this guard must not simply refuse everything'
);
check(
  domainMatchesCompany('Cloud Security Web', 'cloudsecurityweb.com', 'Cloud Security Web'),
  'an exact match resolves'
);
check(
  domainMatchesCompany('Consint.AI', 'consint.ai', 'Consint'),
  'punctuation in the company name still resolves (the flatten case)'
);

// 5. The 2026-08-18 widening: on-site India for every target function, ranked rather than
//    gated, plus the internship-pitch path for senior postings that publish an address.
check(
  categoryRank('Product Intern') < categoryRank('Growth Intern'),
  'product outranks growth'
);
check(
  categoryRank('Growth Intern') < categoryRank('SDE Intern'),
  'growth outranks data/sde',
  'the cap is 5 a day, so this ordering decides what is actually sent'
);
check(categoryLabel("Founder's Office Intern") === "Founder's Office", 'the label reads as a human wrote it');
check(categoryLabel('Warehouse Picker') === '', 'an unresolved title yields no label, never "Other"');

const senior = job({
  title: 'Senior Product Manager',
  location: 'Bengaluru, India',
  description: 'Write to hiring@acme.com',
});
check(isPitchTarget(senior), 'a senior product post WITH an address is a pitch target');
check(passes(senior), 'and it survives passes(), despite the seniority reject');
check(
  !isPitchTarget(job({ title: 'Senior Product Manager', location: 'Bengaluru, India' })),
  'the same post WITHOUT an address is not',
  "publishing an address is the user's own condition for pitching"
);
check(
  !isPitchTarget(
    job({ title: 'Senior Graphic Designer', location: 'Bengaluru, India', description: 'hi@acme.com' })
  ),
  'a senior post in the WRONG DISCIPLINE is still rejected',
  'the pitch path relaxes seniority, never discipline'
);
check(
  !isPitchTarget(job({ title: 'Senior Product Manager', location: 'Berlin', description: 'hi@acme.com' })),
  'and it must still be reachable — remote, or in India'
);
check(
  isOnsiteAllowed(job({ title: 'SDE Intern', location: 'Bengaluru, India' })),
  'on-site India now admits SDE too (user, 2026-08-18)'
);
check(
  !isOnsiteAllowed(job({ title: 'Product Intern', location: 'Berlin, Germany' })),
  'but on-site outside India is still refused',
  'the India half is the only thing left in that gate'
);

// 6. The experience bullets must appear in BOTH drafts. The pitch shipped without them for
//    about an hour on 2026-08-18 and the user's correction was immediate: "use this draft you
//    have dropped my experiences from it". A cold pitch is exactly where the evidence has to
//    be, because there is no advertised role to anchor it.
const pitchDraft = renderJobOutreach(
  job({ title: 'Senior Growth Manager', location: 'Bengaluru, India', description: 'hi@acme.com' }),
  { ...contact, people: [{ name: 'Ananya Rao' }] }
);
const applyDraft = renderJobOutreach(job({ title: 'Product Intern' }), {
  ...contact,
  people: [{ name: 'Ananya Rao' }],
});
for (const [label, d] of [['pitch', pitchDraft], ['application', applyDraft]] as const) {
  check(Boolean(d?.text.includes('Omnidel.ai')), `the ${label} draft carries the projects`);
  check(
    Boolean(d?.text.includes('Spring Fest')),
    `the ${label} draft carries the IIT KGP line`,
    'supplied 2026-08-18; one definition feeds both drafts so they cannot drift apart'
  );
  check(Boolean(d?.text.includes('2,000+')), `the ${label} draft keeps the figures verbatim`);
}
check(
  Boolean(pitchDraft?.text.includes('regarding Growth internship opportunities')),
  'the pitch asks about an internship, naming the category'
);

// The analyst trio, in the order the user gave: product analyst, then business, then data.
check(
  categoryRank('Product Analyst') < categoryRank('Business Analyst') &&
    categoryRank('Business Analyst') < categoryRank('Data Analyst'),
  'product analyst > business analyst > data analyst'
);
check(
  categoryRank('Product Analyst') > categoryRank('Product Manager Intern'),
  'and all three rank below core product',
  'Product Analyst contains "product", so it must be matched BEFORE the product family'
);
check(categoryLabel('Business Analyst Intern') === 'Business Analyst', 'the analyst labels read correctly');

console.log(
  failures === 0 ? '\nALL GOOD\n' : `\n${failures} FAILURE(S) — do not deploy\n`
);
process.exit(failures === 0 ? 0 : 1);
