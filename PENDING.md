# PENDING — start here

One screen of what's open, so a new session doesn't have to re-read anything. Updated at
every session end alongside MEMORY.md / progress.md. Contracts & gotchas live in
MEMORY.md; the code map lives in index.md.

## Next up

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
      freshness-cron assertion for digest.yml. Don't silence it silently.

- [ ] **Sammaan bond maturity modeling** — INE148I07GL3 matures **26-Sep-2026** (~1
      week): ₹3,00,000 face + final coupon ≈ ₹27,000 redeems to cash, retiring half the
      bond bucket and pushing CASH above its band. Nothing models maturities yet; the
      surplus curve and IPS drift both need it. All inputs owner-verified in seed data.
      Pure TDD task, no owner input required.

## Waiting on OWNER

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
  09:30 IST unchanged.
- **Secrets hygiene:** the Telegram bot token and Supabase DB password appeared in
  plaintext chat (2026-08-25). Rotation advised (BotFather `/token`; Supabase dashboard)
  → then update the GH secret + local env. **Not done yet.**
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
| `bc728b4` | seed reality fixed (US:NOW 78 @ ₹10.73L, ₹53.42L total); local `pnpm sync` verified; digest gating to sync success (`30b47d3`) |
| *(this session)* | Fidelity RSU flow shipped (extract → priced queue → `/confirm` ACTUAL vests); digest ACTUAL-filter Date fix; 13 new tests; suite 444/1-stale |
