/**
 * WhatsApp → intern-agent bridge.
 *
 * Pairs as a LINKED DEVICE on your personal WhatsApp (same mechanism as WhatsApp Web),
 * watches the job groups AND channels you allowlist, and POSTs candidate postings to the
 * agent's /api/whatsapp/ingest endpoint. It only ever reads; it never sends a message,
 * never joins a group, and never applies to anything.
 *
 * This runs OUTSIDE Vercel on purpose: it needs a long-lived socket and on-disk auth
 * state, neither of which a serverless function has. Any always-on box works.
 *
 * Read bridge/README.md before running — this uses an unofficial client library and
 * carries a real WhatsApp ban risk. That trade-off was made deliberately.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import makeWASocket, {
  DisconnectReason,
  extractMessageContent,
  fetchLatestBaileysVersion,
  isJidGroup,
  isJidNewsletter,
  useMultiFileAuthState,
  Browsers,
} from 'baileys';
import pino from 'pino';
import qrcode from 'qrcode-terminal';

const HERE = dirname(fileURLToPath(import.meta.url));

// --- config -----------------------------------------------------------------

loadDotEnv(resolve(HERE, '.env'));

const INGEST_URL = required('INGEST_URL');
const INGEST_SECRET = required('INGEST_SECRET');
const AUTH_DIR = process.env.AUTH_DIR || resolve(HERE, 'auth');
/** Comma-separated case-insensitive substrings of group/channel names. Empty = all. */
const GROUP_FILTERS = (process.env.WA_GROUPS || '')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const BATCH_SECONDS = Number(process.env.BATCH_SECONDS || 20);
/** Must not exceed the server's MAX_BATCH (200) or the POST is rejected wholesale. */
const MAX_BATCH = Math.min(Number(process.env.MAX_BATCH || 100), 200);
/** Bound on the retry backlog so a long outage can't eat memory. */
const MAX_QUEUE = 2000;

/**
 * Bandwidth gate ONLY. The real relevance spec lives server-side in
 * lib/whatsapp/match.ts — this exists so "good morning everyone 🙏" never leaves the
 * box. It must stay strictly BROADER than the server matcher: anything it drops, the
 * server never gets to judge. When in doubt, let it through.
 */
const JOBISH_RE =
  /\b(hiring|hire|intern|internship|opening|openings|vacancy|vacancies|recruit\w*|apply|applications?\s+open|job|role|position|stipend|fresher|walk[-\s]?in|placement|opportunity|opportunities)\b/i;

const logger = pino({ level: process.env.LOG_LEVEL || 'warn' });

// --- state ------------------------------------------------------------------

/** jid → group subject, so we don't re-query metadata per message. */
const groupNames = new Map();
/** Pending messages awaiting the next flush, plus anything a failed POST put back. */
let queue = [];
let flushing = false;
let reconnectDelay = 2000;

// --- helpers ----------------------------------------------------------------

function required(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`[bridge] ${name} is not set. Copy .env.example to .env and fill it in.`);
    process.exit(1);
  }
  return v;
}

/** Minimal .env reader — not worth a dependency for five keys. */
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

/** Pull readable text out of whatever message shape WhatsApp sent. */
function textOf(msg) {
  const content = extractMessageContent(msg.message);
  if (!content) return '';
  return (
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    content.documentMessage?.caption ||
    ''
  );
}

async function groupName(sock, jid) {
  const cached = groupNames.get(jid);
  if (cached) return cached;
  try {
    // Channels ("newsletters") have no groupMetadata — their name lives in
    // newsletter metadata instead. Same cache either way.
    const name = isJidNewsletter(jid)
      ? (await sock.newsletterMetadata('jid', jid))?.name || jid
      : (await sock.groupMetadata(jid))?.subject || jid;
    groupNames.set(jid, name);
    return name;
  } catch {
    return jid;
  }
}

function watched(name) {
  if (GROUP_FILTERS.length === 0) return true;
  const lower = name.toLowerCase();
  return GROUP_FILTERS.some((f) => lower.includes(f));
}

// --- ingest -----------------------------------------------------------------

function enqueue(message) {
  if (queue.length >= MAX_QUEUE) {
    const dropped = queue.length - MAX_QUEUE + 1;
    queue = queue.slice(dropped);
    console.warn(`[bridge] queue full — dropped ${dropped} oldest message(s)`);
  }
  queue.push(message);
}

async function flush() {
  if (flushing || queue.length === 0) return;
  flushing = true;
  const batch = queue.slice(0, MAX_BATCH);
  try {
    const res = await fetch(INGEST_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${INGEST_SECRET}`,
      },
      body: JSON.stringify({ messages: batch }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Leave the batch queued and try again next tick — the server dedupes by
      // message id, so a re-send after a partial failure can't double-track.
      console.error(`[bridge] ingest ${res.status}: ${body.error ?? '(no body)'} — will retry`);
      return;
    }
    queue = queue.slice(batch.length);
    const hit = (body.tracked ?? 0) + (body.leads ?? 0);
    console.log(
      `[bridge] sent ${batch.length} · matched ${body.matched ?? 0} · tracked ${body.tracked ?? 0} · leads ${body.leads ?? 0}${
        hit > 0 ? ' 🎯' : ''
      }`
    );
  } catch (e) {
    console.error(`[bridge] ingest failed: ${e.message} — will retry`);
  } finally {
    flushing = false;
  }
}

// --- socket -----------------------------------------------------------------

async function start() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    logger,
    // Read-only watcher: stay invisible and don't drag down years of group history.
    browser: Browsers.ubuntu('Chrome'),
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n[bridge] Scan this in WhatsApp → Settings → Linked devices → Link a device\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') {
      reconnectDelay = 2000;
      console.log(
        `[bridge] connected. Watching ${
          GROUP_FILTERS.length
            ? `groups/channels matching: ${GROUP_FILTERS.join(', ')}`
            : 'ALL groups and channels'
        }`
      );
    }

    if (connection === 'close') {
      const status = lastDisconnect?.error?.output?.statusCode;
      if (status === DisconnectReason.loggedOut) {
        console.error(
          `[bridge] logged out — this device was unlinked. Delete ${AUTH_DIR} and re-pair.`
        );
        process.exit(1);
      }
      console.warn(`[bridge] disconnected (${status ?? 'unknown'}) — reconnecting in ${reconnectDelay}ms`);
      setTimeout(start, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000);
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    // 'notify' is live traffic; 'append' is history backfill we don't want to re-ingest.
    if (type !== 'notify') return;

    for (const msg of messages) {
      const jid = msg.key?.remoteJid;
      // Channels (@newsletter) are one-way broadcasts — exactly where the job
      // pages the user follows post. Treated identically to groups downstream.
      if (!jid || (!isJidGroup(jid) && !isJidNewsletter(jid))) continue;
      if (msg.key.fromMe) continue;

      const text = textOf(msg);
      if (!text || !JOBISH_RE.test(text)) continue;

      const name = await groupName(sock, jid);
      if (!watched(name)) continue;

      enqueue({
        id: `${jid}:${msg.key.id}`,
        group: name,
        sender: msg.pushName || undefined,
        text,
        ts: Number(msg.messageTimestamp) || undefined,
      });
    }
  });

  return sock;
}

// --- main -------------------------------------------------------------------

setInterval(flush, BATCH_SECONDS * 1000);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log('\n[bridge] flushing before exit…');
    await flush();
    process.exit(0);
  });
}

start().catch((e) => {
  console.error('[bridge] fatal:', e);
  process.exit(1);
});
