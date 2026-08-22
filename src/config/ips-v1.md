# Investment Policy Statement — Version 1

**Owner:** Anirban Sarkar
**Effective:** 2026-08-12
**Binding:** Every recommendation must cite the clause(s) it serves. Changes require
explicit owner action outside a drawdown and take effect after a 48-hour cooling-off.

## 3.1 Philosophy
Long-term, tax-aware, evidence-based investing for a specific household's goals. The owner
is an investor, not a trader. Activity is a cost. The default action is no action.

## 3.2 Objective function
Maximize risk-adjusted return subject to a 30% maximum portfolio drawdown constraint. Funded-status vs the FI band is a REPORTING metric reviewed annually; it must never increase risk-taking after underperformance ("catch-up" behavior is prohibited by construction).

## 3.3 Strategic asset allocation (portfolio-level, across B1 primarily)
- Equity ceiling ~60% of total investable assets (calibrated so a 2008-grade equity crash ≈ −25 to −30% portfolio drawdown).
- Gold: 5–10% band (via existing Zerodha Gold ETF; gold fund-of-fund on Coin acceptable for SIP automation).
- Debt/EPF/cash: remainder; EPF counts as debt-like.
- B2 (house fund): 100% capital-preservation instruments once seeded.

## 3.4 Equity structure: core–satellite 75/25
- **Core (≥75% of equity flows):** index instruments (Nifty 50, Nifty Next 50, flexi-cap of PPFC type, US index exposure) — consolidate into the existing ICICI Nifty 50 Index folios and BeES ETFs.
- **Satellite (≤25% of equity):** agent-recommended direct stocks, each with a ≤150-word written thesis containing an explicit falsification condition. Operates on the curated watchlist (Section 8).

## 3.5 Hard concentration caps (safety rails, machine-enforced)
- Any single stock: ≤10% of liquid portfolio.
- Any single issuer across equity + credit instruments: ≤10%.
- Any single MF scheme: ≤35%.
- Any single sector (direct-equity book, ex-index funds): ≤25%.
- Employer stock (NOW): ≤10% of liquid portfolio, enforced via systematic sell-on-vest of the excess.

## 3.6 Universe
- **In:** Indian listed equity (non-penny, per 11.2), Indian MFs (direct plans only), Indian listed ETFs, US stocks/ETFs (advisory-only via INDmoney), listed bonds already held (legacy), gold ETF/FoF, liquid/arbitrage/debt funds, EPF.
- **Out:** F&O, intraday, leverage/margin/LAS (never); crypto (out; revisit clause on owner request only); REITs (deferred until after Hyderabad purchase, revisit 2035 — rationale: existing real-estate factor concentration); smallcase products (terminated — see 3.9); unlisted anything.

## 3.7 Trading discipline
- ≤4 recommended actions per month.
- 12-month minimum holding period (also the equity LTCG boundary), overridable only by: thesis falsification, red-flag event (fraud/auditor/pledge), or hard-cap breach.
- Rebalancing: hybrid — annual calendar rebalance + ±5% drift bands checked monthly. Band breach generates a recommendation, not an auto-trade.
- SIPs continue through drawdowns. Stop-events only: job loss >3 months; medical expense >₹30L.

## 3.8 Credit rule
Slab-taxed credit-risk paper must beat the owner's highest loan rate (currently 7.95%, fully post-tax-equivalent since new regime gives no interest deduction) **after tax and after a credit-risk haircut**, else the money prepays debt or buys risk-free instruments instead. Legacy positions failing this rule (Sammaan Jul-2029, Edelweiss Oct-2033) are standing review items for the agent's first live session.

## 3.9 Legacy cleanup mandate (owner-consented)
- All four smallcase subscriptions (Equity & Gold Asset Allocation, Dividend Aristocrats, Timeless Asset Allocation, House of Mahindra tracker) are **terminated** at v1 launch. The constituent ETFs (BeES, Junior BeES, Gold, Liquid) remain as direct holdings under agent management.
- Every holding without a live thesis is a consolidation candidate. Consolidation is executed tax-aware: harvest gains against the ₹1.25L/year equity LTCG exemption, spread over 1–2 fiscal years, FIFO lots.
- Micro-orphans (positions <₹5k) are consolidated first; the Groww Reliance Power position is flagged for manual closure (no Groww integration).
- Sammaan Sep-2026 maturity proceeds route to B3 (emergency fund) — pre-approved standing instruction, still surfaced for confirmation at the event.

## 3.10 Behavioral protocol
At −20% portfolio drawdown from peak: agent surfaces this IPS, the owner's 2022 history, and requires a typed justification before processing any SIP pause or panic-sell request. All such events are logged and replayed in the recovery report.