/**
 * Lists every group this linked device can see, so WA_GROUPS can be set to real
 * substrings instead of guesses. Prints the name, whether the current WA_GROUPS
 * would watch it, and exits — it never enqueues or POSTs anything.
 *
 * Run AFTER pairing (it reuses the same auth dir as the bridge):
 *   npm run groups
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import makeWASocket, { useMultiFileAuthState, fetchLatestBaileysVersion, Browsers } from 'baileys';
import pino from 'pino';

const HERE = dirname(fileURLToPath(import.meta.url));

/** Same minimal reader as index.mjs — five keys don't warrant a dependency. */
function loadDotEnv(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m) continue;
    const value = m[2].replace(/^["']|["']$/g, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}

loadDotEnv(resolve(HERE, '.env'));

const AUTH_DIR = process.env.AUTH_DIR || resolve(HERE, 'auth');
const GROUP_FILTERS = (process.env.WA_GROUPS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

function watched(name) {
  if (GROUP_FILTERS.length === 0) return true;
  const lower = name.toLowerCase();
  return GROUP_FILTERS.some((f) => lower.includes(f));
}

const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
if (!state.creds?.registered) {
  console.error('[groups] not paired yet — run `npm start` and scan the QR first.');
  process.exit(1);
}

const { version } = await fetchLatestBaileysVersion();
const sock = makeWASocket({
  version,
  auth: state,
  logger: pino({ level: process.env.LOG_LEVEL || 'silent' }),
  browser: Browsers.ubuntu('Chrome'),
  markOnlineOnConnect: false,
  syncFullHistory: false,
});

sock.ev.on('creds.update', saveCreds);

// Give up rather than hang forever if the socket never opens.
const bail = setTimeout(() => {
  console.error('[groups] timed out waiting for connection.');
  process.exit(1);
}, 60_000);

sock.ev.on('connection.update', async ({ connection, lastDisconnect }) => {
  if (connection === 'close') {
    // A 515 stream-restart right after pairing is normal; anything else is fatal here.
    const status = lastDisconnect?.error?.output?.statusCode;
    console.error(`[groups] disconnected (${status ?? 'unknown'}) — re-run this command.`);
    process.exit(1);
  }
  if (connection !== 'open') return;

  try {
    const all = await sock.groupFetchAllParticipating();
    const groups = Object.values(all)
      .map((g) => g.subject || g.id)
      .sort((a, b) => a.localeCompare(b));

    clearTimeout(bail);

    if (groups.length === 0) {
      console.log('\n[groups] this account is in no groups yet.\n');
    } else {
      const hits = groups.filter(watched);
      console.log(`\n[groups] ${groups.length} group(s) visible to this device:\n`);
      for (const name of groups) console.log(`  ${watched(name) ? '✅' : '  '} ${name}`);
      console.log(
        GROUP_FILTERS.length
          ? `\nWA_GROUPS=${GROUP_FILTERS.join(',')} → watching ${hits.length}/${groups.length}.` +
              (hits.length === 0 ? ' Nothing matches — edit .env.' : '')
          : `\nWA_GROUPS is empty → watching ALL ${groups.length}.`
      );
      console.log('Filters are case-insensitive substrings of the names above.\n');
    }
  } catch (e) {
    console.error(`[groups] failed to fetch groups: ${e.message}`);
    process.exit(1);
  }
  process.exit(0);
});
