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

   `DATABASE_URL` must be the **service role / owner** connection string. Migration
   `0004` enables row level security on every table with no policies, so the `anon` and
   `authenticated` keys are denied outright; the owner role bypasses RLS and the jobs
   keep working. Confirm after migrating:

   ```sql
   select tablename, rowsecurity from pg_tables where schemaname = 'public';
   ```

   Every row must read `t`. There is a test for this (`tests/db/immutability.test.ts`),
   but it runs against PGlite — confirm it on the real project too.

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

## Phase 1 — how a recommendation gets built, and how it gets blocked

Phase 1 ("Think") is complete: the agent now scores, sizes, gates and scores-after-the-fact,
all on paper. Nothing executes, and there is no code path that could.

```
  EOD sources                  engines                        output
  ───────────                  ───────                        ──────
  NSE bhavcopy ─┐                                          ┌─ weekly report (Sun 10:00 IST)
  NSE index    ─┤                                          │    1 signal review
  AMFI NAV     ─┼─► staleness ─► blockedInstruments ──┐    │    2 watchlist changes
  screener.in  ─┤    (FR-31)                          │    │    3 recommendation pipeline
  INDmoney     ─┘                                     ▼    │    4 staleness + blocked names
        │                       engine.ts ──────► recommendations.ts ──► 5 scoring (§13)
        │                       (§6 composite)    (FR-11 primary + 2    │  6 narrative (§6.7)
        ├──► networth ─────►    alloc-engine.ts    alternates, FR-12    │
        │                       (FR-13 drift)      caps → suppressed)   └─ daily digest
        └──► positions ────►    sell-triggers.ts                           (unchanged)
                                (§6.5 exits)
```

**The path a name takes.** It enters the `watchlist` (advisor-curated, owner signs off on
changes). The weekly run scores it: the §6 quality gate first — ROCE, five-year FCF, D/E with a
finance-sector waiver, screener red flags, all **fail-closed on an unknown** — then a composite
of valuation 30 / trend 30 / earnings 20 / fit 20, banded HIGH / MEDIUM / WATCH / NONE. A
MEDIUM-or-better name becomes an FR-11 recommendation: a primary leg plus **exactly two**
alternates (A1 the same intent through a different instrument, or the broad-index route; A2 a
different intent, defaulting to doing nothing), each with a thesis under 150 words and at least
one IPS clause that must exist in `src/config/ips-v1.md`. FR-12 then caps it: four per calendar
month, no repeat BUY on a name inside twelve months, overridable only by an IPS spec change, a
material adverse falsification, or an owner directive. **A capped action is logged to
`suppressed_actions` and shown in the report — never dropped.**

**The two ways it gets stopped.**

1. **Stale data (FR-31).** Every source carries a freshness limit in `src/sources/staleness.ts`.
   When one lapses, `blockedInstruments` names every position that depended on it — its
   portfolio source, FX for anything non-INR, NAV for funds, prices for equity/ETF/bond,
   fundamentals for equity. A blocked name is **not scored at all**, and an open recommendation
   raised before the lapse is **withheld** from the pipeline and listed under staleness instead.
   You cannot act on what cannot be valued today.
2. **Policy.** IPS §3.7 allows the twelve-month minimum hold to be overridden only by thesis
   falsification, a red-flag event, or a hard-cap breach. An exit trigger outside that list
   (sustained underperformance, a better alternative) is still surfaced — flagged
   `blockedByMinimumHold` — so you can see the engine wanted out and the policy said wait.

**What the engine will not invent.** The 10Y G-sec yield (no ingestion source — supply
`GSEC_YIELD_PCT` or the signal review states that it did not run), a cost basis it cannot read,
a tax figure (`TAX_POLICY_NOTE` names what is not computed), a rating action, and a hit-rate
from fewer than 20 evaluations in a bucket.

### Phase 1 provisioning verification (PRD §15.1)

Do these before trusting the first live weekly report. Each one fails loudly rather than
quietly, but "loudly" still means a week of no data.

| Item | How to verify | Status |
|---|---|---|
| NSE equity bhavcopy URL + CSV columns | run `pnpm sync` on a trading day; a moved path raises `SYNC_FAILURE/nse-bhavcopy` | **unverified against live NSE** |
| NSE index series URL + columns | same run; feeds every relative-strength number | **unverified against live NSE** |
| AMFI `NAVAll.txt` format | `pnpm sync`; unmapped scheme codes are logged, not invented | fixture-verified only |
| `instruments.scheme_code` / `isin` coverage | unmapped rows are counted on stderr — they are silently unpriced otherwise | seed covers 6 MFs, 5 ISINs |
| OpenRouter weekly model id + cost (~₹1.5–3k/mo) | set `WEEKLY_LLM_MODEL`; no key = deterministic bullets, no failure | owner |
| NSE 2026 holiday calendar | the `holidays` table is **empty**; only weekends are skipped, so a holiday costs one loud 404-shaped skip | **owner input needed** |
| `GSEC_YIELD_PCT` | blank means "not configured" — never 0% | **owner input needed** |

---

## Scripts

| Command | Description |
|---|---|
| `pnpm test` | Run all tests (vitest) |
| `pnpm migrate` | Run DB migrations |
| `pnpm seed` | Seed the database with the owner's real balance sheet |
| `pnpm sync` | Sync holdings from INDmoney, FX, NSE bhavcopy + index, AMFI NAVs |
| `pnpm digest` | Compose and send the daily digest via Telegram |
| `pnpm report` | Weekly deep report (FR-51). `--as-of YYYY-MM-DD` reproduces a past week |
| `pnpm screener:import <csv>` | Import a screener.in export into `fundamentals` |
| `pnpm web` | Local product UI on :3001 |
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
  sources/       INDmoney (OAuth + file fallback), FX, NSE bhavcopy, AMFI, screener,
                 staleness, LLM extraction + narration
  domain/        loans, surplus, RSU, net worth, allocation, buckets, funded-status, IPS,
                 engine (§6 signals), alloc-engine (FR-13), sell-triggers (§6.5),
                 recommendations (FR-11/12), scoring (§13), maturities, redemptions
  notify/        Telegram (owner-locked), daily digest, weekly report — all pure composers
  jobs/          sync, digest, report, keepalive — entrypoints for GitHub Actions
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