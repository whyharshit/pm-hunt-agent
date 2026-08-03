# Job Hunt Automation — Plan

> Smart **semi-automation**: agent does the boring work, you do 60s of human review before each submit. Avoids bot bans, recruiter trash-piling, and Gmail spam flags — while still giving you 10× leverage.

## Why not full auto-apply
- Recruiters spot AI-mass-apply in seconds. PM roles are *especially* unforgiving because the job is judgment + communication.
- LinkedIn / Workday / Greenhouse / Lever / Google Forms detect bots → account bans → you lose your real channels.
- Mass cold email kills Gmail deliverability for your real outreach.

## The 4 modules

### Module 1 — Daily Job Discovery Bot
- Sources: RemoteOK API, Wellfound RSS, HN "Who's Hiring" via Algolia, YC Jobs, Internshala, LinkedIn (Google site-search), Toptal, Crossover, GitLab, Automattic
- Filter: paid + remote + intern/APM/associate + product/ops/growth/strategy/CoS/founder's office
- Runs: Vercel Cron daily 9 AM
- Output: Google Sheet rows + Telegram/email digest

### Module 2 — Smart Application Assistant (semi-auto)
- Paste a job URL → get tailored resume bullets, cover letter draft, likely interview questions, "why this company" hook, auto-tracker entry
- You click submit yourself

### Module 3 — Referral & Outreach Engine
- For each target company: LinkedIn search queries for PMs/recruiters/2nd-degree contacts
- Drafts personalized DMs/emails with a hook
- Tracks responses

### Module 4 — Tracker + Follow-up Bot
- Google Sheet as DB
- Daily reminder: "Follow up on these 3 today"
- Weekly metrics: applied → responded → interviewed → offer
- Tracks which resume / hook / channel converts

## Free stack
- Vercel Hobby (hosting + cron + functions)
- Next.js 16 App Router
- Claude (via this CLI) for LLM calls
- Google Sheets API for tracker
- Telegram Bot API or Gmail SMTP for notifications
- GitHub free for repo + backup
- Playwright for browser scraping where needed

## 8 inputs that actually move the needle
1. Apply within 24h of posting (response rate drops ~50% after 3 days)
2. Referrals (5–10× cold-apply callback rate)
3. **Teardown DM tactic** — 1-page PM teardown of dream company's product, sent to a PM there. Highest-converting PM intern tactic.
4. Notion portfolio with 3 case studies (including a Loving Room PM teardown — insider access nobody else has)
5. LinkedIn rebuild (PM headline, banner, "Open to Work", 1 post/week)
6. Adjacent roles: APM, Founder's Office intern, CoS intern, Growth intern, Ops intern — same skills, ⅓ the competition
7. Mock product-sense interviews 2×/week (Exponent free, Pramp)
8. Build in public — weekly posts, tag PMs at target companies

## Build sequence
- **Week 1:** Module 4 (tracker) + Module 1 (discovery bot)
- **Week 2:** Module 2 (application assistant) → start applying daily
- **Week 3:** Module 3 (outreach) + Notion portfolio with first 2 case studies
- **Week 4+:** Iterate on what's converting; ramp mock interviews

## Open decisions
- Country / timezone (drives target sources — Internshala for IN, RemoteOK/Wellfound for global)
- Notifications channel (Telegram vs Gmail digest vs both)
- Where to host portfolio (Notion vs Vercel-hosted)
- Real applications go through one account (e.g. `hello@lovingroom.co`) or a dedicated job-hunt email?
