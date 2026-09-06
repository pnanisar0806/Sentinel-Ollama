'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Live = shipped today. Soon = Phase-1 shelves (rendered dim + disabled-looking). */
const GROUPS: {
  label: string;
  items: { href: string; label: string; stage: 'live' | 'soon' }[];
}[] = [
  {
    label: 'Portfolio',
    items: [
      { href: '/', label: 'Overview', stage: 'live' },
      { href: '/holdings', label: 'Holdings', stage: 'live' },
      { href: '/allocation', label: 'Allocation', stage: 'live' },
    ],
  },
  {
    label: 'Intake',
    items: [
      { href: '/import', label: 'Import statements', stage: 'live' },
    ],
  },
  {
    label: 'Governance',
    items: [
      { href: '/rails', label: 'Owner rails', stage: 'live' },
      { href: '/rsu', label: 'RSU', stage: 'live' },
      { href: '/ips', label: 'IPS', stage: 'live' },
      { href: '/freshness', label: 'Data freshness', stage: 'live' },
      { href: '/audit', label: 'Audit log', stage: 'live' },
    ],
  },
  {
    label: 'Phase 1',
    items: [
      { href: '/watchlist', label: 'Watchlist', stage: 'soon' },
      { href: '/signals', label: 'Signal review', stage: 'soon' },
      { href: '/recommendations', label: 'Recommendations', stage: 'soon' },
      { href: '/maturity', label: 'Maturity', stage: 'soon' },
      { href: '/narrative', label: 'Narrative', stage: 'soon' },
      { href: '/scoring', label: 'Scoring', stage: 'soon' },
    ],
  },
  {
    label: 'System',
    items: [
      { href: '/product', label: 'Product map', stage: 'live' },
    ],
  },
];

export default function Nav() {
  const path = usePathname();
  return (
    <aside className="nav">
      <div className="nav-brand">
        <span className="brand-mark" aria-hidden="true" />
        <span className="brand-name">Sentinel</span>
        <span className="nav-tag">local</span>
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
                  <span className="nav-label">{it.label}</span>
                  {it.stage === 'soon' ? <span className="nav-chip chip-soon">soon</span> : null}
                </Link>
              );
            })}
          </nav>
        </div>
      ))}
      <div className="nav-foot">Private preview — single owner. Write happens only on your explicit approval.</div>
    </aside>
  );
}

function resolve(href: string): string {
  return href.length > 1 ? href.replace(/\/$/, '') : href;
}