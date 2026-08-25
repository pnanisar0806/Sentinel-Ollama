# PENDING — start here

One screen of what's open, so a new session doesn't have to re-read anything. Updated at
every session end alongside MEMORY.md / progress.md. Contracts & gotchas live in
MEMORY.md; the code map lives in index.md.

## Next up (agreed, not started)

- [ ] **Sammaan bond maturity modeling** — INE148I07GL3 matures **26-Sep-2026** (~4
      weeks): ₹3,00,000 face + final coupon ≈ ₹27,000 redeems to cash, retiring half the
      bond bucket and pushing CASH above its band. Nothing models maturities yet; the
      surplus curve and IPS drift both need it. All inputs owner-verified in seed data.
      Pure TDD task, no owner input required.

## Waiting on OWNER

- [ ] Fidelity statement — per-grant/tranche RSU split (model carries ₹57.05L vs PRD's
      stated ₹53.25L; never tune the value to close the gap)
- [ ] The date each protection milestone was actually set (`milestones.raised_on` —
      "% elapsed" is NULL until then)
- [ ] Monthly electricity figure (closes the ₹82,124 vs PRD ₹76,000 surplus outflow gap)
- [ ] Any NEW holding: send its exchange ticker so `src/sources/statement-tickers.ts`
      can learn it — unknown tickers fall back to weaker line-guess anchoring

## Watch items

- **Secrets hygiene:** the Telegram bot token and Supabase DB password appeared in
  plaintext chat (2026-08-25). Rotation advised (BotFather `/token`; Supabase dashboard)
  → then update the GH secret + local env. **Not done yet.**
- Schedules (GitHub Actions, UTC cron, slips a few minutes): digest **nightly 21:00 IST**
  · sync daily **17:30 IST** · keepalive Sundays 09:30 IST. Live since push 2026-08-26.
- The interactive bot (`pnpm telegram:bot`) runs locally only — commands, photo uploads,
  confirms need it awake. Digests/syncs do not.
- When extraction misbehaves: check `lots` audit trail (`action='ingest'` /
  `'CLEANUP_CLOSED'`) before touching data; corrections go through supersede, never
  UPDATE-of-cost or DELETE (refused by trigger).

## Landed recently (oldest → newest)

| commit | what |
|---|---|
| `5fd0bb8` | live-test defects: /cost order mismatch, double-confirm writes, jsonb double-encoding (8 sites) |
| `b9abca8` | production repair: 89→29 lots audited cleanup; gold identity resolved |
| `148d635` | upload idempotency (unchanged/superseded/created) + migration 0006 unique index |
| `f8cb46c` | digest → nightly 21:00 IST; SDD progress ledger created |
| `fd96bd2` | ticker-anchored proposal resolution + ⚠️ conflict guard on /confirm all |
