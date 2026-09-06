# PENDING — start here

One screen of what's open, so a new session doesn't have to re-read anything. Updated at
every session end alongside MEMORY.md / progress.md. Contracts & gotchas live in
MEMORY.md; the code map lives in index.md.

## Next up

- [ ] **CI IS RED ON `main` (2026-09-07).** The whole `web/` + import + Kite body of work was
      committed and pushed (`9420cba`, plus `779bd6c`). `tsc` passes; `pnpm test` fails on the
      **one pre-existing** assertion below — `workflow-schedule.test.ts` → `no cron in digest.yml`.
      It was already red locally and was pushed knowingly rather than silenced. It now blocks a
      green badge, so the owner decision under "Waiting on OWNER" is the next thing to land.

- [x] **KITE RETIRED — INDmoney is the only portfolio source. DONE 2026-09-07.** The connect
      flow worked, which is how it surfaced that INDmoney already aggregates the same Zerodha
      account: net worth had jumped ₹57,12,936 → ₹71,85,786 (+26%) with no money moving.
      Code removed and data cleaned; **verified back to 48 positions / ₹57,12,936 assets /
      ₹20,90,960 net, sources `manual-seed, indmoney` only**, digest composes clean with no
      kite row in staleness. The empty `kite` snapshot row remains by design (`snapshots` is
      append-only — trigger in `0001`, not `0004`) and contributes zero positions. The orphaned
      kite `STALE_DATA/BLOCK` incident was resolved too. Backup of the deleted rows:
      `data/kite-snapshot-backup-2026-09-07.json` (gitignored). Detail + the two durable
      lessons in `MEMORY.md § Kite retired`.

- [ ] ~~**Kite connect — `Invalid api_key` FIXED (2026-09-07).**~~ Superseded by the retirement
      above; kept for the durable lesson, which is in `MEMORY.md § .env values must be UNQUOTED`.
      Root cause: `.env` held
      `KITE_API_KEY="…"` **quoted**, and the running server had cached the quoted value, so the
      login redirect emitted `api_key=%22…%22` and Kite rejected it. `KITE_API_SECRET` was quoted
      too and would have broken the `/session/token` checksum at the next step. Fixed by removing
      the surrounding quotes in `.env` (key is 16 chars, secret 32 — Kite's real formats) and
      restarting; the redirect now emits a bare key. **Still pending:** the owner completing a real
      login in the browser. `KITE_REDIRECT_URI` is unset so it defaults to
      `http://localhost:3001/api/kite/callback` — that exact URL must be registered against this
      api_key in the Kite developer console or the callback leg fails.

- [ ] **Kite `/api/kite/login` + `/api/kite/callback` — 500s FIXED (2026-09-06).** Root cause:
      `NextResponse.redirect()` needs an **absolute** URL; both routes passed relative paths →
      `ERR_INVALID_URL`. Fixed via `req.nextUrl.origin`. Live: login (no key) → 307
      `/import?kite=error&reason=no-api-key`; callback (no params) → 307
      `/import?error&reason=no-request-token`; both notices render on `/import`. **Still pending:**
      a real connect still needs `KITE_API_KEY`+`KITE_API_SECRET` in `.env` and the redirect URI
      registered in the Kite console (the `KITE_REDIRECT_URI` URL is where your callback must be
      whitelisted).
- [ ] **LLM extraction — WORKS NOW (2026-09-06).** Root cause of the "LLM not configured" behavior:
      the OpenRouter key lived only in a shell env var; `web/next.config.ts` loads repo-root `.env`
      at startup, so servers started from any other terminal ran extraction-less. Key moved into
      `.env` (gitignored) + documented in `.env.example`. Live-verified: `minimax/minimax-m3:free`
      returned a clean JSON extraction from a real statement image with that key; gemma `:free` 429
      (shared free-pool saturation → chain walks). Server must be **restarted** after `.env` changes.
      After the 5-Sept test uploads with no key, the `/import` History shows 3 permanent
      `fake.png` entries (append-only record) — owner chose to keep them.

- [ ] **Web redesign, v2 — AGAINST THE ArenaAI REFERENCE — BUILT + COMMITTED (pushed 2026-09-07, `9420cba`) (2026-09-06).**
      Owner review of v1: "right half of each screen empty, no gaps between cards, two cards in a
      row, and where is the Kite authentication button?" Reference: `D:\Sentinel-ArenaAI.zip` →
      `C:\Users\Anirban\AppData\Local\Temp\opencode\arenaai`. **Root cause (confirmed):** pages use
      `.grid`, `.stats`, `.legend`, `.ips-text`, `.dim`, `.mono`, `.tr-*`, `.card-body` that were
      **undefined** in `web/globals.css` → cards fell back to full-width stacked blocks. **Done:**
      rewrite of the layout layer in `globals.css` — real `.grid` (2-col, 24px gaps), `.two-thirds`
      wide + rail, `.stats` strip, `.one`/`.span-2` full-row, `.stack` rhythm, mobile 1-col
      collapse; missing utilities (`.dim`, `.mono`, `.legend`, `.ips-text`, `.tr-*` row tones,
      `.card-body`) defined; `.main` max-width 1320px; overview uses `grid two-thirds`;
      `/import` review sections flow 2-up and a **"Connect a provider"** grid was added with
      Kite + LLM status cards and an honest "Import statement" path (real Kite OAuth = Phase 2,
      human-in-loop, no stored password). Verified: tsc clean, all 16 pages 200, served CSS
      confirms `repeat(2, 1fr)` + `gap:24px`, suite still 449/1-stale. **Open for owner:** 1) is a
      Kite "Sign in" button stub wanted on the provider card now, or is the status + upload path
      enough? 2) visual fidelity — keep the current near-black/indigo glow or match ArenaAI's
      slate-950 flat panels exactly? Server running on :3001.

- [ ] **Redesign + `/import` ingest flow — BUILT + COMMITTED (pushed 2026-09-07, `9420cba`) (2026-09-05).**
      The web app got a hand-rolled ultra-modern CSS theme (near-black base, indigo/violet
      glows, glass panels/sidebar; no Tailwind) and a new owner-gated **statement-import**
      flow at `/import`: upload brokerage or Fidelity RSU statements → LLM extraction into
      proposals → confirm/reject → real DB writes through the same platform functions as the
      Telegram bot (FR-02/03). Backing store = migration `0009_web_uploads.sql` (already
      applied to live by the first `/import` load). No-key degrade path verified (`unusable`).
      **Now on `main`; review there.**

- [ ] **The real app — BUILT + COMMITTED (pushed 2026-09-07, `9420cba`).** After the 8081 preview the
      owner said "build the real app" (2026-09-05): PRD's Next.js product UI pulled forward
      as a standalone **`web/`** app, local + read-only. **16 routes live at
      http://127.0.0.1:3001** (`pnpm web`, `next dev -p 3001`), all verified 200 against the
      real Supabase DB: `/` Overview, `/holdings`, `/allocation`, `/buckets`, `/rails`,
      `/rsu`, `/ips`, `/freshness`, `/audit` render live Phase 0 data through the same pure
      domain functions the jobs use; `/watchlist` (T6), `/signals` (T7), `/recommendations`
      (T10), `/maturity` (T1), `/narrative` (T11), `/scoring` (T12) are honest Task-N shells
      with disabled, reason-named buttons; `/product` is the AREAS map. **Now on `main`;
      review there** (`web/`, docs, `.gitignore`, `package.json` script).
      Gotchas in `MEMORY.md § Local web app`. This SUPERSEDES Task 11A's throwaway shell as
      the UI vehicle (the 8081 preview stack still merges on its own turn).

- [ ] **Phase 1 ("Think") kickoff.** Plan written:
      `docs/superpowers/plans/2026-09-05-sentinel-phase-1.md` — 13 tasks: Sammaan
      maturity → schema 0007/0008 → bhavcopy/AMFI/screener sources → staleness
      extension (blocked-by-stale DoD proof) → signal/alloc/sell engine → FR-11
      recommendation objects + paper mode → weekly report → **Task 11A local preview UI (8081 — throwaway shell; the real app
      was pulled forward this session — see the top bullet)** → scoring harness →
      workflows/provisioning. Owner decisions locked (2026-09-05): watchlist
      advisor-owned (quarterly proposal, no auto-mutation), screener format-spec +
      fixture now with real CSV as live test, **OpenRouter** for the weekly LLM,
      Sammaan in Phase 1 (rest of legacy cleanup stays Phase 2). **Next:** owner plan
      review + sign-off, then Task 1 (Sammaan maturity, time-boxed — bond matures
      26-Sep-2026).

- [x] **Fidelity RSU Telegram flow — SHIPPED 2026-09-05** (the dead end is gone). Flow:
      screenshot → `extractRsuVestsFromImage` (`{vests}`) → priced proposal queue →
      `/confirm <#>|all` writes ACTUAL `rsu_vests` via `confirmVest`; `/reject` clears it;
      /`fidelity` wired; `saveStatementPhoto` short-circuits on existing files; digest
      stops announcing confirmed vests. 13 new tests; suite 432 → 444 (see MEMORY § Fidelity
      flow). **Remaining = the live test** — see Waiting on OWNER.
      NOTE: the 78 US:NOW shares in today's digest come from `pnpm seed` (hardcoded from
      numbers the owner pasted in chat, 2026-08-24/09-05 session) — NOT from any Telegram
      flow.

- [ ] **Reconcile `tests/jobs/workflow-schedule.test.ts` to the digest gating change.**
      Its `cronOf()` throws "no cron in digest.yml" — `digest.yml` has no cron by design
      since `30b47d3` (fires on sync success). The suite's one persistent red. Needs an
      owner decision: update the assertion to the `workflow_run` shape, or drop the
      freshness-cron assertion for digest.yml. Don't silence it silently. **Folded into
      Phase 1 Task 11** (weekly.yml → Sunday 10:00 IST needs the same re-derivation, with
      owner sign-off on the cadence change) — the two decisions land together.

- [ ] **Sammaan bond maturity modeling** — now **Phase 1 Task 1** (plan 2026-09-05).
      INE148I07GL3 matures **26-Sep-2026** (~3 weeks): ₹3,00,000 face + final coupon ≈
      ₹27,000 redeems to cash, retiring half the bond bucket and pushing CASH above its
      band. 14-day digest alert + IPS routing recommendation. All inputs owner-verified
      in seed data. Pure TDD task, no owner input required.

- [ ] **FX BLOCKs every weekend by construction (surfaced 2026-09-07, NOT new).**
      `FRESHNESS_HOURS.fx = 48h`, but frankfurter publishes ECB rates on weekdays only, so a
      normal Fri→Mon gap is ~72h. Observed Sunday 2026-09-06: open `STALE_DATA/BLOCK` on
      `frankfurter` at 63.4h with **no** `SYNC_FAILURE` — the fetch is fine, the limit is wrong
      for the publication calendar. Separately the Friday 09-04 rate looks never ingested
      (latest stored is Thu 09-03) — that part is unexplained. Same "widen the band vs fix the
      model" call as the digest cron test: do NOT just raise 48h without deciding which it is.
      `composite` is also permanently BLOCK having never produced a row — arguably it belongs
      in the `unimplemented` state alongside amfi/bhavcopy/screener.

## Waiting on OWNER

- [ ] **Phase 1 plan review + sign-off** — `docs/superpowers/plans/2026-09-05-sentinel-phase-1.md`
      (scope calls 1–7 on the first page; esp. the weekly cadence change Sat→Sunday 10:00 IST
      per PRD §12.2, Task 11) and the ~40-name starter watchlist (Task 6 seed, before the
      first weekly report)
- [ ] **Real Fidelity statement — the live test of the new flow.** Send the next statement
      screenshot to the bot and `/confirm`; it also resolves the per-grant/tranche RSU
      split true-up (model carries ₹57.05L vs PRD's ₹53.25L; never tune the value to close
      the gap)
- [ ] Decision on the stale `workflow-schedule.test.ts` cron assertion (see Next up)
- [ ] The date each protection milestone was actually set (`milestones.raised_on` —
      "% elapsed" is NULL until then)
- [ ] Monthly electricity figure (closes the ₹82,124 vs PRD ₹76,000 surplus outflow gap)
- [ ] Any NEW holding: send its exchange ticker so `src/sources/statement-tickers.ts`
      can learn it — unknown tickers fall back to weaker line-guess anchoring

## Watch items

- **Digest now depends on sync (changed 2026-09-05, commit `30b47d3`).** `digest.yml` lost
  its fixed 21:00 IST cron; it triggers on `workflow_run` of `sync` and runs only when the
  sync **concludes successfully**. Trade-off accepted: a failed sync = no digest that day.
  Sync cron unchanged `0 12 * * *` (17:30 IST) and slips by hours → digest fires whenever
sync actually lands. Weekly report Sat 08:00 IST (`30 2 * * 6`) and keepalive Sundays
   09:30 IST unchanged. **Weekly → Sunday 10:00 IST pending Phase 1 Task 11 + owner sign-off.**
- **Secrets hygiene.** `TOKEN_ENCRYPTION_KEY` **rotated 2026-09-07** (new key in `.env` +
  GH Actions secret; the key-printing `recover-key.yml` written during the recovery attempt
  was deleted unrun). **`pnpm indmoney:login` re-run and verified** — tokens decrypt against
  the new key, scope `portfolio:read`, refresh token present; the rotation loop is closed.
  **Still un-rotated:** the Telegram bot token and Supabase DB
  password, both of which appeared in plaintext chat (2026-08-25) — BotFather `/token`;
  Supabase dashboard → then update the GH secret + local env.
- Schedules (GitHub Actions, UTC cron, slips a few minutes): **daily digest = after sync success** (`workflow_run` on sync) · **weekly deep report Sat 08:00 IST** (`30 2 * * 6`) · sync daily **17:30 IST** · keepalive Sundays 09:30 IST.
- The interactive bot (`pnpm telegram:bot`) runs locally only — commands, photo uploads,
  confirms need it awake. Digests/syncs do not.
- When extraction misbehaves: check `lots` audit trail (`action='ingest'` /
  `'CLEANUP_CLOSED'`) before touching data; corrections go through supersede, never
  UPDATE-of-cost or DELETE (refused by trigger).
- Statement uploads now ask for type via inline keyboard (Brokerage/MF vs Fidelity RSU) before processing.

## Landed recently (oldest → newest)

| commit | what |
|---|---|
| `5fd0bb8` | live-test defects: /cost order mismatch, double-confirm writes, jsonb double-encoding (8 sites) |
| `b9abca8` | production repair: 89→29 lots audited cleanup; gold identity resolved |
| `148d635` | upload idempotency (unchanged/superseded/created) + migration 0006 unique index |
| `f8cb46c` | digest → nightly 21:00 IST; SDD progress ledger created |
| `fd96bd2` | ticker-anchored proposal resolution + ⚠️ conflict guard on /confirm all |
| `30b47d3` | digest now runs on sync completion (`workflow_run`); fixed 21:00 slot removed |
| `472d801` | untracked `.claude/`, `.serena/`, `zoox_finalTEMP_MPY_wvf_snd.mp4` (were swept into bc728b4); gitignored |
| *(this session)* | web redesign + `/import` ingest flow (migration 0009, LLM extract → owner confirm → real writes; no-key degrade path verified live); `displayOrder`/`resolveProposalTarget` extracted to `proposal-target.ts` |
| `bc728b4` | seed reality fixed (US:NOW 78 @ ₹10.73L, ₹53.42L total); local `pnpm sync` verified; digest gating to sync success (`30b47d3`) |
| *(this session)* | Fidelity RSU flow shipped (extract → priced queue → `/confirm` ACTUAL vests); digest ACTUAL-filter Date fix; 13 new tests; suite 444/1-stale |
| *(this session)* | Phase 1 plan written: `docs/superpowers/plans/2026-09-05-sentinel-phase-1.md` (13 tasks); Sammaan rewritten as Task 1; owner decisions captured |
| *(this session)* | Task 11A preview UI shipped (8081) → owner redirected: "build the real app" → standalone `web/` Next.js app built (16 routes, real data, 3001; next.config .env loader + ips shim); docs updated; **commit pending** |
