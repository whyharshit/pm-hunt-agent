/**
 * WhatsApp matcher contract check — run with:  npx tsx scripts/check-whatsapp-match.mts
 *
 * Sibling of check-filters.mts. Group posts are free text with no title field, so
 * lib/whatsapp/match.ts reconstructs a role line and anchors on that. The posts below
 * ARE the spec for what the bridge is allowed to auto-track — they are written in the
 * shapes these groups actually use (labelled blocks, emoji headers, bulk multi-role
 * dumps, one-liners). Update them when the goal changes.
 */
import { matchWhatsappPost } from '../lib/whatsapp/match';

type Case = { name: string; text: string };

// Real-shaped posts the agent MUST pick up.
const shouldMatch: Case[] = [
  {
    name: 'labelled block, form link',
    text: `*Hiring Alert*
Role: Product Management Intern
Company: Acme Labs
Location: Remote
Stipend: 25k/month
Apply: https://forms.gle/abc123`,
  },
  {
    name: 'emoji header, email apply',
    text: `🚨 INTERNSHIP OPENING 🚨
Founder's Office Intern
Fully remote · 6 months
Share your CV at careers@acme.io`,
  },
  {
    name: 'one-liner with DM ask',
    text: `We are hiring a Business Operations Intern (work from home). DM me your resume.`,
  },
  {
    name: 'bulk post — target role listed beside rejected ones',
    text: `Openings: Software Engineer Intern, Product Intern, Graphic Designer
Location: Remote
Apply: https://boards.greenhouse.io/acme/jobs/1`,
  },
  {
    name: 'signals split across the role line',
    text: `Hiring for: Internship — Product & Strategy
Remote role, apply at https://jobs.lever.co/acme/xyz`,
  },
  {
    name: 'chief of staff (the bug check-filters caught, in WhatsApp shape)',
    text: `Position: Chief of Staff
Company: Acme
Mode: Remote
Mail hr@acme.io`,
  },
  {
    name: 'APM with company label that would trip a naive reject',
    text: `Role: APM Intern
Company: Lead Squared
Location: Work from home
https://forms.gle/xyz`,
  },
  // Data / VC / AI — added 2026-08-05, same decision as check-filters.mts.
  {
    name: 'data analyst intern (channel-post shape)',
    text: `📊 Data Analyst Intern
Company: Acme Fintech
Stipend: 20k · Remote
Apply: https://forms.gle/data123`,
  },
  {
    name: 'VC intern, email apply',
    text: `Venture Capital Intern needed at an early-stage fund.
Remote friendly. Send your CV to talent@fund.vc`,
  },
  {
    name: 'AI research intern one-liner',
    text: `We're hiring an AI Research Intern (work from home) — DM me your resume.`,
  },
  // Software engineering — added 2026-08-07, same decision as check-filters.mts. Both
  // of these were shouldReject cases until that date ("engineering stays dead"); the
  // user reversed that, so SWE channel posts are now real matches.
  {
    name: 'SWE intern (channel-post shape)',
    text: `Role: Software Engineer Intern
Company: Acme
Remote
https://forms.gle/abc`,
  },
  {
    name: 'ML engineer intern',
    text: `Machine Learning Engineer Intern
Company: Acme AI
Remote
https://forms.gle/mle1`,
  },
  // On-site India product roles — added 2026-08-18. The first of these was a
  // shouldREJECT case ("onsite product intern - no remote signal") until that date, and
  // it is moved here for the same reason the SWE pair above moved: the user reversed the
  // decision. They asked for on-site and hybrid product internships in India on
  // 2026-08-17 and `passes()` was changed that day, but this matcher kept its own copy of
  // the old absolute remote rule and went on killing these posts one layer upstream.
  {
    name: 'on-site product intern in India (was a reject case until 2026-08-18)',
    text: `Role: Product Intern
Company: Acme
Location: Bengaluru, in-office
Apply: https://forms.gle/abc`,
  },
  {
    name: "founder's office intern, on-site Gurugram",
    text: `Hiring: Founder's Office Intern
Gurugram · 6 months · stipend 30k
Mail your CV to hiring@acme.in`,
  },
];

// Posts that MUST NOT be auto-tracked.
const shouldReject: Case[] = [
  {
    name: 'senior product role',
    text: `Hiring: Senior Product Manager
Remote
Apply https://jobs.lever.co/acme/pm`,
  },
  {
    name: 'body merely mentions the words (the broad-text trap)',
    text: `Role: Video Editor
Company: Acme
You will work closely with our product and growth team, internship culture, remote.
Apply: https://forms.gle/abc`,
  },
  {
    name: 'designer intern',
    text: `Product Designer Intern
Remote
DM me`,
  },
  {
    name: 'head of product',
    text: `Opening: Head of Product
Remote-first company
careers@acme.io`,
  },
  // The two halves of the on-site allowance, each pinned against the obvious drift.
  // Without these, "on-site product roles in India" reads to a later editor like a
  // general invitation to drop the remote gate.
  {
    name: 'on-site SWE intern in India — product-only, so still rejected',
    text: `Role: Software Engineer Intern
Company: Acme
Location: Bengaluru, in-office
Apply: https://forms.gle/swe1`,
  },
  {
    name: 'on-site product intern OUTSIDE India — India-only, so still rejected',
    text: `Role: Product Intern
Company: Acme
Location: Berlin, in-office
Apply: https://forms.gle/berlin1`,
  },
  {
    name: 'not a job post at all',
    text: `Good morning everyone 🙏 please share this group with your friends looking for opportunities`,
  },
  {
    name: 'sales role',
    text: `Hiring: Business Development Executive
Work from home
Send CV to hr@acme.io`,
  },
  {
    name: 'data ENTRY intern (near-miss for the new data patterns)',
    text: `Role: Data Entry Intern
Remote work
Apply: https://forms.gle/entry1`,
  },
];

let bad = 0;

console.log('--- MUST MATCH ---');
for (const c of shouldMatch) {
  const m = matchWhatsappPost(c.text);
  if (!m.matched) bad++;
  console.log(
    `${m.matched ? '  ok  ' : ' MISS '} ${c.name}\n         role="${m.roleLine}"${
      m.matched ? ` → matched "${m.matchedRole}"` : ` → ${m.reasons.join('; ')}`
    }`
  );
}

console.log('\n--- MUST REJECT ---');
for (const c of shouldReject) {
  const m = matchWhatsappPost(c.text);
  if (m.matched) bad++;
  console.log(
    `${!m.matched ? '  ok  ' : ' LEAK '} ${c.name}\n         role="${m.roleLine}" → ${
      m.matched ? `matched "${m.matchedRole}"` : m.reasons.join('; ')
    }`
  );
}

// Apply-target extraction is what decides tracked-URL vs lead — assert it directly.
console.log('\n--- APPLY TARGETS ---');
const targets = matchWhatsappPost(shouldMatch[1].text);
const targetsOk =
  targets.urls.length === 0 && targets.emails.includes('careers@acme.io') && targets.hasDmAsk;
if (!targetsOk) bad++;
console.log(
  `${targetsOk ? '  ok  ' : ' FAIL '} email-only post → urls=${targets.urls.length} emails=${JSON.stringify(
    targets.emails
  )} dmAsk=${targets.hasDmAsk}`
);

const linked = matchWhatsappPost(shouldMatch[0].text);
const linkedOk = linked.urls.includes('https://forms.gle/abc123');
if (!linkedOk) bad++;
console.log(`${linkedOk ? '  ok  ' : ' FAIL '} link post → urls=${JSON.stringify(linked.urls)}`);

console.log(`\n${bad === 0 ? 'ALL GOOD' : `${bad} FAILURES`}`);
process.exit(bad === 0 ? 0 : 1);
