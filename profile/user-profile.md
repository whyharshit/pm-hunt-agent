# User Profile (answers driving the build)

_Updated 2026-08-27_

| | |
|---|---|
| **Region target** | Global / remote-anywhere, India on-site OK |
| **Notifications channel** | Telegram bot |
| **Bandwidth** | TBD — ask user |
| **Email** | harshiitkgp@kgpian.iitkgp.ac.in |
| **Time zone** | IST (GMT+5:30) |

## What this changes in the plan

- Target roles narrowed to **AI/ML engineering, applied ML/data, and AI agent/automation**
  internships — matches the Fitsol / UnoJobs / Omnidel.ai background on the resume. PM/growth/ops
  patterns were removed from `lib/filters.ts` and `lib/job-category.ts` on 2026-08-27 (was
  previously tuned for a PM-track candidate).
- Job sources: same board list as before (RemoteOK, Wellfound, HN "Who's Hiring", YC Jobs, etc.)
  — only the title/role filter changed, not the sources.
- Notifications: Telegram bot (needs its own bot token — see `docs/PREREQS.md`; do NOT reuse the
  token committed in `DEPLOY.md`, it belonged to the previous owner and is already public).
- Outreach templates (`lib/outreach-template.ts`, `lib/job-outreach-template.ts`,
  `lib/followup-template.ts`) were rewritten with Harshit's own experience bullets and sign-off.
  Numbers in these bullets are Harshit's own resume figures — if anything changes on the resume,
  update the bullets to match; do not let a model paraphrase the figures.
