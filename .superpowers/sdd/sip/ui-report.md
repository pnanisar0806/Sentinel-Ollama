# SIP Part B — UI + tests (branch sip/ui, 2026-11-05)

Status: DONE (browser check at 390px not run — no live DB/dev server here).

## Tests — tests/domain/sip-starts.test.ts (10)
logSipStart: record + audit + reversible timeline; refusals (non-MF, unknown fund, amount <= 0, malformed month,
first month before previous IST month, fund already in feed by ISIN alias, duplicate start, existing move-to);
append-only. Commitment: start counts from first month not before (exact paise); feed listing by ISIN replaces the
stand-in; move "to" counts / "from" stops from first month though feed still lists it; reversal removes it.
Suggestions: logged index start typed NEXT50, no second new-fund row; Next 50 new-fund row carries its MFU id.
Mutation-checked: dropping stand-ins from the total (5 red), not dropping the "from" (1 red), not letting feed win (1 red).

## Defects found by the tests (in c7497a6) and fixed
1. logSipStart's "already in feed" check ignored the feed row's own ISIN — a feed id (IND:*) that is no
   instrument never matched, so a duplicate start was accepted.
2. loadSipCommitment dropped a move's "from" only by sipInstrumentKey — same gap: a stale feed row under an
   IND:* id was counted on top of the "to" stand-in (double count, e.g. HDFC → Invesco).
   Rewrote the block on fundAliases(+feed ISIN)/sameFund; alias work runs only when a logged SIP is active.
   fundAliases/sameFund moved to sips.ts (re-exported from fund-mix) to avoid a cycle.
3. A logged start on an MFU:* index challenger was "type unknown" → the card would still show the Next 50
   new-fund row and suggest it again. `typed` now falls back to metadata.indexType.
4. The Next 50/US new-fund row had instrumentId null → nothing to log. It now carries the chooser pick's
   MFU:* id when that instrument is registered.

## UI
- /log tab "Start a new SIP": fund select (held MFs / other registered MFU funds), amount, first-month pills
  (this / next, default next), date, note → sip_start.
- /funds Suggested SIPs: ₹0-current row with an instrument → Started (amount prefilled with the suggestion,
  month pills, Log it/Cancel); pending start → "logged, starts Mon YYYY" + Undo; counted logged row →
  "logged, not yet in INDmoney" + Undo. Ranking SIP column and Overview SIP table show the same badge.
- product.ts rows updated (works + one honest missing).

## Verify
focused 121/121; full vitest 1737/1737 (171 files); tsc root + web clean; next build OK.

## Concerns
- Once INDmoney lists Edelweiss under its own ISIN, the SIP card types it "type unknown" until that ISIN is
  in FUND_TYPE_BY_ISIN (not added: unverified ISIN). Listed in product.ts missing + PENDING.
- 390px browser check still owed (controls use rule-ctl / tabs-sm, which are 44px on mobile).
