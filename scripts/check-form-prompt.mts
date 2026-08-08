/**
 * Renders the Claude-in-Chrome form-filling prompt and checks the guardrails survive.
 * Free: no network, no model.
 *   npx tsx scripts/check-form-prompt.mts
 */
import { buildFormFillPrompt } from '../lib/form-prompt';

const generic = buildFormFillPrompt();
const targeted = buildFormFillPrompt({
  url: 'https://internshala.com/internship/detail/xyz',
  role: 'Product Management Intern',
  company: 'Acme',
});

let bad = 0;
const check = (label: string, ok: boolean) => {
  if (!ok) {
    console.log(`✗ ${label}`);
    bad++;
  }
};

// The guardrails are the whole point: a browser assistant that submits, or invents a
// credential, is worse than no automation at all.
check('forbids submitting', /DO NOT SUBMIT/.test(generic));
check('names the buttons not to click', /Never click Submit, Apply, Send/i.test(generic));
check('forbids inventing facts', /Never invent a fact/i.test(generic));
check('forbids unlisted claims in free text', /do not claim any skill or number that is not listed/i.test(generic));
check('defers resume upload to the human', /upload a resume, stop and tell me/i.test(generic));
check('asks rather than guesses', /ask me instead of guessing/i.test(generic));
check('reports what it left blank', /fields left blank/i.test(generic));
check('instructs no em dashes', /no em dashes/i.test(generic));
// The prompt must practise what it asks for.
check('prompt itself has no em dashes', !/[—–]/.test(generic));

// Real answers must actually be carried — the browser assistant cannot read this repo.
check('carries name', generic.includes('Shivansh Chaudhary'));
check('carries email', /shivanshchaudhary\.iitkgp@gmail\.com/.test(generic));
check('carries education', /IIT Kharagpur/.test(generic));
check('carries resume evidence', /EVIDENCE I CAN CITE/.test(generic));

// Blank fields in answers.json must not appear as empty labels. Only the "- Label: value"
// bullets are checked: section headers legitimately end in a colon.
const bullets = generic.split('\n').filter((l) => l.startsWith('- '));
check('has bullets at all', bullets.length > 5);
check('drops blank fields', bullets.every((l) => /^- [^:]+: \S/.test(l)));
check('no _comment leakage', !generic.includes('_comment') && !generic.includes('reusable application answers'));

// The targeted variant adds role context; the generic one must not fabricate any.
check('targeted names the role', targeted.includes('Product Management Intern') && targeted.includes('Acme'));
check('generic has no THIS APPLICATION block', !generic.includes('THIS APPLICATION:'));

console.log(`\n--- generic prompt (${generic.length} chars) ---\n${generic}`);
console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} CHECKS FAILED`);
process.exit(bad === 0 ? 0 : 1);
