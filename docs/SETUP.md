# Sentinel — Setup & Deployment Guide

Phase 0 is **not a website you host**. It is a headless agent made of four pieces wired together:

| Piece | What it is | Cost |
|---|---|---|
| Database | Supabase (hosted Postgres) | Free tier |
| Messenger | A private Telegram bot that talks only to you | Free |
| Jobs | `sync` / `digest` / `keepalive`, run on GitHub's computers on a schedule | Free |
| Secrets | Stored in GitHub Actions secrets — never in the repo | — |

---

## Current status (2026-08-24)

| Item | State |
|---|---|
| Code (17 tasks + whole-branch review fix wave) | ✅ Done — 387/387 tests green, tsc clean |
| GitHub repo | ✅ Private: [pnanisar0806/Sentinel-Ollama](https://github.com/pnanisar0806/Sentinel-Ollama) |
| Pull request | ✅ [#1](https://github.com/pnanisar0806/Sentinel-Ollama/pull/1): `phase-0` → `main` |
| Merge PR | ✅ Merged 2026-08-24 — `main` is live, schedules active |
| Telegram bot | ✅ Created, delivery verified 2026-08-24 |
| Supabase project | ✅ Created 2026-08-24 — `sentinel` (ref `uqzbocoujennfhdqppdl`, Mumbai), migrated + seeded, RLS verified on all 18 tables |
| INDmoney OAuth against production DB | ⬜ Token currently lives only in local `.pglite` |
| GitHub Actions secrets | ⬜ Not added |

Your local `.env` (gitignored) already holds `DATABASE_URL=pglite://.pglite` and a
`TOKEN_ENCRYPTION_KEY` from the local INDmoney login.

> **Gotcha that bites everyone:** nothing auto-loads `.env` — there is no dotenv
> dependency. Only `pnpm indmoney:login` uses `tsx --env-file=.env`. Every other script
> sees only variables exported in your shell. This is why `pnpm digest` used to throw
> `Missing required environment variable: TELEGRAM_BOT_TOKEN` before the bot was set up.

---

## Step 1 — Sanity-check locally (5 min) — ✅ DONE

```powershell
$env:DATABASE_URL = "pglite://.pglite"
$env:TELEGRAM_BOT_TOKEN = "dry"; $env:TELEGRAM_OWNER_CHAT_ID = "dry"; $env:DRY_RUN = "1"
pnpm migrate; pnpm seed; pnpm digest
```

Expected: the full daily digest prints to your terminal and sends nothing (`DRY_RUN=1`
never calls Telegram, so placeholder creds are fine).

## Step 2 — Merge PR #1 — ✅ DONE (merged 2026-08-24)

CI ran green and the PR is merged: `main` now carries the full Phase 0 implementation,
and the three scheduled workflows are **live** (they fire on cron from `main`).

> Heads-up: until Steps 4–6 supply the secrets, the scheduled `sync` / `digest` /
> `keepalive` runs will fail with red ✗ in the Actions tab. That is expected — they
> go green once the secrets exist.

## Step 3 — Create the Telegram bot (~10 min) — ✅ DONE

Bot created; digest delivery verified end-to-end on 2026-08-24. Values are in your local
shell history / GitHub secrets to be. (Chat ID lives in the getUpdates reply; never
commit it or the token.)

1. Message **@BotFather** in Telegram → `/newbot` → follow prompts → copy the token.
   That token is `TELEGRAM_BOT_TOKEN`.
2. Open your own new bot and send `/start`. Bots cannot message you first — this unlocks
   delivery.
3. Visit in a browser:
   `https://api.telegram.org/bot<TOKEN>/getUpdates`
   Find `"chat":{"id": 123456789,...}` — that number is `TELEGRAM_OWNER_CHAT_ID`.
4. Try it end-to-end right now:
   ```powershell
   $env:DATABASE_URL = "pglite://.pglite"
   $env:TELEGRAM_BOT_TOKEN = "<real token>"; $env:TELEGRAM_OWNER_CHAT_ID = "<real id>"
   pnpm digest        # no DRY_RUN this time -> arrives in your Telegram
   ```

*Optional:* `pnpm telegram:bot` starts an interactive command bot (long polling) with
`/sync`, `/status`, `/help` — same owner-lock. It is a foreground process you run yourself;
the scheduled GitHub jobs are the unattended path.

## Step 4 — Create Supabase and load your data (~20 min)

1. supabase.com → **New project** (free tier) → save the DB password.
2. Copy the **connection pooler** string — Project Settings → Database, port **6543**,
   user `postgres` (that is the owner/service role, which bypasses RLS):
   ```
   postgresql://postgres.<ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
   ```
3. Initialize it from your PC:
   ```powershell
   $env:DATABASE_URL = "<supabase-pooler-string>"
   pnpm migrate      # all migrations incl. tables, append-only triggers, RLS, oauth tables
   pnpm seed         # loads your verified balance sheet
   ```
4. Verify RLS locked down — every row must read `t` (run in the Supabase SQL editor):
   ```sql
   select tablename, rowsecurity from pg_tables where schemaname = 'public';
   ```

## Step 5 — INDmoney login against Supabase (~10 min)

Your refresh token currently sits only in the local `.pglite`; CI cannot see it. Re-run the
one-time interactive login pointed at Supabase:

```powershell
$env:DATABASE_URL     = "<supabase-pooler-string>"
$env:TOKEN_ENCRYPTION_KEY = node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
pnpm indmoney:login    # browser opens -> OTP + MPIN -> encrypted token stored in Supabase
```

**Use ONE key everywhere.** The key above must be the *same value* you later store as the
GitHub `TOKEN_ENCRYPTION_KEY` secret — sync in CI decrypts the token with it. If they ever
diverge, re-run this login.

If INDmoney ever expires the grant, the digest tells you and names this command — just
re-run it.

## Step 6 — Add GitHub secrets

Repo → Settings → Secrets and variables → Actions → **New repository secret**:

| Secret | Needed by | Value |
|---|---|---|
| `DATABASE_URL` | sync, digest, keepalive | Supabase pooler string (Step 4) |
| `TELEGRAM_BOT_TOKEN` | digest | Step 3 |
| `TELEGRAM_OWNER_CHAT_ID` | digest | Step 3 |
| `TOKEN_ENCRYPTION_KEY` | sync | the key from Step 5 |
| `KITE_API_KEY`, `KITE_ACCESS_TOKEN` | sync (optional in Phase 0) | developers.kite.trade personal app; order APIs free, market data ₹500/mo — Phase 0 doesn't need market data |

## Step 7 — Turn it on and verify

1. Repo → **Actions** tab → enable workflows if prompted.
2. Test each manually before trusting the cron: open `sync` / `digest` / `keepalive` →
   **Run workflow**. A real Telegram digest should arrive within ~a minute.
3. Schedules then take over (times in IST):
   - `sync` — **daily 17:30** (12:00 UTC)
   - `digest` — **weekdays 08:45** (03:15 UTC Mon–Fri)
   - `keepalive` — **Sundays 09:30** (04:00 UTC), belt-and-braces Supabase ping
4. Final acceptance check: compare digest figures against Kite / INDmoney / Fidelity —
   they must agree within **±1%**.

Done. Nothing needs babysitting after this: GitHub runs the jobs, Supabase holds data,
Telegram delivers reports to your phone.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Missing required environment variable: TELEGRAM_BOT_TOKEN` | Working as designed — the digest job messages the owner, so it demands the pair. Set both vars (Step 3), or use `DRY_RUN=1` with placeholders for a stdout-only run. Remember `.env` is NOT auto-loaded except by `indmoney:login`. |
| `DATABASE_URL is set but empty` | A blank-but-present var would silently fall back to embedded PGlite and show ₹0 — the code refuses. Unset the var entirely or give it a real URL. |
| Digest says INDmoney needs re-auth | Grant expired. Re-run `pnpm indmoney:login` with `DATABASE_URL` pointing at Supabase and the same `TOKEN_ENCRYPTION_KEY`. |
| Workflows exist but never fire | They are scheduled on the default branch only — make sure the PR merged, then trigger each once manually. |
| Sync falls back to the file snapshot | `TOKEN_ENCRYPTION_KEY` missing/wrong in CI (sync.yml logs loudly on stderr when this happens), or the OAuth login was never run against Supabase. |
| Everything looks ₹0 after a run | `DATABASE_URL` pointed somewhere unexpected — check it is the Supabase service-role pooler string, port 6543. |
