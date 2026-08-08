/**
 * Spec check for the founder-outreach draft (`draftOutreach` in lib/funding.ts).
 *
 * The user's instruction, verbatim intent: "reach out to founders of recently funded
 * startups congratulating them on recent funding and asking for an INTERN[ship]".
 * A draft that pitches a full-time role instead is off-spec — and the failure is silent,
 * because the text still reads well. So assert the two load-bearing signals per draft:
 *   1. it references the raise (amount / round / company), and
 *   2. it asks for an internship, not a hire.
 *
 * Real Gemini calls, no email is sent. Run:
 *   npx tsx --env-file=.env.local scripts/check-outreach.mts
 */
import { draftOutreach } from '../lib/funding';
import type { FundingContact, FundingItem } from '../lib/types';

const CASES: Array<{ item: FundingItem; contact?: FundingContact }> = [
  {
    item: {
      id: 'spec-seed-saas',
      company: 'Fernway',
      amount: '$4.2M',
      round: 'Seed',
      summary: 'Fernway raised $4.2M seed to build an AI copilot for warehouse operations teams.',
      url: 'https://techcrunch.com/spec/fernway',
      source: 'techcrunch',
      postedAt: new Date('2026-08-01').toISOString(),
      status: 'new',
    },
    contact: {
      id: 'spec-seed-saas',
      founders: [{ name: 'Maya Iyer', title: 'Co-founder & CEO' }],
      website: 'https://fernway.example',
      emails: [{ address: 'maya@fernway.example', foundOn: 'https://fernway.example/team' }],
      socials: [],
      foundAt: new Date().toISOString(),
      model: 'spec',
    },
  },
  {
    // No named recipient: the prompt must then use no greeting at all.
    item: {
      id: 'spec-series-a-fintech',
      company: 'Ledgerloop',
      amount: '$18M',
      round: 'Series A',
      summary: 'Ledgerloop raised $18M Series A to automate reconciliation for mid-market finance teams.',
      url: 'https://techcrunch.com/spec/ledgerloop',
      source: 'techcrunch',
      postedAt: new Date('2026-08-03').toISOString(),
      status: 'new',
    },
  },
  {
    // Thin row — no amount, no round. The draft must still land without inventing a raise size.
    item: {
      id: 'spec-thin',
      company: 'Kestrel Robotics',
      summary: 'Kestrel Robotics raised an undisclosed round to build autonomous inspection drones.',
      url: 'https://techcrunch.com/spec/kestrel',
      source: 'techcrunch',
      postedAt: new Date('2026-08-06').toISOString(),
      status: 'new',
    },
  },
];

const INTERN_ASK = /\bintern(ship|ing)?\b/i;
const FORBIDDEN = /^(dear\b|hi there|hello there)|[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]|\*\*/iu;

let bad = 0;

for (const { item, contact } of CASES) {
  const raise = [item.amount, item.round, item.company].filter(Boolean) as string[];
  let out;
  try {
    out = await draftOutreach(item, contact);
  } catch (e) {
    console.log(`\n[${item.company}] ✗ threw: ${(e as Error).message}`);
    bad++;
    continue;
  }

  const asksIntern = INTERN_ASK.test(out.text);
  const citesRaise = raise.some((r) => out.text.includes(r));
  const greetingOk = contact?.founders[0]
    ? out.text.startsWith(contact.founders[0].name.split(' ')[0])
      ? false // must be "Hi <first> —", not a bare name
      : new RegExp(`^hi ${contact.founders[0].name.split(' ')[0]}\\b`, 'i').test(out.text)
    : !/^(hi|hey|hello)\b/i.test(out.text);
  const clean = !FORBIDDEN.test(out.text);

  const subject = out.subject ?? '';
  console.log(`\n[${item.company}] angle: ${out.angle}`);
  console.log(`  subject (${subject.length}): ${subject}`);
  console.log(`  text (${out.text.length}): ${out.text}`);
  console.log(
    `  intern-ask ${asksIntern ? '✅' : '❌'} · cites-raise ${citesRaise ? '✅' : '❌'} · ` +
      `greeting ${greetingOk ? '✅' : '❌'} · plain-text ${clean ? '✅' : '❌'}`
  );

  if (!asksIntern || !citesRaise || !greetingOk || !clean) bad++;
}

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad}/${CASES.length} drafts OFF-SPEC`);
process.exit(bad === 0 ? 0 : 1);
