# Sentinel — agent operating instructions

Single-user, approval-gated personal investment intelligence agent for the owner
(Anirban Sarkar). Built from a frozen PRD. Currently building **Phase 0**.

## Session start protocol — DO THIS FIRST, EVERY SESSION

Before any other tool call, read these three files in order:

1. `MEMORY.md` — durable project state: decisions, contracts, gotchas, open questions.
2. `index.md` — map of the repo: what lives where, what each module exports.
3. `.superpowers/sdd/2026-08-12-sentinel-phase-0/progress.md` — the per-task SDD ledger.

Do **not** re-read the plan (`docs/superpowers/plans/2026-08-12-sentinel-phase-0.md`,
~4,700 lines) end to end. Read only the section for the task you are about to run.

## Session end protocol — DO THIS AFTER EVERY TASK OR MEANINGFUL PROGRESS

Update, in the same commit as the work:

- `progress.md` — the ledger line for the task (complete / fix round N / deferred minor).
- `MEMORY.md` — only if a *durable* fact changed: a decision, an interface, a gotcha,
  an owner true-up item, a corrected assumption.
- `index.md` — only if files were added, moved, or their exports changed.

Keep all three terse. They are read in full at every session start; length is a tax.

## Hard constraints from the PRD — never violate, never soften

- **No trading paths.** No F&O, no intraday, no leverage, no loan-against-securities.
  These are *absent code paths*, not disabled features. There is no override flag.
- **No autonomous execution.** Every order requires fresh human approval. No standing
  auto-execute rules.
- **Single user.** No multi-tenancy, no accounts, no sharing. Do not add features that
  make sharing recommendations easier.
- **No stored broker passwords or TOTP secrets.** Human-in-loop unlock *is* the security
  model.
- **Secrets** live in GitHub Actions secrets / Vercel env vars. Never in the repo, never
  in the DB, never in a test fixture.
- **Telegram** bot is locked to the owner's chat ID; every other ID is ignored.
- **Audit immutability.** Append-only tables, enforced by triggers (UPDATE, DELETE *and*
  TRUNCATE) plus RLS in Supabase.
- **The Kolkata property is not an optimization target.** Never recommend selling or
  renting it.
- **`funded_status` is unreadable by any sizing or risk function.** No catch-up behavior.
  There is an architecture test enforcing this (Task 10).

## Working rules

- **Money is never a float.** Branded `bigint` paise/cents only — see `src/money/paise.ts`.
- **Never invent a number to close a gap.** If the PRD's stated total disagrees with the
  line items, document the discrepancy in a comment and add it to the owner true-up list
  in `MEMORY.md`. Do not tune a value to make a test pass.
- **Never widen a test band to make a red test green** without first proving the model is
  right and the band's premise is wrong — then say so to the owner rather than editing
  the band silently.
- **TDD.** Write the failing test, *verify it fails*, implement, verify it passes, commit.
  A guard-rail test that hard-codes both sides of its comparison tests nothing; derive one
  side from the real data structure and mutation-check it.
- **Every externally-sourced row carries `as_of` and `source`.** No exceptions.
- Unknown cost basis is `NULL`, never `0`. Never render an unknown as ₹0.

## Execution model

Work runs subagent-driven: implementer → task reviewer → fix loop (≤5 rounds) → scoped
re-review → ledger entry. Task briefs are generated with the
`superpowers:subagent-driven-development` skill's scripts from the repo root:

    <skill>/scripts/task-brief   docs/superpowers/plans/2026-08-12-sentinel-phase-0.md N
    <skill>/scripts/review-package docs/superpowers/plans/2026-08-12-sentinel-phase-0.md BASE HEAD

Skill base: `C:\Users\Anirban\.claude\plugins\cache\claude-plugins-official\superpowers\6.2.0\skills\subagent-driven-development`

**The briefs are stale on `Db`.** Every dispatch must restate the real interface — see
`MEMORY.md` § Contracts.

## Environment

Windows 11, PowerShell primary (Bash tool also available). pnpm. No Docker, no local
Postgres — tests run against PGlite (WASM Postgres). TypeScript everywhere; vitest.
