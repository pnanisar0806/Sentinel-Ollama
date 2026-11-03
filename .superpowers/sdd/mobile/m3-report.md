# M3: forms, controls, page-level overflow

Branch `mobile/m3`, cut from b21b91b. Apart from this report, the only file changed is `web/app/mobile-forms.css`.

## What changed (desktop untouched; every rule is behind a max-width query)
- At 900px and below:
  - These rows now wrap: `.card-head`, `.goal-top`, `.provider`, `.option-what`, `.page-title`.
  - Prose in `.main` wraps with `overflow-wrap: break-word`.
  - `.mono` (outside tables), `.upload-summary` and `.ips-text` wrap with `anywhere`.
  - Inputs and selects are capped at 100% width.
  - The `.import-kind` toggle wraps.
  - Timeline children get `min-width: 0`.
- At 640px and below:
  - Forms: `.form-row` and `.control-form` drop to one column with full-width fields.
  - Inputs, selects and textareas use 16px text (stops iOS zooming on focus) and are at least 44px tall.
  - Every `.btn`, `.btn-sm`, `.tabs` and `.tabs-sm` button is at least 44px tall.
  - The primary action of `.form`, `.control-form` and `.import-form` is full width.
  - In a `.btn-row`, buttons stretch to fill the row and captions drop to their own line.
  - Inline forms stack full width: `.rule-ctl` (rule button, allow once) and `td .btn-row` (SIP move).
  - Bare `label > input` pairs (login, cleanup controls) are full width.
  - `.notyet` gets tighter padding.

## Tabs: wrap, not a scroll strip
/log has 11 tabs, and code can change which one is selected (the windfall prefill jumps to lump_sum).
In a sideways strip the selected tab could end up off screen. Fixing that needs JS (scrollIntoView),
which is outside this scope. The cost of wrapping is about 4 to 5 rows of pills on a 390px phone.

## Inline width hunt
I grepped every `style={{…}}` in web/app and web/lib (about 125). None can exceed 390px:
- the only fixed widths are `maxWidth: 440/640`, which are caps and shrink fine;
- `width: '100%'` is safe because border-box is set globally;
- the rest are percentage bar fills.

No `.tsx` edits were needed. The fixed-px grids in globals (`.stats` 200px, `.stat-grid` 180px,
`.alloc-legend` 170px) fit inside a 320px column, so I left them alone. That also avoids clashing
with the shell agent's 2-up stat grid.

## Verification
- `pnpm tsc --noEmit -p web`: clean.
- `cd web && pnpm next build`: compiles, 5/5 static pages. The build needs network access for Google Fonts, so it fails inside a sandbox.
- `pnpm vitest run tests/web`: 17 files, 101 tests passed.
- No browser check yet. Prod sign-in is passkey-bound, so the 390px phone check has to wait until after deploy.
