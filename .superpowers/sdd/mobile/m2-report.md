# M2 — tables on phones (mobile/m2)

Done
- `DataTable` (web/lib/ui.tsx): one-line change, every `<td>` carries `data-label={col.label}`. No duplicate DOM.
- web/app/mobile-table.css, all under `max-width: 639.98px` (desktop untouched):
  - rows → cards; first cell = title (15px/650, no label); other cells = floated uppercase label + right-aligned
    value, tabular nums, `overflow-wrap:anywhere`; label '' → value only; empty cell hidden; thead visually hidden
    (kept for screen readers). Leading unlabelled control (/import checkbox) sits beside the title (next cell).
  - row tones keep their text colour and gain a 3px inset edge + tinted border (red, amber/warn, green, indigo).
  - `.stats`/`.stat-grid` 2-up (1-up < 360px); `.bento` cells single column, except `.span-3` holding a `.stat`
    which stays 2-up (1-up < 360px); stat padding 14px, value 20px.
  - card padding 14px 16px, card-head wraps; page title 22px, page-sub 14px/1.55; notice full width;
    `.mono`, card bodies, page-sub, notices, stat-sub, muted wrap anywhere.
- Raw `<table>`: grep of web/app finds none — the only `<table` is DataTable itself (~19 pages use it), so no
  scroll wrappers were needed.

Verify
- tsc -p web clean; `next build` OK; `vitest run tests/web` 18 files / 102 tests green (incl. new
  tests/web/data-table-labels.test.ts, seen red before the change).
- Static harness with real globals.css + mobile-table.css at 390px and 340px: scrollWidth < viewport; desktop
  layout unchanged. Not checked against live pages (prod passkey) — needs the post-deploy 390px pass.

Concerns
- Pre-existing desktop bug, not fixed (desktop out of scope): `rowTone` 'amber' emits `tr-amber`, but globals.css
  only styles `tr-warn`, so /maturity's <=30-day rows have no tone on desktop. Mobile CSS styles both.
- `.main` gutters (16px spec) belong to the shell stylesheet (M1); not touched here.
- `:has()` used for bento stat tiles; browsers without it fall back to 1-up (harmless).
