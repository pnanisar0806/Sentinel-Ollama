# M1 — phone shell (branch mobile/m1)

**Status:** done. Desktop sidebar (> 900px) unchanged; phone gets a sticky top bar and a drawer.

## Changes
- `web/lib/nav.ts` (new): `GROUPS` moved out of nav.tsx unchanged, plus `resolve` and the pure `pageTitle(path)`.
  It matches the nav label exactly or by section prefix (`/approvals/42` → Approvals) and falls back to "Sentinel".
- `web/app/nav.tsx`: renders the `.topbar` (brand mark, title, 44px ☰ button with aria-expanded/aria-controls),
  the desktop `aside.nav.nav-side`, and a native `<dialog id="nav-drawer" class="drawer">` with the same `NavBody`.
  `showModal()` handles the focus trap, the inert page and Esc. aria-modal and aria-labelledby (the brand name) are set explicitly.
  The drawer closes on a link tap, a backdrop tap, the ✕ button, Esc, a pathname change, or the viewport growing past 900px.
  Opening it focuses ✕. Closing it returns focus to ☰.
- `web/app/mobile-shell.css`: the top bar, the drawer's slide-in (`@starting-style`; the global reduced-motion rule
  removes the transition), the backdrop, `html:has(.drawer[open]) { overflow:hidden }` as the scroll lock,
  44px drawer links, and the phone `.main` padding (16px + safe-area). It also sets `grid-template-rows: auto 1fr`,
  because without it the 100vh grid stretched the top-bar row to about 283px.
- `web/app/layout.tsx`: `viewport` export with `viewportFit: 'cover'`, so the env(safe-area-*) insets take effect.
- `web/app/globals.css`: deleted only `.nav { position: static; height: auto; }` from the 900px block.
- `tests/web/nav-title.test.ts` (new): 3 tests for pageTitle.

## Verification
- `pnpm tsc --noEmit -p web`: clean. `pnpm next build`: compiled successfully.
- `vitest run tests/web`: 18 files / 104 tests passing before the final small edit. nav-title re-run after it: 3/3.
- Ran `next start` and measured /login inside a 390px iframe:
  - layout: scrollWidth 390, top bar 56px, main starts at 56, padding 20/16/56, sidebar display:none, ☰ is 44×44
  - drawer: open → `:modal`, focus on ✕, html overflow hidden, links 44px tall; backdrop tap → closed, aria-expanded=false, focus back on ☰
  - at 1280px: sidebar is sticky and 248px, top bar hidden, main padding as before. The drawer auto-closes when resized to that width.
- Not done: screenshots. The Chrome renderer would not paint frames in this environment, so I checked no visuals. Visual check is still owed on prod at 390px.

## Concerns
- The breakpoint follows globals.css: phone is ≤ 900px, desktop is ≥ 901px. The brief said "≥ 900", but switching to that would have split the existing grid collapse at exactly 900px.
- The top-bar title is a plain span, not a heading, so it does not duplicate each page's own h1.
- Slide/backdrop animation needs `@starting-style` and `transition-behavior` (Chrome 117+, Safari 17.5+). Older browsers open the drawer instantly, which still works.
