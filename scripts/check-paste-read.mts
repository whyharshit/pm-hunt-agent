/**
 * Spec for reading the poster and company OUT OF a pasted post (lib/paste-read.ts). Free —
 * no network, no Redis.
 *   npx tsx scripts/check-paste-read.mts
 *
 * The user's ask, 2026-08-26: "in paste a post the agent should pickup company name and
 * person who have posted automatically rather than me typing it." A post copied from
 * LinkedIn carries the author block (name — often twice — headline, "• 2nd", "2d • Edited"),
 * which nobody typed on purpose and which IS the answer.
 *
 * ⚠️ THE ASYMMETRY THIS FILE GUARDS: the poster name gets GREETED in an email and the
 * company gets interpolated into two of its sentences. A missed read costs the user one
 * typed field, exactly what they pay today; a wrong read mails a stranger "Hi We Are," or
 * names the wrong employer. So every positive pin here has a structural signal behind it,
 * and the negative pins are the ones that matter most.
 */
import { autofillPaste, personName, readPastedPost } from '../lib/paste-read';

let bad = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    bad++;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

console.log('\n--- a web copy: duplicated name, degree, headline, timestamp ---');
const WEB = `Ananya Rao
Ananya Rao
 • 2nd
Talent Partner at Acme Labs | Hiring PMs
2d • Edited •
We're hiring at Acme Labs — Product Intern.
Apply: careers@acmelabs.com`;
const web = readPastedPost(WEB);
check('the poster is the duplicated name', web.poster === 'Ananya Rao', web.poster);
check(
  'the profile headline is captured for companyOf',
  web.posterHeadline.startsWith('Talent Partner at Acme Labs'),
  web.posterHeadline
);
check('the body starts at the post, not the header', web.body.startsWith("We're hiring"), web.body.slice(0, 40));
check('the header is gone from the body', !web.body.includes('• 2nd'));
const webFill = autofillPaste({ text: WEB });
check('the company is read out of the post', webFill.company === 'Acme Labs', webFill.company);
check('and flagged as read, not typed', webFill.companyRead && webFill.posterRead);

console.log('\n--- typed values always win over the read ---');
const typed = autofillPaste({ text: WEB, company: 'Typed Co', poster: 'Typed Person' });
check('typed company passes through', typed.company === 'Typed Co', typed.company);
check('typed poster passes through', typed.poster === 'Typed Person', typed.poster);
check('and neither is flagged as read', !typed.companyRead && !typed.posterRead);

console.log('\n--- a mobile copy: no duplicate, pronouns on the name, headline names the employer ---');
const MOBILE = `Rohit Menon (He/Him)
Talent Acquisition at BrightPay
3w •
Our team is growing. Looking for a Product Intern in Mumbai. DM me.`;
const mob = readPastedPost(MOBILE);
check('the pronoun parenthetical is stripped', mob.poster === 'Rohit Menon', mob.poster);
const mobFill = autofillPaste({ text: MOBILE });
check(
  'the company comes from the recruiter headline when the post never names one',
  mobFill.company === 'BrightPay',
  mobFill.company
);

console.log('\n--- ⚠️ a plain paste with no header must NOT invent a poster ---');
const PLAIN = `Acme Labs is hiring a Product Intern in Bangalore.
Send your CV to hr@acmelabs.com`;
const plain = readPastedPost(PLAIN);
check('no poster', plain.poster === '', plain.poster);
check('the body is untouched', plain.body === PLAIN);
const plainFill = autofillPaste({ text: PLAIN });
check('but the company still reads out of the words', plainFill.company === 'Acme Labs', plainFill.company);

console.log('\n--- ⚠️ a capitalised first line ALONE is never a poster ---');
// This is a real shape the reader deliberately declines: without furniture or a duplicate
// there is no way to tell a name from a headline, and a wrong poster gets greeted.
const BARE = `Priya Nair
We are looking for a design intern to join our studio.
More details soon.`;
const bare = readPastedPost(BARE);
check('declined without a structural signal', bare.poster === '' && bare.body === BARE, bare.poster);

console.log('\n--- ⚠️ "We Are Hiring" and friends are not people ---');
check('We Are Hiring', personName('We Are Hiring') === '');
check('Urgent Opening', personName('Urgent Opening') === '');
check('Job Alert', personName('Job Alert') === '');
check('Product Internship', personName('Product Internship') === '');
check('a real name still reads', personName('Aayush Jain') === 'Aayush Jain');
check('a name with a suffix keeps only the name', personName('Ananya Rao, MBA') === 'Ananya Rao');

console.log('\n--- a company PAGE copy: the author IS the employer, and nobody is greeted ---');
const PAGE = `Zynetic
Zynetic
12,458 followers
1w •
Company: Zynetic
Role: Product Intern
Apply at careers@zynetic.in`;
const page = readPastedPost(PAGE);
check('the followers line marks it a page, not a person', page.pageCompany === 'Zynetic', page.pageCompany);
check('so there is no poster to greet', page.poster === '');
const pageFill = autofillPaste({ text: PAGE });
check('and the page name becomes the company', pageFill.company === 'Zynetic', pageFill.company);
check('with no poster invented', pageFill.poster === '');

console.log('\n--- a reshare: the banner belongs to the resharer, the author follows ---');
const RESHARE = `Shivansh Chaudhary reposted this
Kajol Sharma
Kajol Sharma
 • 2nd
Hiring for Product roles at Euronet
5h •
We're hiring at Euronet! Product Manager – Prepaid Cards.`;
const re = readPastedPost(RESHARE);
check('the author, not the resharer, is the poster', re.poster === 'Kajol Sharma', re.poster);
const reFill = autofillPaste({ text: RESHARE });
check('and the company reads out of the post', reFill.company === 'Euronet', reFill.company);

console.log('\n--- ⚠️ the poster must never become the company ---');
// "Kajol is hiring!" matches companyOf's trailer shape, and the whole point of the poster
// pass-through is that that answer is the wrong one (the Fathima Sajid bug, 2026-08-20).
const SELF = `Kajol
Kajol
 • 1st
Recruiter
4d •
Kajol is hiring! DM me for a product intern role.`;
const selfFill = autofillPaste({ text: SELF });
check('the poster is read', selfFill.poster === 'Kajol', selfFill.poster);
check('the company stays empty rather than becoming the poster', selfFill.company === '', selfFill.company);

console.log('\n--- ⚠️ digits that are not timestamps do not fake a header ---');
const COUNTS = `Priya Nair
3 openings
Apply now`;
const counts = readPastedPost(COUNTS);
check('"3 openings" is not read as "3 minutes"', counts.poster === '' && counts.body === COUNTS, counts.poster);

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} CHECK(S) FAILED`);
process.exit(bad === 0 ? 0 : 1);
