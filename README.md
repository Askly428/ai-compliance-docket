# AI Compliance Docket

A multi-tenant compliance tracker for California's active AI regulations (SB 942, AB 2013, SB 53, CPPA ADMT). Companies sign up, scope which statutes apply to them, work through requirement checklists, and export a compliance report — every change is written to an audit trail.

## Why zero dependencies

This runs on **Node.js built-ins only** — `http`, `node:sqlite`, `crypto`. No npm install, no build step, no framework lock-in. That means:
- It runs anywhere Node 22.5+ runs, in one command
- No dependency-vulnerability surface to audit before an acquirer's due diligence
- Trivial to read end-to-end in an afternoon, which matters a lot for a due-diligence review

This is a deliberate MVP tradeoff, not a permanent architecture decision — see **Scaling past MVP** below for what changes as you get real customers.

## Run it locally

```bash
cd server
node server.js
# → http://localhost:8080
```

No `npm install` needed. First run creates `data/compliance.db` (SQLite) and seeds the four regulations.

## Deploy it

Any host that runs Node 22.5+ works. Simplest options:

**Railway / Render / Fly.io**
1. Push this folder to a GitHub repo
2. Connect the repo, set start command `node server.js`
3. Set `PORT` env var if the platform requires it (most auto-inject it)
4. Attach a persistent volume mounted at `/app/data` so the SQLite file survives deploys

**A basic VPS**
```bash
git clone <your-repo>
cd server
node server.js &
# put nginx or Caddy in front for HTTPS
```

## API surface

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/api/auth/signup` | — | Create company + owner account |
| POST | `/api/auth/login` | — | Get a session token |
| GET | `/api/me` | ✓ | Current user + company |
| GET | `/api/dashboard` | ✓ | Full docket: regulations, status, score, watching list |
| PATCH | `/api/company/profile` | ✓ | Update which statutes apply (genai, genai1m, frontier, admt) |
| PATCH | `/api/requirements/:id` | ✓ | Toggle a checklist item (writes an audit log entry) |
| GET | `/api/audit-log` | ✓ | Last 100 changes, who/when/what |
| GET | `/api/report` | ✓ | Plaintext compliance report |

Auth is a Bearer token in the `Authorization` header, issued on signup/login, valid 7 days.

## Data model

`companies` → `users` (multi-tenant: every row is scoped by `company_id`) → `status` (per-company checklist state) → `audit_log` (immutable change history). `regulations` and `requirements` are global reference data, seeded on boot.

## Scaling past MVP

This is intentionally the smallest correct version. Before selling to a company beyond a handful of design partners, the honest next steps are:

1. **Swap SQLite for Postgres.** `node:sqlite` is still an experimental Node API and SQLite itself doesn't handle concurrent writes at scale. The schema in `server.js` maps almost 1:1 to Postgres tables — this is a few hours of work, not a rewrite.
2. **Replace the custom session table with a real auth provider** (or at least add password reset, email verification, and rate limiting on login).
3. **Evidence upload**, not just checkboxes — let a compliance officer attach the actual watermarking config, the published training-data doc URL, etc., so the audit trail holds proof, not just a boolean.
4. **Team roles** — right now every user is an "owner" with full access. Real compliance tools need viewer/editor/admin tiers.
5. **Regulation content as a maintained feed**, not hardcoded JS — new state laws (Colorado, NY, WA are already listed as "watching") need to convert into real tracked statutes without a code deploy.

None of this changes the product's core idea or its buyer — it's the difference between a demo and something a GRC platform's engineering team is comfortable inheriting.

## What would make this acquirable

An acquirer (GRC/compliance platforms like Vanta/Drata-adjacent companies, legal-tech, or a larger AI company buying a compliance layer) is paying for **distribution and signal**, not code. The code above is real and correct, but the thing that makes this worth money is:
- Paying customers who'd be angry if it disappeared
- A reason the acquirer can't build it faster themselves — usually that's either your customer relationships or your regulation-tracking accuracy/currency
- Clean IP (this repo has zero external dependencies, so there's nothing to license-audit)

Get 5–10 real AI companies using this for their SB 942 compliance (the law took effect August 2, 2026, so this is a live need right now), and the conversation with an acquirer changes completely.
