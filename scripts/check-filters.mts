/**
 * Filter contract check — run with:  npx tsx scripts/check-filters.mts
 *
 * lib/filters.ts is the subtlest logic in the repo: too loose and the dashboard fills
 * with Video Editors, too tight and it silently eats real targets (a stray /\bstaff\b/
 * hard-reject swallowed every "Chief of Staff" posting until this check caught it).
 * The lists below ARE the spec for which roles count. Update them when the goal changes.
 */
import { passes } from '../lib/filters';
import type { Job } from '../lib/types';

const base = {
  id: 'x',
  source: 'remoteok' as const,
  company: 'Acme',
  location: 'Remote',
  url: 'https://x.test',
  postedAt: new Date(),
  tags: [] as string[],
  description: 'We are hiring. Work from anywhere.',
};
const j = (title: string, over: Partial<Job> = {}): Job => ({ ...base, title, ...over });

// Roles the user actually wants — these MUST pass.
const shouldPass: Job[] = [
  j('Product Manager Intern'),
  j('Associate Product Manager (APM)'),
  j('Founder\'s Office Intern'),
  j('Business Operations Intern'),
  j('Chief of Staff'),
  j('Growth Intern'),
  j('Strategy Intern'),
  j('APM Intern'),
  j('Graduate Program - Product'),
  j('Product Operations Trainee'),
  j('Partnerships Intern'),
  j('Go-To-Market Intern'),
  // Data / VC / AI — added 2026-08-05 by explicit user decision.
  j('Data Analyst Intern'),
  j('Data Science Intern'),
  j('Analytics Intern'),
  j('Business Intelligence Trainee'),
  j('Venture Capital Intern'),
  j('VC Analyst Intern'),
  j('Investment Analyst Intern'),
  j('AI Research Intern'),
  j('Machine Learning Intern'),
  j('GenAI Intern'),
];

// The false positives + off-target roles — these MUST NOT pass.
const shouldReject: Job[] = [
  j('Video Editor', { description: 'Join our growth team as an intern-friendly editor.' }),
  j('Customer Service Representative', { description: 'product-focused internship culture' }),
  j('Social Media Coordinator', { description: 'growth and operations internship' }),
  j('KYC Analyst', { description: 'graduate program, work with product ops' }),
  j('Entry Level Administrative Professional Operations & Office Support'),
  j('Senior Product Manager'),
  j('Software Engineer Intern'),
  j('Head of Product'),
  j('Product Designer Intern'),
  j('Product Manager Intern', { location: 'New York, onsite', description: 'Onsite only.', tags: [] }),
  // Data/VC/AI near-misses that must stay dead.
  j('Data Entry Intern'),
  j('Data Engineer Intern'),
  j('AI Engineer Intern'),
  j('Machine Learning Engineer Intern'),
  j('Senior Data Analyst'),
  j('AI Content Writer Intern'),
];

let bad = 0;
console.log('--- MUST PASS ---');
for (const x of shouldPass) {
  const ok = passes(x);
  if (!ok) bad++;
  console.log(`${ok ? '  ok  ' : ' MISS '} ${x.title}`);
}
console.log('\n--- MUST REJECT ---');
for (const x of shouldReject) {
  const ok = passes(x);
  if (ok) bad++;
  console.log(`${!ok ? '  ok  ' : ' LEAK '} ${x.title}`);
}
console.log(`\n${bad === 0 ? 'ALL GOOD' : `${bad} FAILURES`}`);
