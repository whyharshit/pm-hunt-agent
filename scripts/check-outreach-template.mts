/**
 * Spec check for the user's outreach template (lib/outreach-template.ts).
 * Costs NOTHING — no Gemini, no network. Run it freely:
 *   npx tsx scripts/check-outreach-template.mts
 */
import { renderFunding, renderOutreachTemplate } from '../lib/outreach-template';
import type { FundingContact, FundingItem } from '../lib/types';

const base: FundingItem = {
  id: 'spec',
  company: 'Vaaree',
  amount: 'Rs 65 Cr',
  round: 'Series A',
  summary: 'Vaaree raised Rs 65 Cr Series A to expand AI and delivery.',
  url: 'https://example.test/vaaree',
  source: 'techcrunch',
  postedAt: new Date().toISOString(),
  status: 'new',
};

const contact = (name: string): FundingContact => ({
  id: 'spec',
  founders: [{ name, title: 'Co-founder' }],
  emails: [{ address: 'a@b.test', foundOn: 'spec' }],
  socials: [],
  foundAt: new Date().toISOString(),
  model: 'spec',
});

let bad = 0;
const check = (label: string, ok: boolean) => {
  if (!ok) {
    console.log(`✗ ${label}`);
    bad++;
  }
};

// --- the raise phrase must stay grammatical in all four combinations ---
check('amount+round', renderFunding({ amount: 'Rs 65 Cr', round: 'Series A' }) === 'Rs 65 Cr in its Series A');
check('amount only', renderFunding({ amount: '$2.6M', round: '' }) === '$2.6M');
check('round only', renderFunding({ amount: '', round: 'Seed' }) === 'its Seed');
check('neither', renderFunding({}) === 'funding');

// --- no founder name → no draft, rather than a degraded "Hi there" ---
check('no founder → null', renderOutreachTemplate(base, null) === null);
check('empty founders → null', renderOutreachTemplate(base, { ...contact('x'), founders: [] }) === null);

// --- first name only, titles stripped ---
const full = renderOutreachTemplate(base, contact('Garima Luthra'));
check('greets first name only', !!full && full.text.startsWith('Hi Garima,'));
check('does not use surname in greeting', !!full && !full.text.startsWith('Hi Garima Luthra'));
const dr = renderOutreachTemplate(base, contact('Dr. Chinmay Bhosale'));
check('strips honorific', !!dr && dr.text.startsWith('Hi Chinmay,'));

// --- the substance the user supplied must survive verbatim ---
const t = full!.text;
for (const phrase of [
  'Saw that Vaaree recently raised Rs 65 Cr in its Series A. Congratulations!',
  '4th-year student at IIT Kharagpur',
  'reduced quote turnaround from 2 hours to 15 minutes',
  '2,000+ sales signals/month across 386 BFSI companies',
  'improving engagement/inquiries by 20%',
  'artist + venue acquisition across 14 cities',
  'raising ₹7.5L+ and reaching 1,000+ colleges',
  "I'm not looking for a narrowly defined internship",
  'Would you be open to a quick 15-minute chat?',
]) {
  check(`contains: ${phrase.slice(0, 46)}`, t.includes(phrase));
}

check('subject is the users', (full!.subject ?? '') === 'Just saw the funding news, would love to help build!');
check('marked as template, not a model', full!.model === 'template:user-v1');
// The 320-char cap applied to the generated draft; this email is deliberately long.
check('long-form email survives', t.length > 900);
// The user asked for no em dashes anywhere: they read as machine-written copy.
check('no em or en dashes', !/[—–]/.test(t));
check('no unreplaced placeholders', !/\{\{|\}\}/.test(t) && !/\{\{/.test(full!.subject ?? ''));

console.log(`\n--- rendered (${t.length} chars) ---\n${t}`);
console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} CHECKS FAILED`);
process.exit(bad === 0 ? 0 : 1);
