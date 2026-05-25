# Deploy to Vercel — 5 minute walkthrough

> Run once now. Re-deploys after this are automatic on `git push`.

## Step 1 — Import the repo on Vercel

1. Open https://vercel.com/new
2. Click **Import Git Repository**
3. Pick `shivaych/pm-hunt-agent` from the list
   - If you don't see it: click **"Adjust GitHub App Permissions"** and grant Vercel access to this repo

## Step 2 — Configure project

- **Framework Preset:** Next.js (auto-detected, don't change)
- **Root Directory:** `./` (default)
- **Build Command, Output, Install:** all defaults

## Step 3 — Add environment variables

Click **Environment Variables** and add these two:

| Name | Value |
|---|---|
| `TELEGRAM_BOT_TOKEN` | `8800630336:AAH-2tElRlx09udPhtf9QX8XA4eRo4tFKhk` |
| `TELEGRAM_CHAT_ID` | `8390069259` |

Leave the "Environments" checkboxes as all three (Production, Preview, Development).

## Step 4 — Deploy

Click **Deploy**. Wait 1–2 minutes for the build.

## Step 5 — Test it

When the build finishes, you'll get a URL like `https://pm-hunt-agent.vercel.app`.

Visit `https://<your-url>/api/discover` in a browser. You should see:

```json
{ "ok": true, "fetched": 61, "filtered": 0, "newCount": 0, "errors": [] }
```

And a Telegram message: "Checked X listings. No new matches."

## Step 6 — Send the URL back

Copy your production URL and paste it back to Claude in the next session so we can wire the cron + Telegram webhook.

## Things you do NOT need to do yet

- ❌ Don't set up cron yet — Claude will add this with code
- ❌ Don't set up domains — `.vercel.app` URL is fine
- ❌ Don't tweak anything else in the Vercel dashboard
