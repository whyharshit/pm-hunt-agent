/**
 * Spec for LinkedIn's connections export (lib/linkedin-csv.ts). Free — no network, no Redis.
 *   npx tsx scripts/check-linkedin-csv.mts
 *
 * WHY THIS IS THE TRACKER'S REAL INPUT. The design started from "read the acceptance email",
 * which is the only machine-readable signal LinkedIn emits — except that on 2026-08-22 the user
 * sent two invitations, both friends accepted, and NO EMAIL WAS SENT AT ALL. Only phone
 * notifications, which leave no trace. LinkedIn emails that category only when its email channel
 * is enabled, and for app users it is off; a forward set up the day before forwarded nothing,
 * because there was nothing to forward.
 *
 * The export is what remains, and it is better: per person, with the date the connection was
 * made, straight from LinkedIn, no scraping and no session cookie.
 *
 * ⚠️ THE FILE DOES NOT START WITH ITS HEADER, and that is the trap this file mostly guards. A
 * real export opens with a "Notes:" preamble and a quoted paragraph FULL OF COMMAS. Parse from
 * line 1 and the disclaimer becomes a person named "When exporting your connection data".
 */
import { parseConnectedOn, parseConnectionsCsv } from '../lib/linkedin-csv';

let bad = 0;
const check = (label: string, ok: boolean, detail = '') => {
  if (!ok) {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    bad++;
  } else {
    console.log(`  ✓ ${label}`);
  }
};

// A real export, preamble and all.
const REAL = `Notes:
"When exporting your connection data, you may notice that some of the email addresses are missing. You will only see email addresses for connections who have chosen to display them."


First Name,Last Name,URL,Email Address,Company,Position,Connected On
Aayush,Jain,https://www.linkedin.com/in/aayushjain,,Rovia,Founder,21 Aug 2026
Fathima,Sajid,https://www.linkedin.com/in/fathimasajid,fathima@example.com,"Acme, Inc.","Talent Partner, India",20 Aug 2026
Priya,Nair,https://www.linkedin.com/in/priyanair,,Zomato,"Product Manager",02 Jan 2024
`;

console.log('\n--- a real export, preamble and all ---');
const parsed = parseConnectionsCsv(REAL);
check('no error', !parsed.error, parsed.error);
check('three people, not five lines of disclaimer', parsed.rows.length === 3, String(parsed.rows.length));
check(
  'the disclaimer is not read as a person',
  !parsed.rows.some((r) => /when exporting/i.test(r.name)),
  parsed.rows.map((r) => r.name).join(' | ')
);
check('first and last name are joined', parsed.rows[0]?.name === 'Aayush Jain', parsed.rows[0]?.name);
check(
  'the connection date is the day LinkedIn stated',
  parsed.rows[0]?.connectedOn === '2026-08-21T00:00:00.000Z',
  parsed.rows[0]?.connectedOn
);
check('the profile URL comes across', parsed.rows[0]?.profileUrl === 'https://www.linkedin.com/in/aayushjain');
check('position and company become the note material', parsed.rows[0]?.company === 'Rovia');

console.log('\n--- ⚠️ commas inside quoted fields ---');
// "Acme, Inc." and "Talent Partner, India" are exactly what a naive comma split gets wrong: every
// later column shifts, so the DATE column ends up holding a job title and the row is dropped.
const fathima = parsed.rows[1];
check('the company keeps its comma', fathima?.company === 'Acme, Inc.', fathima?.company);
check('the position keeps its comma', fathima?.position === 'Talent Partner, India', fathima?.position);
check(
  'and the date column is still the date',
  fathima?.connectedOn === '2026-08-20T00:00:00.000Z',
  fathima?.connectedOn
);

console.log('\n--- every date shape LinkedIn has used ---');
const DATES: Array<[string, string | null]> = [
  ['21 Aug 2026', '2026-08-21T00:00:00.000Z'],
  ['02 Jan 2024', '2024-01-02T00:00:00.000Z'],
  ['21-Aug-2026', '2026-08-21T00:00:00.000Z'],
  ['Aug 21, 2026', '2026-08-21T00:00:00.000Z'],
  ['2026-08-21', '2026-08-21T00:00:00.000Z'],
  ['8/21/2026', '2026-08-21T00:00:00.000Z'],
  ['8/21/26', '2026-08-21T00:00:00.000Z'],
  // ⚠️ AND THE ONES THAT MUST FAIL RATHER THAN GUESS. A row dated today because its date was
  // unreadable would claim the connection was made on import day.
  ['', null],
  ['not a date', null],
  ['31 Feb 2026', null],
  ['21 Foo 2026', null],
];
for (const [input, want] of DATES) {
  const got = parseConnectedOn(input);
  check(`"${input || '(empty)'}" -> ${want ?? 'null'}`, got === want, String(got));
}

console.log('\n--- rows that cannot be used are reported, never invented ---');
const MESSY = `First Name,Last Name,URL,Email Address,Company,Position,Connected On
,,https://www.linkedin.com/in/nobody,,,,21 Aug 2026
Broken,Date,https://www.linkedin.com/in/broken,,,,sometime last year
Fine,Person,https://www.linkedin.com/in/fine,,,,21 Aug 2026
`;
const messy = parseConnectionsCsv(MESSY);
check('the usable row survives', messy.rows.length === 1 && messy.rows[0].name === 'Fine Person');
check('both bad rows are reported', messy.skipped.length === 2, JSON.stringify(messy.skipped));
check(
  'and the reasons say which is which',
  messy.skipped.some((s) => s.why === 'no name') &&
    messy.skipped.some((s) => s.why.startsWith('unreadable date')),
  JSON.stringify(messy.skipped)
);

console.log('\n--- the wrong file entirely ---');
for (const [label, text] of [
  ['an empty file', ''],
  ['some other CSV', 'a,b,c\n1,2,3\n'],
  ['a LinkedIn messages export', 'CONVERSATION ID,CONVERSATION TITLE,FROM,DATE\nx,y,z,2026-08-21\n'],
  ['prose', 'hello there\n'],
] as const) {
  const r = parseConnectionsCsv(text);
  check(`${label} is refused with a reason`, r.rows.length === 0 && Boolean(r.error), r.error ?? 'no error given');
}
check(
  'a header with no Connected On column is refused too',
  Boolean(parseConnectionsCsv('First Name,Last Name,URL\nA,B,c\n').error)
);

console.log('\n--- shapes that must not break it ---');
const CRLF = REAL.replace(/\n/g, '\r\n');
check('CRLF line endings parse the same', parseConnectionsCsv(CRLF).rows.length === 3);
const REORDERED = `Connected On,Position,Company,URL,Last Name,First Name
21 Aug 2026,Founder,Rovia,https://www.linkedin.com/in/aayushjain,Jain,Aayush
`;
const reordered = parseConnectionsCsv(REORDERED);
check(
  'columns are matched by NAME, not by position',
  reordered.rows[0]?.name === 'Aayush Jain' &&
    reordered.rows[0]?.connectedOn === '2026-08-21T00:00:00.000Z',
  JSON.stringify(reordered.rows[0])
);
check(
  'a header row alone yields nothing and no error',
  (() => {
    const r = parseConnectionsCsv('First Name,Last Name,URL,Email Address,Company,Position,Connected On\n');
    return r.rows.length === 0 && !r.error;
  })()
);

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} CHECKS FAILED`);
process.exit(bad === 0 ? 0 : 1);
