# Mobile pass — design (owner-approved 2026-11-02/03)

Owner: "the mobile version is looking very bad … this app should be properly mobile friendly; everything
is now left aligned in mobile." Owner screenshots: (1) the 24-link sidebar stacks on top of every page
with a dark strip to its right; (2) DataTable columns squeezed so fund names wrap one word per line.

## Root causes
1. Below 900px `.shell` drops to one column and `.nav` becomes a static full-height block above content.
2. Wide content (DataTable, inline `style={{width/minWidth}}`, long ids) makes the document wider than
   the viewport, so the phone renders a zoomed-out page: content sits in the left part ("left aligned")
   with an empty strip on the right. Measured: /log at 390px → scrollWidth 653.

## Goals
- No page scrolls sideways at 390px (document scrollWidth ≤ viewport width) — the "left aligned" fix.
- Phone shell: sticky slim top bar (brand mark, current page title, ☰ button). ☰ opens a drawer with
  the full grouped nav (same GROUPS); choosing a page, Esc, or tapping the backdrop closes it; focus
  trapped while open; body scroll locked. Desktop (≥ 900px) sidebar unchanged.
- Tables: below 640px every `DataTable` row becomes a card — first column as the card title (full
  width, bold), remaining columns as `label · value` rows, right-aligned values; numeric columns keep
  tabular nums. Desktop table unchanged. Empty label columns (label '') render the value without a label.
- Look good, not just fit: consistent 16px page gutters, 12–16px card padding, readable type scale on
  phone (page title ~22px, body 14–15px), stat tiles in a 2-up grid (1-up below 360px), pills wrap,
  buttons and inputs ≥ 44px tall, forms single-column full-width, notices and cards full-width with
  balanced spacing, nothing hugging the left edge, safe-area insets respected.
- Long text, ids, mono strings wrap (`overflow-wrap:anywhere`) instead of widening the page.
- Every existing page reviewed at 390px; page-specific fixes where shared fixes are not enough.

## Non-goals
- No change to desktop look. No new visual language: same tokens, colours, primitives (MASTER.md).
- No new pages, no data changes.

## Constraints
- Reuse `web/lib/ui.tsx` primitives; changes there must keep every caller working.
- Accessibility: drawer is a real dialog (aria-modal, labelled), button has aria-expanded/controls,
  reduced-motion respected.
- Verification: owner's session is passkey-bound to prod, so phone checks run on prod in a 390px frame
  after deploy; a follow-up fix push is expected and fine.
