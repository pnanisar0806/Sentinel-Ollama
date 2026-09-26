'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** Live = shipped today. Soon = Phase-1 shelves (rendered dim + disabled-looking). */
const GROUPS: {
  label: string;
  color: string;
  items: { href: string; label: string; stage: 'live' | 'soon' }[];
}[] = [
  {
    label: 'Portfolio', color: '#818cf8',
    items: [
      { href: '/', label: 'Overview', stage: 'live' },
      { href: '/holdings', label: 'Holdings', stage: 'live' },
      { href: '/allocation', label: 'Allocation', stage: 'live' },
      { href: '/buckets', label: 'Goals', stage: 'live' },
      { href: '/rsu', label: 'RSU', stage: 'live' },
      { href: '/funds', label: 'Funds', stage: 'live' },
    ],
  },
  {
    label: 'Act', color: '#34d399',
    items: [
      { href: '/approvals', label: 'Approvals', stage: 'live' },
      { href: '/recommendations', label: 'Recommendations', stage: 'live' },
      { href: '/log', label: 'Log what I did', stage: 'live' },
      { href: '/cleanup', label: 'Cleanup & controls', stage: 'live' },
      { href: '/maturity', label: 'Maturity', stage: 'live' },
    ],
  },
  {
    label: 'Research', color: '#38bdf8',
    items: [
      { href: '/watchlist', label: 'Watchlist', stage: 'live' },
      { href: '/signals', label: 'Signal review', stage: 'live' },
      { href: '/scoring', label: 'Scoring', stage: 'live' },
      { href: '/narrative', label: 'Weekly narrative', stage: 'live' },
    ],
  },
  {
    label: 'Governance', color: '#fbbf24',
    items: [
      { href: '/rails', label: 'Owner rails', stage: 'live' },
      { href: '/ips', label: 'IPS', stage: 'live' },
      { href: '/freshness', label: 'Data freshness', stage: 'live' },
      { href: '/audit', label: 'Audit log', stage: 'live' },
    ],
  },
  {
    label: 'System', color: '#c084fc',
    items: [
      { href: '/import', label: 'Import statements', stage: 'live' },
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
    </aside>
  );
}

function resolve(href: string): string {
  return href.length > 1 ? href.replace(/\/$/, '') : href;
}