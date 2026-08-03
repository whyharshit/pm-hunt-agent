# Prereqs — do these 4 things (10 minutes)

> While Claude scaffolds the project, knock these out. Paste the results back into the chat and we'll wire everything up.

## 1. GitHub account (free)
- Sign up: https://github.com/signup
- You don't need to create a repo — Vercel will do that when we deploy.
- ✅ Done? Just confirm "got it".

## 2. Vercel account (free Hobby plan)
- Sign up with **"Continue with GitHub"**: https://vercel.com/signup
- That auto-links your GitHub so deploys are one-click.
- ✅ Done? Confirm.

## 3. Telegram bot (free, 3 minutes)
This is how you'll get the daily job digest on your phone.

1. Open Telegram. Search for the user **@BotFather** (verified blue check).
2. Send `/newbot`.
3. Give it a name (anything, e.g. `PM Hunt Agent`).
4. Give it a username (must end in `bot`, e.g. `pmhuntagent_bot`).
5. BotFather replies with a **bot token** — looks like `7891234567:AAH...long-string`.
6. **Paste the token back into this chat.** (We'll store it as a Vercel env var — never commit it.)
7. Now message your own bot once (just say "hi") so it can DM you.
8. Open https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates in a browser (replace `<YOUR_TOKEN>` with your token).
9. Find `"chat":{"id": 123456789` in the response. **Paste that chat ID back too.**

## 4. Google account (for the Sheets tracker)
You probably already have one. We'll use a free **Google Cloud service account** to let the app write to a Google Sheet on your behalf — no OAuth dance every time.

- We'll do the service account creation together once everything else is ready. Just confirm which Google account you'll use (any free Gmail works).

---

## What to paste back into chat

```
GitHub: ok
Vercel: ok
Telegram bot token: 7891234567:AAH...
Telegram chat ID: 123456789
Google account: yourname@gmail.com
```

Once we have those, I'll wire the bot, the Sheet, the cron job, and we'll see the first job-discovery digest within 24 hours.
