# Sentinel — SDD progress ledger

Phase 0: COMPLETE — plan executed through the whole-branch fix wave + scoped re-review;
PR #1 merged to `main` (2026-08-24). Entries below are post-merge sessions, newest last.
One line per task / defect / decision; details live in MEMORY.md, not here.

## 2026-08-25 (evening session)

- Statement ingestion live-tested by owner against PRODUCTION Supabase. Three defects
  found and fixed with wiring tests: `/cost` line-number/order mismatch (shared
  `displayOrder`), partial `/confirm` double-writes (queue removal), jsonb
  double-encoding of every Supabase audit payload (objects, never JSON.stringify — all
  8 write sites). Commit `5fd0bb8`. Suite 417 → 421.
- Production data repair: 89 lots → 29 open via audited `closed_on` cleanup (DELETE is
  refused by design); gold identity resolved (owner's "GoldCase" = IND:INDS29570);
  redundant inline bot entrypoint struck (fix-on-touch). Commit `b9abca8`.
- Upload idempotency per owner request: `insertOwnerCostLot` now no-ops on identical
  value, supersedes on change, creates when new; migration `0006` adds a partial unique
  index (one OPEN owner lot per instrument+account) enforced in SQL. Mapping fix:
  INDmoney code `118186` is Apple Inc., not a basket aggregate (`US:AAPL`). Commit
  `148d635`. Suite 424.
- Owner verified four `/holdings` questions: ICICI Nifty 50 held on both platforms;
  both Tata Motors entities real (screenshot exposed our swapped costs — corrected in
  production through the supersede path); US basket line was Apple mislabeled;
  Reliance Power residual recognized.
- Digest workflow moved from weekday-morning (08:45 IST) to nightly **21:00 IST**
  (`cron '30 15 * * *'`) per owner choice. Live only once pushed.
- Late-night re-upload re-swapped TMCV's lot (LLM line-anchor flip on near-identical
  names — nondeterministic across runs). Re-corrected via supersede; gotcha recorded in
  MEMORY: eyeball the proposal card's target instrument before confirming near-identical
  names.

## 2026-09-05 (session)

- Owner reported digest still reading stale data (₹46.54L assets / ₹13,422 fidelity, manual-seed
  "STALE 288h"). Root cause: DB held only the old 2026-08-24 manual-seed snapshot (US:NOW qty 1
  @ ₹5L). Re-ran `pnpm seed` → fresh 2026-09-04 manual-seed snapshot persisted with **US:NOW 78
  @ ₹10,72,974 → ₹53.42L total**, verified by query. Local `pnpm sync` now works against
  `data/indmoney-snapshot.json` (`synced: indmoney, frankfurter`).
- GOTCHA: three earlier `pnpm seed` runs printed "Seeded snapshot <id>" yet persisted NOTHING
  (pooler port 6543 churn) — verify by querying snapshots, not by trusting the printed id.
- Digest gated on sync: `digest.yml` now `workflow_run` on sync success (commit `30b47d3`);
  fixed 21:00 cron removed; sync cron unchanged. Trade-off: sync failure ⇒ no digest that day.
- Cleanup commit `472d801`: untracked + gitignored `.claude/`, `.serena/`,
  `zoox_finalTEMP_MPY_wvf_snd.mp4` (swept into bc728b4); deleted temp `check-*.ts`/`test-insert.ts`.
- **Fidelity Telegram flow diagnosed as a dead end** (owner asked what an upload does): parser
  schema mismatch (`{items}` vs `{vests}`), queue writers never called, `/confirm` writes cost
  lots only, `/fidelity` is a stub. 78 shares came from seed hardcoding, not Telegram. **Fix
  agreed for next session** — see `PENDING.md`.

## 2026-08-26 (late-night session)

- Owner pasted a proposal card proving the swap mechanism precisely: values read
  correctly, but anchoring assigned TMCV's cost to TATAPOWER's row and proposed TMPV
  twice (once per album batch). Confirmed writes were last-write-wins.
  Production re-corrected (TMCV ₹18,789.88 / TMPV ₹41,530.77 / TATAPOWER ₹27,074
  verified open).
- Structural fix shipped: `statement-tickers.ts` owner-verified symbol map overrides
  line-guess anchoring (`resolveProposalTarget`); extraction prompt carries the symbol
  mappings; conflicting proposals for the same holding are flagged ⚠️ and skipped by
  `/confirm all` (explicit `/confirm <#>` overrides). Suite 424 → 432. Commit pending.
- Digest schedule moved to nightly 21:00 IST + SDD progress ledger created (was
  referenced by CLAUDE.md but missing) — `f8cb46c`. Push still awaited from owner;
  bot code takes effect locally on next restart.

## 2026-09-05 (evening session)

- **Fidelity RSU flow shipped** (dead end diagnosed this morning). Verified chain: statement
  screenshot → `extractRsuVestsFromImage` via the new shape-free `extractJsonFromImage` LLM pass
  (Fidelity `{vests:[…]}`, no longer forced through the brokerage `{items}` parser) →
  `fidelityVestsToProposals` priced with the SAME `UNITS_SCALE`/`toUnitsMicros` that `rsu.ts`
  exports (proposal gross = `confirmVest` recompute, net ≤ gross by construction) → queued in
  `fidelityPending` → `/confirm <#>|all` writes ACTUAL `rsu_vests` via PROJECTED `persistVests`
  row-ensure + `confirmVest` (two top-level calls; grants never auto-created FR-02; missing-grant
  and confirmed entries consumed so cost confirms never block). `/fidelity` wired, `/reject`
  clears both queues, `saveStatementPhoto` short-circuits on existing files.
- **Digest double-announcement bug fixed**: confirmed ACTUAL vests were re-forecast because the
  confirmed-filter key was built from bare `String(vest_on)` under PGlite's DATE→Date behavior;
  now normalized exactly like `granted_on` (`toISOString().slice(0,10)`). Guard test "no double
  forecast" added to the digest suite.
- Suite 432 → **444 passed** (+6 fidelity-ingest, +5 telegram-bot-fidelity, +1 digest guard);
  sole red = stale `workflow-schedule` digest.yml cron assertion — surfaced to owner, decision
  awaited (see `PENDING.md`); not silently edited.
- RSU per-grant split true-up (₹57.05L vs PRD ₹53.25L) is now resolvable live: the next real
  Fidelity statement carries per-grant units/vest dates and doubles as the end-to-end live test.
