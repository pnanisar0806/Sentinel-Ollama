# Sentinel

**Single-user, approval-gated personal investment intelligence agent** for Anirban Sarkar.
Built from a frozen PRD. Phase 0 is advisory reporting only — no trading paths, no autonomous execution,
no multi-tenancy. Telegram bot locked to the owner's chat ID (PRD §4.1, §12.3).

---

## Local quickstart

```bash
pnpm install
pnpm migrate
pnpm seed
DRY_RUN=1 pnpm digest
```

Expected: a rendered digest prints to stdout showing net worth (including Fidelity NOW and EPF),
liabilities, per-account breakdown, allocation drift vs IPS §3.3, concentration breaches vs §3.5,
four bucket balances, both open milestone nags, next projected RSU vest, and a freshness verdict.

---

## Provisioning checklist (do these in order)

1. **Telegram** — message @BotFather, `/newbot`, copy the token. Message the new bot once,
   then open `https://api.telegram.org/bot<TOKEN>/getUpdates` to read your chat id.
   Set `TELEGRAM_BOT_TOKEN` and `TELEGRAM_OWNER_CHAT_ID`.

2. **Supabase** — create a free project, copy the *pooler* connection string into
   `DATABASE_URL`, run `pnpm migrate` once against it, then `pnpm seed`.

3. **Kite Connect (optional in Phase 0)** — create a Personal app at developers.kite.trade.
   Order APIs are free; market data is ₹500/month and Phase 0 does not need it.
   Static-IP registration is required only for order placement (Phase 3).

4. **INDmoney** — generate `TOKEN_ENCRYPTION_KEY`
   (`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`),
   then run `pnpm indmoney:login` once. Your browser opens INDmoney's own sign-in page;
   complete OTP + MPIN there. Sentinel stores only an encrypted `portfolio:read`
   refresh token and syncs unattended from then on. If INDmoney ever expires the grant,
   the digest says so and names this command — re-run it and you're back.
   `data/indmoney-snapshot.json` remains as a manual fallback.

5. **GitHub Actions** — add every value from `.env.example` as a repository secret.
   Enable the three workflows.

6. **Verify the DoD** — compare the digest's per-account figures against Kite,
   INDmoney and Fidelity NetBenefits. They must agree within **±1%**.

---

## Phase 0 → Phase 1 handoff

Phase 0 delivers the data layer and daily digest. Phase 1 adds the **recommendation engine**
(FR-10 through FR-15) on top of the existing schema:

- The `settings_rails` and `incidents` tables are already created.
- `blockedInstruments` from the staleness engine feeds FR-31 refusal.
- `ipsClause` extracts sections for FR-10 citations.
- `funded_status` is intentionally unreadable by sizing/risk functions (architecture test in
  `tests/architecture/no-catch-up.test.ts` enforces this).
- All money paths use branded `bigint` paise/cents — never floats.

When Phase 1 starts, the PRD §3.1–3.10 IPS text in `src/config/ips-v1.md` becomes the
binding contract for every recommendation. A paraphrase at −20% drawdown is a product
failure — the text is stored verbatim and rendered via `renderIps`.

---

## Scripts

| Command | Description |
|---|---|
| `pnpm test` | Run all tests (vitest) |
| `pnpm migrate` | Run DB migrations |
| `pnpm seed` | Seed the database with the owner's real balance sheet |
| `pnpm sync` | Sync holdings from INDmoney (OAuth) and Kite (read-only) |
| `pnpm digest` | Compose and send the daily digest via Telegram |
| `pnpm ips 3.5` | Print the concentration-caps clause (IPS §3.5) |
| `pnpm indmoney:login` | One-time interactive OAuth login for INDmoney |

---

## Architecture

```
src/
  config/        env, assumptions, IPS text
  db/            PGlite / postgres-js client, migration runner
  money/         Paise, Cents, FX — branded bigint, no floats
  seed/          Owner's verified balance sheet (loans, bonds, RSU, equity)
  sources/       INDmoney (OAuth + file fallback), Kite (read-only), FX, staleness
  domain/        loans, surplus, RSU, net worth, allocation, buckets, funded-status, IPS
  notify/        Telegram (owner-locked), daily digest (pure)
  jobs/          sync, digest, keepalive — entrypoints for GitHub Actions
```

---

## Hard constraints (from PRD, never violate)

- **No trading paths.** No F&O, no intraday, no leverage, no loan-against-securities.
- **No autonomous execution.** Every order requires fresh human approval.
- **Single user.** No multi-tenancy, no accounts, no sharing.
- **No stored broker passwords or TOTP secrets.** Human-in-loop unlock is the security model.
- **Secrets** live in GitHub Actions secrets / Vercel env vars. Never in the repo, never in the DB.
- **Telegram bot** locked to owner's chat ID; every other ID is ignored.
- **Audit immutability.** Append-only tables, enforced by triggers (UPDATE, DELETE and TRUNCATE).
- **Kolkata property** is not an optimization target.
- **`funded_status` is unreadable by any sizing or risk function.** No catch-up behavior.