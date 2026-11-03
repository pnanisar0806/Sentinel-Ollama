'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import { GROUPS, pageTitle, resolve } from '../lib/nav';

/**
 * Desktop (> 900px, the globals.css breakpoint): the sticky sidebar, unchanged. Phone: a slim top
 * bar whose menu button opens the same nav in a native modal <dialog> drawer — showModal() gives
 * the focus trap, the inert page behind it and Esc-to-close.
 */
export default function Nav() {
  const path = usePathname();
  const drawer = useRef<HTMLDialogElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);

  // Close on any navigation (incl. back/forward) and if the viewport grows to desktop width.
  useEffect(() => { drawer.current?.close(); }, [path]);
  useEffect(() => {
    const mq = window.matchMedia('(min-width: 901px)');
    const onChange = () => { if (mq.matches) drawer.current?.close(); };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return (
    <>
      <header className="topbar">
        <Link href="/" className="topbar-home" aria-label="Sentinel — go to Overview">
          <span className="brand-mark" aria-hidden="true" />
          <span className="topbar-title">{pageTitle(path)}</span>
        </Link>
        <button
          ref={button}
          type="button"
          className="topbar-menu"
          aria-label="Open navigation"
          aria-expanded={open}
          aria-controls="nav-drawer"
          onClick={() => {
            drawer.current?.showModal();
            // Chrome would otherwise focus the scrollable nav container, not a control.
            drawer.current?.querySelector<HTMLElement>('.drawer-close')?.focus();
            setOpen(true);
          }}
        >
          <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        </button>
      </header>

      <aside className="nav nav-side">
        <NavBody path={path} />
      </aside>

      <dialog
        ref={drawer}
        id="nav-drawer"
        className="drawer"
        aria-modal="true"
        aria-labelledby="nav-drawer-title"
        onClose={() => { setOpen(false); button.current?.focus(); }}
        // A tap on the backdrop lands on the <dialog> element itself; a tap on a link navigates.
        onClick={(e) => {
          const t = e.target as HTMLElement;
          if (t === e.currentTarget || t.closest('a')) e.currentTarget.close();
        }}
      >
        <div className="nav">
          <NavBody path={path} titleId="nav-drawer-title" onClose={() => drawer.current?.close()} />
        </div>
      </dialog>
    </>
  );
}

function NavBody({ path, titleId, onClose }: { path: string; titleId?: string; onClose?: () => void }) {
  return (
    <>
      <div className="nav-brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name" id={titleId}>Sentinel</span>
        <span className="nav-tag">local</span>
        {onClose ? (
          <button type="button" className="drawer-close" aria-label="Close navigation" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        ) : null}
      </div>
      {GROUPS.map((g) => (
        <div className="nav-group" key={g.label}>
          <div className="nav-group-label">{g.label}</div>
          <nav aria-label={g.label}>
            {g.items.map((it) => {
              const active = it.stage === 'live' && path === resolve(it.href);
              return (
                <Link
                  key={it.href}
                  href={it.href}
                  className={it.stage === 'soon' ? 'nav-planned' : undefined}
                  aria-current={active ? 'page' : undefined}
                >
                  <span className="nav-dot" style={{ background: g.color }} aria-hidden="true" />
                  <span className="nav-label">{it.label}</span>
                  {it.stage === 'soon' ? <span className="nav-chip chip-soon">soon</span> : null}
                </Link>
              );
            })}
          </nav>
        </div>
      ))}
      <div className="nav-foot">Private preview — single owner. Write happens only on your explicit approval.</div>
    </>
  );
}
