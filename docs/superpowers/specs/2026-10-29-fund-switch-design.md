# Fund switches: log a SIP move, and two separate suggestions per fund — design

Status: owner-approved 2026-10-29. Ships before batch B, together with the SIP-card
fix already committed on `fix/sip-suggestions` (`46184c2`). Behaviour the owner did not state is
marked *my call*.

## 1. Intent

The owner stopped the HDFC Mid Cap SIP in October; from November the same money runs as an
Invesco India Midcap SIP (₹3,001). The HDFC units already bought stay where they are. Sentinel
cannot see any of that: the `/funds` switch check still says "SWITCH HDFC Mid Cap → Invesco" as
though nothing happened, and it has no words for "new money already moved, old units kept".

What the owner wants (2026-10-28/29, his words condensed):

- **Sentinel suggests the best option in the market; the decision is always the owner's.**
- **Two separate suggestions per fund, both same category only** (a better Nifty 50 index fund
  for the ICICI Nifty 50 index fund, a better mid cap for a mid cap — never a different kind):
  1. **The SIP** keeps running until there is a better fund in the same category; then Sentinel
     suggests **moving** it — stop this SIP, start one in the better fund. Sentinel never suggests
     cutting or merely stopping a SIP.
  2. **The money already in the fund** (accumulated units) may also be suggested to move to a
     better fund in the same category. That applies to every fund, SIP or not.
- **A move the owner made is logged** on `/log`, and the switch check reflects it.

Success: after logging the HDFC → Invesco move, `/funds` shows HDFC's SIP as "moved to Invesco"
and gives a separate keep-or-move answer for HDFC's ₹26,269 of units, with the gain the move
would realise. **Every held fund** — all six today, active and index alike — gets both answers
(owner, 2026-10-29).

## 2. Non-goals and anti-goals

**Non-goals:**
- No order, no approval card, no Telegram message. Suggestions are shown on `/funds`; the owner
  acts in INDmoney. (*My call*: a weekly-report line belongs to batch B's "where shown" question.)
- No change to the SIP total or the free envelope; pending mandates in the commitment math stay
  batch B (use 3, SIP change, absorbs this log type later).
- No cross-category suggestion. A fund-mix gap is the fund-mix card's job, not the switch check's.

**Anti-goals** (the feature fails if any of these happens):
- Sentinel suggests cutting a SIP, or stopping one without naming where it moves.
- A move is suggested on short-term evidence: the existing 13.33-point margin on a 100-point
  scale stays the bar for active funds; a month of NAV noise must not cross it.
- An unknown is shown as ₹0 or as a number: an unknown gain, an unknown long/short-term split
  or an unscored fund says so.
- A logged move is edited or deleted. It is reversed by a new row, like every `/log` entry.

## 3. Logging a SIP move (`/log`)

**Form** (*my call* on layout; reuse batch A's form patterns in `web/app/log/log-form.tsx`):
- from: a held MF (picker over current positions);
- to: a fund in the same AMFI category as "from" (picker over `mf_universe` candidates of that
  category, plus held funds of that category);
- monthly amount (₹, > 0) and the first month the new SIP runs (YYYY-MM, not before the current
  IST month minus one);
- optional note.

Refused, with the reason shown: "to" equal to "from"; "to" in another category; an active
(not reversed) move already logged from the same fund.

**Store:** new append-only table `sip_moves` (id, from_instrument_id, to_instrument_id,
amount_paise, first_month, note, as_of, source = 'owner-web'), with the UPDATE/DELETE/TRUNCATE
triggers and RLS-on-no-policy every log table has. `log_reversals.entity` gains `'sip_move'`
(migration widens the check). An audit row is written as for batch A entries.

**Effects of an active move A → B:**
- Switch check, A's SIP answer: "moved to B from <month> (logged <date>)". No further SIP
  suggestion for A.
- SIP card (`getSipSuggestions`): B is that type's fund. Until the INDmoney feed shows B's SIP,
  B's row shows the logged amount as current, labelled "logged, not yet in the feed". A gets no
  new money. Once the feed shows B, the feed amount wins.
- Monthly advisor (`loadFundCandidates`): A is excluded with reason "SIP moved to B"; B is a
  candidate once held.
- Nothing else: the SIP commitment, envelope and goal plan do not read `sip_moves`.

## 4. The switch check: two answers per fund

`/funds` "Switch check" keeps one row per held fund, with two verdict columns.

### 4.1 SIP answer (funds with a live SIP, or a logged move)

- **logged move** → "moved to B from <month>".
- **a better fund clears the bar** → "move SIP to B": stop this SIP, start the same amount in B.
  No tax: past units are untouched.
- **otherwise** → "keep running".
- A fund with no SIP and no logged move shows "no SIP".

### 4.2 Units answer (every held fund)

- **a better fund clears the bar** → "move units to B", with:
  - **gain if sold now** = value − invested (INDmoney's invested amount, `holdings.avg_cost_paise`
    on the live row, which is the fund's total invested, not per unit — checked on the 2026-10-28
    rows: ICICI Nifty 50 ₹6,40,013 invested against ₹6,88,432 value);
    a missing invested amount shows "gain unknown";
  - **tax note:** the long/short-term split needs purchase dates, which Sentinel does not have
    for funds (only one MF lot is on record). Shown as "split unknown — equity gains on units
    held under 12 months are short-term" until purchase history exists. *My call*: no estimated
    tax rupee figure until then; never ₹0.
  - **this FY's LTCG exemption** (₹1.25L, `LTCG_EXEMPTION_PER_FY`) shown as context, with a note
    that a staged move across financial years can keep long-term gains inside it.
- **otherwise** → "keep".

Both answers use the same challenger and bar. *My call*: one bar for both, because the owner set
none; the units answer differs only by showing what the move costs.

### 4.3 Active funds

Unchanged scoring (`evaluateSwitches`, `SWITCH_MARGIN` 13.33 on a 100-point scale) — the
challenger is the best-scoring Direct growth fund in the same AMFI category.

### 4.4 Index funds (new)

Today index funds are skipped: AMFI's "Index Funds" category mixes every index. They are compared
only with funds tracking **the same index**:
- Same-index peers come from INDmoney's category listing with `benchmark_name`, the source the
  US / Next 50 chooser (`index_fund_candidates`) already reads. The table's `fund_type` check
  widens to include `NIFTY50` (migration).
- Eligible: Direct plan, Growth, same benchmark, AUM and SIP-acceptance as the chooser requires.
- Compared on **expense ratio**; tracking error is shown when a source carries it (none did on
  2026-10-26). Returns are not compared: same index, near-identical returns.
- **Bar** (owner-approved 2026-10-29): a challenger must be at least **0.10 percentage points a
  year cheaper**. Below that, a move's paperwork and, for units, its tax are not worth it.
- A held index fund with no same-index peer on record says "no same-index peers on record".

## 5. Constraints

- Money in branded paise (`src/money/paise.ts`); every new row carries `as_of` and `source`.
- Append-only + triggers + RLS for `sip_moves`; reversal via `log_reversals` only.
- The page uses `web/lib/ui.tsx` primitives; design per `design-system/sentinel/MASTER.md`.
- Normal-plan firewall unchanged: nothing here reads goal status.
- Migrations applied to prod before deploy (two: `sip_moves` + reversal entity; widen
  `index_fund_candidates.fund_type`).

## 6. Left to the builder

Picker data sources and form layout; how `sip_moves` joins to the SIP feed (ISIN/canonical id, as
`sipInstrumentKey` does); the daily job change that also reads Nifty 50 index candidates; test
fixtures from the 2026-10-28 live holdings.
