# WhatsApp Bridge

Watches your WhatsApp job groups and feeds matching postings into the intern-agent
tracker. Runs **outside Vercel** — it needs a long-lived socket and on-disk auth state.

```
WhatsApp groups
      │  linked device (Baileys)
      ▼
  bridge/  ──POST──▶  /api/whatsapp/ingest  ──▶  tracker + Telegram ping
                                                       │
                                        scrape → tailor → PDF → blurb → form pre-fill
                                                       │
                                                  YOU submit
```

## Read this first

This uses **Baileys**, an unofficial reverse-engineered WhatsApp client. There is no
sanctioned alternative — Meta's WhatsApp Business Cloud API has no group support at
all, so nothing official can read a group you joined.

Consequences you are accepting:

- It links as a device on your **personal** WhatsApp account. A ban takes that number
  with it — the same number your OTPs and contacts live on.
- It violates WhatsApp's Terms of Service.
- Risk scales with behaviour that looks automated. This bridge only **reads**: it
  never sends a message, never joins a group, never reacts, and stays offline-presence
  (`markOnlineOnConnect: false`). That is the low end of the risk curve, not zero.
- Consider pairing a **secondary number** rather than your primary.

The repo's earlier standing rule was "no WhatsApp web automation." This reverses it
deliberately. If you want out, stop the process and delete `auth/` — nothing else in
the agent depends on it.

## Setup

1. **Set the shared secret on the server** (must match `INGEST_SECRET` below):

   ```sh
   node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"
   vercel env add WHATSAPP_INGEST_SECRET production --value <the-hex>
   ```

   Use `--value`, never stdin — piping stores an empty string on Windows PowerShell.
   Redeploy after adding it.

2. **Configure the bridge:**

   ```sh
   cd bridge
   npm install
   cp .env.example .env      # then fill in INGEST_SECRET and WA_GROUPS
   ```

   `WA_GROUPS` is a comma-separated list of case-insensitive substrings matched against
   group names. **Leaving it empty scans every group you are in**, including personal
   ones. Set it.

   Guessing at names silently watches nothing. Once paired, list the real ones:

   ```sh
   npm run groups
   ```

   It prints every group the device can see, ticks the ones the current `WA_GROUPS`
   would watch, and exits. **Stop the bridge first** — two processes sharing `auth/`
   can corrupt the session keys.

3. **Pair the device:**

   ```sh
   npm start
   ```

   A QR code prints in the terminal. On your phone: WhatsApp → Settings → Linked
   devices → Link a device → scan it. Credentials land in `bridge/auth/` (gitignored)
   and persist, so you only scan once.

4. **Keep it running.** It must stay up to see live messages — it does not backfill
   history. Options: leave the terminal open, `pm2 start index.mjs --name wa-bridge`,
   a systemd unit, or any small always-on box.

## What it does per message

1. Group messages only; skips your own.
2. A broad keyword gate runs **locally**, so ordinary chatter never leaves the machine.
   This gate is deliberately dumber than the server's matcher — it's a bandwidth filter,
   not the relevance spec.
3. Survivors are batched (default 20s) and POSTed to the ingest endpoint.
4. The server dedupes by message id, applies the real role match
   (`lib/whatsapp/match.ts`), and either tracks the application URL or files an
   email/DM post as a lead. Then it pings you on Telegram.

Nothing is ever submitted on your behalf.

## Operating notes

- **Failed POSTs are retried**, not dropped — the batch stays queued and the server's
  id dedupe makes re-sends safe. The queue caps at 2000 and logs anything it drops.
- **`logged out — this device was unlinked`** means the phone removed the linked
  device (or you got banned). Delete `auth/` and re-pair to recover.
- **Verify the wiring without WhatsApp** by POSTing a fake batch yourself:

  ```sh
  curl -X POST "$INGEST_URL?notify=false" \
    -H "Authorization: Bearer $INGEST_SECRET" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"id":"test:1","group":"Test","text":"Role: Product Intern\nRemote\nhttps://forms.gle/x"}]}'
  ```

- **Tune what gets matched** in `lib/whatsapp/match.ts`, and assert the change with
  `npx tsx scripts/check-whatsapp-match.mts` — that script is the spec.
