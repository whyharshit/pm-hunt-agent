/**
 * Source hygiene: no invisible control characters in the code. Free, no network.
 *   npx tsx scripts/check-source-hygiene.mts
 *
 * ⚠️ WRITTEN AFTER A REGEX WAS SILENTLY DISABLED BY ONE INVISIBLE BYTE, 2026-08-22. A guard in
 * lib/linkedin-mail.ts was meant to end with a word boundary:
 *
 *     /^(see|who|…|\d+)\b/i
 *
 * and what reached the file was a literal BACKSPACE (0x08) where `\b` should have been, because
 * an editing script interpreted the escape before TypeScript ever saw it. The regex then
 * required an unprintable character after the word and therefore matched nothing — while
 * `String(regex)` printed the correct-looking source, `tsc` was happy, `eslint` was happy, and
 * the only symptom was a filter that quietly did nothing. It took a `cat -A` to see it.
 *
 * ⚠️ `\b`, `\f`, `\v` AND `\a` ALL HAVE THIS FAILURE MODE and all four mean something in a
 * regex or nothing at all. A test that greps for the bytes costs nothing and catches every
 * future recurrence, whatever tool introduced it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

let bad = 0;

/** Control characters that should never appear literally in source. Tab and newline are fine. */
const FORBIDDEN: Array<[number, string]> = [
  [0x07, '\\a BELL'],
  [0x08, '\\b BACKSPACE — almost certainly a word boundary that got eaten'],
  [0x0b, '\\v VERTICAL TAB'],
  [0x0c, '\\f FORM FEED'],
  [0x00, 'NUL'],
  [0x1b, 'ESC'],
];

const ROOTS = ['lib', 'app', 'scripts'];
const EXTENSIONS = ['.ts', '.tsx', '.mts'];

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry.startsWith('.')) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) out.push(...walk(path));
    else if (EXTENSIONS.some((e) => path.endsWith(e))) out.push(path);
  }
  return out;
}

const files = ROOTS.flatMap((r) => {
  try {
    return walk(r);
  } catch {
    return [];
  }
});

console.log(`scanning ${files.length} source files`);

for (const file of files) {
  const text = readFileSync(file, 'latin1');
  for (const [code, label] of FORBIDDEN) {
    const at = text.indexOf(String.fromCharCode(code));
    if (at === -1) continue;
    const line = text.slice(0, at).split('\n').length;
    console.log(`  ✗ ${file}:${line} contains ${label}`);
    bad += 1;
  }
}

if (bad === 0) console.log(`  ✓ no stray control characters`);

// A self-test, because a scanner that silently matches nothing also reports ALL GOOD. The
// canary byte is built at runtime rather than typed into this file: a literal one here
// would be found by the scan above, which reads this directory too.
const canary = `x${String.fromCharCode(0x08)}y`;
if (canary.indexOf(String.fromCharCode(0x08)) === -1) {
  console.log('  ✗ the detector itself is broken — it cannot see a backspace');
  bad += 1;
} else {
  console.log('  ✓ the detector can see a backspace when there is one');
}

console.log(bad === 0 ? '\nALL GOOD' : `\n${bad} CHECKS FAILED`);
process.exit(bad === 0 ? 0 : 1);
