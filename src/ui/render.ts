import type { Db } from '../db/client.js';
import {
  buildDigestInput,
  composeDigest,
  type DigestInput,
} from '../notify/digest.js';
import { loadPositions, type Position } from '../domain/networth.js';
import {
  blockedInstruments,
  type StalenessRow,
} from '../sources/staleness.js';
import { formatInr, type Paise } from '../money/paise.js';

export type UiView = 'weekly' | 'digest';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

const compact = (p: Paise) => formatInr(p, { compact: true });
const full = (p: Paise) => formatInr(p, { compact: false });

function headCss(title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<style>
  :root {
    --bg:#07080c; --bg-elevated:#0d0f17; --card:rgba(18,22,33,.85);
    --border:rgba(255,255,255,.06); --text:#f8fafc; --text-dim:#94a3b8; --text-muted:#64748b;
    --green:#10b981; --red:#ef4444; --blue:#3b82f6; --purple:#8b5cf6; --yellow:#f59e0b; --indigo:#6366f1;
    --font:'Plus Jakarta Sans','Outfit',-apple-system,sans-serif;
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:var(--font);background:var(--bg);color:var(--text);min-height:100vh;padding:2rem;line-height:1.6;
    background-image:radial-gradient(circle at 5% 5%,rgba(99,102,241,.12) 0%,transparent 40%),
      radial-gradient(circle at 95% 95%,rgba(236,72,153,.1) 0%,transparent 40%)}
  .container{max-width:1200px;margin:0 auto}
  header{margin-bottom:2rem;border-bottom:1px solid var(--border);padding-bottom:1.5rem}
  .brand h1{font-size:1.75rem;font-weight:800;background:linear-gradient(135deg,#fff 30%,#c7d2fe 70%,#f472b6 100%);
    -webkit-background-clip:text;-webkit-text-fill-color:transparent;letter-spacing:-.03em}
  .brand p{color:var(--text-dim);font-size:.875rem;margin-top:.25rem}
  .header-meta{display:flex;flex-wrap:wrap;align-items:center;gap:.75rem;width:100%;margin-top:1rem}
  .last-updated{background:rgba(255,255,255,.04);padding:.5rem 1rem;border-radius:9999px;font-size:.75rem;
    color:var(--text-dim);border:1px solid var(--border)}
  .nav{display:flex;gap:.5rem;flex-shrink:0}
  .nav a{display:inline-block;padding:.5rem 1rem;border-radius:.5rem;font-weight:600;text-decoration:none;font-size:.875rem}
  .nav a.active{background:var(--indigo);color:#fff}
  .nav a:not(.active){color:var(--text-dim);border:1px solid var(--border)}
  .nav a:not(.active):hover{border-color:var(--border-glow);color:var(--text)}
  .section{margin-bottom:2rem}
  .section-header{display:flex;flex-wrap:wrap;justify-content:space-between;align-items:center;margin-bottom:1.25rem;gap:.75rem}
  .section-header h2{font-size:1.125rem;font-weight:700}
  .card{background:var(--card);border:1px solid var(--border);border-radius:1rem;padding:1.5rem;box-shadow:0 4px 30px rgba(0,0,0,.2)}
  .stats-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:1rem;margin-bottom:2rem}
  .stat-card{background:var(--card);border:1px solid var(--border);border-radius:1rem;padding:1.25rem;position:relative;overflow:hidden}
  .stat-card::before{content:'';position:absolute;top:0;left:0;width:4px;height:100%;background:var(--indigo)}
  .stat-card.liabilities::before{background:var(--yellow)}
  .stat-card.networth::before{background:linear-gradient(to bottom,var(--indigo),var(--purple))}
  .stat-label{font-size:.7rem;font-weight:700;color:var(--text-dim);text-transform:uppercase;letter-spacing:.075em}
  .stat-val{font-size:1.5rem;font-weight:800;margin-top:.5rem;letter-spacing:-.02em}
  .stat-sub{font-size:.75rem;margin-top:.5rem;color:var(--text-muted)}
  .table-wrapper{overflow-x:auto;border-radius:.75rem;border:1px solid var(--border);background:rgba(0,0,0,.15)}
  table{width:100%;border-collapse:collapse;text-align:left;font-size:.8rem}
  th{background:rgba(255,255,255,.02);color:var(--text-dim);font-weight:700;padding:.75rem 1rem;border-bottom:1px solid var(--border);
    text-transform:uppercase;font-size:.65rem;letter-spacing:.075em}
  td{padding:.75rem 1rem;border-bottom:1px solid var(--border);color:var(--text);vertical-align:middle}
  tr:hover td{background:rgba(255,255,255,.015)}
  .num{font-family:'Outfit',monospace;font-size:.825rem;font-weight:600}
  .badge{padding:.25rem .5rem;border-radius:.375rem;font-size:.725rem;font-weight:600;display:inline-block}
  .badge-green{background:rgba(16,185,129,.1);color:var(--green)}
  .badge-red{background:rgba(239,68,68,.1);color:var(--red)}
  .badge-yellow{background:rgba(245,158,11,.1);color:var(--yellow)}
  .badge-blue{background:rgba(99,102,241,.1);color:var(--blue)}
  .badge-dim{background:rgba(255,255,255,.1);color:var(--text-muted)}
  .drift-over{color:var(--red)} .drift-under{color:var(--yellow)}
  .placeholder{border:1px dashed var(--border);border-radius:.75rem;padding:1.25rem;background:rgba(255,255,255,.02)}
  .placeholder h4{color:var(--text-dim);font-weight:700;font-size:.9rem}
  .placeholder p{color:var(--text-muted);font-size:.8rem;margin-top:.5rem}
  .placeholder-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem}
  .blocked{color:var(--red);font-weight:600}
  .digest{background:var(--bg-elevated);border:1px solid var(--border);border-radius:.75rem;padding:1.5rem;
    font-family:ui-monospace,monospace;font-size:.85rem;white-space:pre-wrap;color:var(--text-dim);margin-top:1rem}
  .footer{text-align:center;padding:1.5rem;color:var(--text-muted);font-size:.75rem;border-top:1px solid var(--border);margin-top:2rem}
  @media(max-width:640px){body{padding:1rem}.stats-grid{grid-template-columns:1fr 1fr}.stat-val{font-size:1.25rem}}
</style>
</head>
<body>
<div class="container">`;
}

const foot = `  <div class="footer">Sentinel local preview — read-only. Content functions shared with the Telegram reporter.</div>
</div>
</body>
</html>`;

function pageTop(nav: string, businessDate: string, ipsVersion: number, title: string, subtitle: string): string {
  return `${headCss(title)}
  <header>
    <div class="brand">
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(subtitle)}</p>
    </div>
    <div class="header-meta">
      <div class="nav">${nav}</div>
      <div class="last-updated">Data as of ${businessDate} · IPS v${ipsVersion}</div>
    </div>
  </header>`;
}

function statCard(label: string, value: string, sub: string, tone = ''): string {
  return `<div class="stat-card ${tone}"><div class="stat-label">${escapeHtml(label)}</div>
    <div class="stat-val">${value}</div><div class="stat-sub">${sub}</div></div>`;
}

function holdingsRows(positions: Position[]): string {
  if (positions.length === 0) return '<tr><td colspan="5" class="num" style="color:var(--text-muted)">No positions for this date</td></tr>';
  return positions
    .map(
      (p) =>
        `<tr><td>${escapeHtml(p.name)}</td><td>${escapeHtml(p.assetClass)}</td><td>${escapeHtml(p.account)}</td>` +
        `<td class="num">${compact(p.valuePaise)}</td><td class="num">${p.avgCostPaise === null ? '<span style="color:var(--text-muted)">unknown</span>' : compact(p.avgCostPaise)}</td></tr>`,
    )
    .join('');
}

const PLACEHOLDERS: readonly { title: string; task: string; note: string }[] = [
  { title: 'Maturity alerts', task: 'Task 1', note: 'Sammaan 26-Sep-2026 redemption + 14-day alert' },
  { title: 'Watchlist changes', task: 'Task 6', note: 'advisor proposals for your sign-off, open/closed rows' },
  { title: 'Signal review', task: 'Task 7', note: 'quality-gated composite scores, movers vs last week' },
  { title: 'Recommendation pipeline', task: 'Task 10', note: 'FR-11 objects: primary + 2 alternates, thesis, risk, IPS citations' },
  { title: 'Narrative', task: 'Task 11', note: 'OpenRouter prose over deterministic bullets' },
  { title: 'Scoring / calibration', task: 'Task 12', note: 'benchmark-at-creation + 3/6/12-mo evals' },
];

function stalenessBlock(staleness: StalenessRow[], blocked: string[]): string {
  const rows = staleness
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.source)}</td><td>${escapeHtml(s.asOf)}</td>` +
        `<td class="num">${s.ageHours === Infinity ? 'Never' : s.ageHours.toFixed(1)}h</td>` +
        `<td class="num">${s.limitHours}h</td>` +
        `<td><span class="badge ${s.state === 'fresh' ? 'badge-green' : s.state === 'stale' ? 'badge-red' : 'badge-dim'}">${s.state.toUpperCase()}</span></td></tr>`,
    )
    .join('');
  return `<div class="table-wrapper"><table><thead><tr><th>Source</th><th>As of</th><th class="num">Age</th><th class="num">Limit</th><th>State</th></tr></thead><tbody>${rows}</tbody></table></div>
  <p style="margin-top:1rem;font-size:.875rem">${
    blocked.length === 0
      ? '<span style="color:var(--green)">No positions blocked. FR-31 gate clear.</span>'
      : `<span class="blocked">FR-31: ${blocked.length} instrument${blocked.length === 1 ? '' : 's'} blocked from recommendations: ${blocked.map(escapeHtml).join(', ')}</span>`
  }</p>`;
}

async function weeklyPage(db: Db, now: string, d: DigestInput): Promise<string> {
  const positions = await loadPositions(db, d.businessDate);
  const blocked = blockedInstruments(d.staleness, positions);

  const bucketsHtml = d.buckets
    .map((b) => {
      const balance = b.balancePaise === null ? 'Not allocated' : full(b.balancePaise);
      const target = b.targetPaise === null ? 'Unspecified' : full(b.targetPaise);
      const funded = b.fundedRatio === null ? b.targetNote : `${pct(b.fundedRatio)} of ${target}`;
      return `<div class="card" style="padding:1rem">
        <div style="display:flex;justify-content:space-between;gap:.5rem;margin-bottom:.5rem">
          <h4 style="font-size:.9rem">${escapeHtml(b.name)}</h4>
          <span class="badge ${b.fundedRatio !== null && b.fundedRatio >= 1 ? 'badge-green' : 'badge-yellow'}">${b.fundedRatio !== null && b.fundedRatio >= 1 ? 'Target met' : 'Building'}</span>
        </div>
        <div style="font-size:.8rem;color:var(--text-dim)">${escapeHtml(balance)}</div>
        <div style="font-size:.75rem;color:var(--text-muted);margin-top:.5rem">${escapeHtml(funded)}</div>
      </div>`;
    })
    .join('');

  const breachesHtml =
    d.breaches.length > 0
      ? `<ul style="list-style:none">${d.breaches.map((b) => `<li style="margin:.5rem 0;padding:.75rem;background:rgba(239,68,68,.1);border:1px solid var(--red);border-radius:.5rem;color:var(--red)">⚠️ ${escapeHtml(b)}</li>`).join('')}</ul>`
      : '<p style="color:var(--green)">No concentration breaches.</p>';

  const nav =
    `<a href="/" class="active">Weekly report</a><a href="/digest" class="dim">Daily digest</a>`;

  return `${pageTop(nav, d.businessDate, d.ipsVersion, 'Sentinel — Weekly Report', 'Local preview · real Phase 0 data, Phase 1 sections pending')}
  <div class="stats-grid">
    ${statCard('Total Assets', compact(d.assetsPaise), `Across ${d.byAccount.length} accounts`)}
    ${statCard('Total Liabilities', compact(d.liabilitiesPaise), 'Loans & credit cards', 'liabilities')}
    ${statCard('Net Worth', compact(d.netPaise), `Day-over-day: ${d.previousNetPaise === null ? 'first snapshot' : compact((d.netPaise - d.previousNetPaise) as Paise)}`, 'networth')}
    ${statCard('FI Floor Funded', pct(d.funded.floorRatio), `Stretch ${pct(d.funded.stretchRatio)} — reporting only`, 'networth')}
  </div>

  <div class="section"><div class="section-header"><h2>Allocation vs IPS</h2></div>
    <div class="card"><div class="table-wrapper"><table>
      <thead><tr><th>Asset class</th><th class="num">Actual</th><th class="num">Band</th><th class="num">Drift</th><th>Status</th></tr></thead>
      <tbody>${d.drift
        .map(
          (r) =>
            `<tr><td>${escapeHtml(r.assetClass)}</td><td class="num">${pct(r.actual)}</td><td class="num">${pct(r.min)} – ${pct(r.max)}</td>` +
            `<td class="num ${r.driftPaise > 0n ? 'drift-over' : r.driftPaise < 0n ? 'drift-under' : ''}">${r.driftPaise === 0n ? '—' : `${compact(r.driftPaise)}`}</td>` +
            `<td>${r.breach === null ? '<span class="badge badge-green">OK</span>' : `<span class="badge badge-red">${escapeHtml(r.breach)}</span>`}</td></tr>`,
        )
        .join('')}</tbody>
    </table></div>
    <div style="margin-top:1rem">${breachesHtml}</div></div>
  </div>

  <div class="section"><div class="section-header"><h2>By account</h2></div>
    <div class="card"><div class="table-wrapper"><table>
      <thead><tr><th>Account</th><th class="num">Value</th></tr></thead>
      <tbody>${[...d.byAccount]
        .sort((a, b) => Number(b[1] - a[1]))
        .map(([account, value]) => {
          const label = account === 'fidelity' ? 'Fidelity (ServiceNow NOW)' : account;
          return `<tr><td>${escapeHtml(label)}</td><td class="num">${compact(value)}</td></tr>`;
        })
        .join('')}</tbody></table></div></div>
  </div>

  <div class="section"><div class="section-header"><h2>Holdings (${positions.length})</h2></div>
    <div class="card"><div class="table-wrapper"><table>
      <thead><tr><th>Instrument</th><th>Class</th><th>Account</th><th class="num">Value</th><th class="num">Avg cost</th></tr></thead>
      <tbody>${holdingsRows(positions)}</tbody></table></div></div>
  </div>

  <div class="section"><div class="section-header"><h2>Buckets</h2></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(250px,1fr));gap:1rem">${bucketsHtml}</div>
  </div>

  <div class="section"><div class="section-header"><h2>Data freshness (FR-31)</h2></div>
    <div class="card">${stalenessBlock(d.staleness, blocked)}</div>
  </div>

  <div class="section"><div class="section-header"><h2>Phase 1 — lights up as tasks land</h2></div>
    <div class="placeholder-grid">${PLACEHOLDERS.map(
      (p) => `<div class="placeholder"><h4>${escapeHtml(p.title)}</h4>
        <span class="badge badge-blue">${escapeHtml(p.task)}</span>
        <p>${escapeHtml(p.note)}</p></div>`,
    ).join('')}</div>
  </div>
${foot}`;
}

function digestPage(d: DigestInput, now: string): string {
  const nav = `<a href="/" class="dim">Weekly report</a><a href="/digest" class="active">Daily digest</a>`;
  const generatedAt = now.slice(0, 19).replace('T', ' ');
  return `${pageTop(nav, d.businessDate, d.ipsVersion, 'Sentinel — Daily Digest', 'The exact Telegram-composed text, rendered in the browser')}
  <div class="digest">${escapeHtml(composeDigest(d))}</div>
  <div class="footer">As composed for ${generatedAt} UTC — no re-formatting.</div>
</div>
</body>
</html>`;
}

export async function renderPage(db: Db, now: string, view: UiView): Promise<string> {
  const input = await buildDigestInput(db, now);
  if (view === 'digest') return digestPage(input, now);
  return weeklyPage(db, now, input);
}