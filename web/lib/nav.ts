/** Live = shipped today. Soon = Phase-1 shelves (rendered dim + disabled-looking). */
export const GROUPS: {
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
      { href: '/advisor', label: 'Advisor', stage: 'live' },
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

export function resolve(href: string): string {
  return href.length > 1 ? href.replace(/\/$/, '') : href;
}

/** Phone top-bar title: the nav label of the page, or of its section (/approvals/42 → Approvals). */
export function pageTitle(path: string): string {
  const p = resolve(path);
  let best: { href: string; label: string } | undefined;
  for (const g of GROUPS) {
    for (const it of g.items) {
      const hit = it.href === '/' ? p === '/' : p === it.href || p.startsWith(it.href + '/');
      if (hit && (!best || it.href.length > best.href.length)) best = it;
    }
  }
  return best?.label ?? 'Sentinel';
}
