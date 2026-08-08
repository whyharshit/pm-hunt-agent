/**
 * Spec for the two guards that decide WHO an outreach email goes to
 * (lib/contact.ts). Free — no network, no Gemini.
 *   npx tsx scripts/check-recipient-match.mts
 *
 * Every "must reject" case below is real: on 2026-08-08 all five were queued to send with
 * the email opening "Hi <founder first name>," while addressed to a shared inbox.
 */
import { addressLooksLikePerson, isGenericEmail } from '../lib/contact';

let bad = 0;
const check = (label: string, ok: boolean) => {
  if (!ok) {
    console.log(`✗ ${label}`);
    bad++;
  }
};

// --- shared inboxes that shipped as "person-reachable" before this fix ---
for (const a of [
  'care@rideriver.com',
  'connect@consint.ai',
  'booking@weroad.com',
  'info@inforcer.com',
  'agent@db.usenaive.com',
  'hello@x.com',
  'contact@x.com',
  'support@x.com',
  'careers@x.com',
  'partnerships@x.com',
  'no-reply@x.com',
  'media@x.com',
]) {
  check(`generic: ${a}`, isGenericEmail(a));
}

// --- real personal addresses must NOT be dismissed as shared ---
for (const a of [
  'sidd@malachyte.com',
  'garima@vaaree.com',
  'thanh.dang@conmeet.io',
  'hannaroos@aavalynx.ai',
  'pmizera@omilia.com',
]) {
  check(`personal: ${a}`, !isGenericEmail(a));
}

// --- the positive check: does this address belong to the person being greeted? ---
const pairs: Array<[string, string, boolean]> = [
  ['sidd@malachyte.com', 'Sidd Motwani', true],
  ['garima@vaaree.com', 'Garima Luthra', true],
  ['thanh.dang@conmeet.io', 'Thanh Dang', true],
  ['hannaroos@aavalynx.ai', 'Hanna Roos', true],
  ['pmizera@omilia.com', 'Petr Mizera', true], // initial + surname
  ['g.luthra@vaaree.com', 'Garima Luthra', true],
  ['chinmay@nyai.ai', 'Dr. Chinmay Bhosale', true], // honorific stripped
  // The failures this exists to stop — a shared inbox that no denylist could enumerate.
  ['care@rideriver.com', 'Aravind Mani', false],
  ['booking@weroad.com', 'Paolo De Nadai', false],
  ['connect@consint.ai', 'Ashish Chaturvedi', false],
  ['desk@studio.com', 'Priya Sharma', false],
  ['hola@startup.mx', 'Juan Perez', false],
  // Right company, wrong human.
  ['sahil.kapoor@vaaree.com', 'Garima Luthra', false],
];
for (const [address, person, expected] of pairs) {
  check(
    `${expected ? 'belongs' : 'NOT'}: ${address} ↔ ${person}`,
    addressLooksLikePerson(address, person) === expected
  );
}

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} CHECKS FAILED`);
process.exit(bad === 0 ? 0 : 1);
