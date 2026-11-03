# SIPs fill the budget + new SIPs count the day they are logged (owner, 2026-11-03)

## Owner decisions (chat, 2026-11-03)
1. "Better steady SIP, whole 50k": the Suggested SIPs card plans SIPs for the WHOLE investable budget
   (budget − goal set-aside), not a re-split of today's SIP total. Steady SIPs beat one-off buys
   (CLAUDE.md: the advisor invests for the long term).
2. Until an Indian S&P 500 / US index fund is open to SIPs, the US share is spread over the other
   funds by the same mix; it returns to US automatically once the chooser has an eligible US fund.
3. "Build the log, otherwise Sentinel will be very late to know about new SIPs. And log should actually
   be accounted for, not just for the sake of logging." INDmoney's `mf_sips` lists ACTIVE SIPs only
   (verified live 2026-11-03: stopped, paused and not-yet-mandated SIPs are absent; Invesco registered
   2026-10-13 is still missing) — so an owner-logged SIP must count everywhere a feed SIP counts.
4. Edelweiss Nifty Next 50 SIP amount = whatever the card suggests once it plans the full budget; the
   owner will log/adjust from the card.

## Bug these fix (live, 2026-11-03)
Overview "SIPs this month" reads ₹13,902 (feed only: Parag Parikh 11,001 + Bandhan 2,901) though the
owner logged ICICI→Navi ₹14,001 and HDFC→Invesco ₹3,001 moves. The envelope therefore shows ₹36,098 free,
which is wrong by ₹17,002 — logged moves are display-only today (they feed the SIP card, not the
commitment/envelope).

## A — Suggested SIPs plan the full budget (src/domain/fund-mix.ts, src/domain/sip-advice.ts)
- Target total = investable = budget − set-aside (`investablePaise`). Split it across fund types by the
  existing weights (midpoint + gap, 0 for no-new-money types, non-core capped at 30%). Within a type the
  existing order applies (pro rata to top-uppable SIPs → largest held top-uppable fund → new-fund row).
- Never cut a SIP (unchanged). If kept SIPs + increases exceed investable, `capToBudget` scales increases
  (unchanged). Rounding to ₹100 with the remainder to the Nifty 50 anchor (unchanged).
- A type with no fund to receive money (US today: no eligible fund open, none held top-uppable) gets weight
  0 and its share is spread by the same weights over the others; its row says why ("US index: no fund
  open to SIPs — its share went to the others"). Holding rules' refused money keeps working.
- Copy: card aside / `sipCapSentence` / weekly SIP block say SIPs are planned up to the budget.
- Tests: suggested total = investable when room exists (exact paise); kept SIP above its share stays;
  US with no fund → 0 and total still = investable; US with an eligible fund → gets its share.

## B — Log a new SIP, and logged SIPs count (migration 0043, src/domain/sips.ts, owner-log, web)
- Table `sip_starts` (instrument_id → instruments, amount_paise > 0, first_month YYYY-MM, occurred_on,
  note, as_of, source) — append-only + RLS; reversal entity `sip_start` (owner audit row with rowId).
- `logSipStart(db, {on, instrumentId, amountPaise, firstMonth, note})`: refuses an MF that already has an
  active feed SIP or an active logged start/move-to (alias-matched), first month before the previous IST
  month, non-MF instruments.
- **Accounting:** `loadSipCommitment` adds a logged stand-in for (a) every active `sip_start` and (b) every
  active `sip_moves` "to" fund, from its first month onward, while the latest feed snapshot does not list
  that fund (alias match) — then the feed amount wins. Stand-ins are flagged `logged: true` and count in
  `totalPaise`, the envelope, Overview "SIPs this month", the SIP card and the weekly report. A move's
  "from" SIP still listed by the feed is dropped from the total from the move's first month (no double
  count). Remove the now-duplicate stand-in logic from `loadSipSuggestions` (it reads commitment).
- UI: /log tab "Start a new SIP" (fund picker: held MFs + registered index/universe funds, amount, first
  month pills this/next, note). /funds Suggested SIPs: a new-fund or ₹0-current row gets **Started** (amount
  prefilled with the suggestion, first-month pills) — same component style as the switch-check Done.
  Logged rows show "logged, not yet in INDmoney". Overview SIP table lists logged rows with that badge.
- Tests: commitment total includes a logged start from its first month, not before; feed listing the fund
  replaces the stand-in (no double count); move's to-fund counts and from-fund stops; reversal removes it.

## Constraints
CLAUDE.md hard rules (money bigint paise; as_of/source; append-only; never ₹0 for unknown; UI honesty;
backend+UI ship together; mobile 390px check). No change to the advisor firewall.
