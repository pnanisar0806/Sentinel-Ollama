import type { DigestInput } from './digest.js';
import { formatInr, paise } from '../money/paise.js';
import { escapeMarkdown } from './telegram.js';

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;

function formatInrCompact(paiseValue: bigint): string {
  return formatInr(paise(paiseValue), { compact: true });
}

function formatInrFull(paiseValue: bigint): string {
  return formatInr(paise(paiseValue), { compact: false });
}

function breachFlag(breach: string | null): string {
  if (!breach) return '';
  return `<span class="breach-badge">${escapeMarkdown(breach)}</span>`;
}

function driftClass(driftPaise: bigint): string {
  return driftPaise > 0n ? 'drift-over' : 'drift-under';
}

function generateDashboardHtml(d: DigestInput): string {
  const dashboardUrl = 'https://pnanisar0806.github.io/Sentinel-Ollama/dashboard.html';
  const generatedAt = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const netWorthChange = d.previousNetPaise !== null
    ? d.netPaise - d.previousNetPaise
    : null;

  const assetClassLabels = ['EQUITY', 'DEBT', 'GOLD', 'CASH'];
  const assetClassData = assetClassLabels.map(label => {
    const value = d.drift.find(r => r.assetClass === label);
    return value ? Number(value.actual * 100).toFixed(1) : '0.0';
  });

  const sectorEntries = [...d.drift.flatMap(() => [])];
  const topSectors = ['Financial Services', 'Technology', 'Healthcare', 'Consumer', 'Energy', 'Industrials', 'Materials', 'Utilities', 'Real Estate', 'Communication'];
  const sectorData = topSectors.map(() => Math.random() * 15);

  const holdingsRows = `
    <tr><td colspan="9" class="no-data">Holdings data loaded from digest</td></tr>
  `;

  const loansRows = `
    <tr><td colspan="5" class="no-data">Liabilities data loaded from digest</td></tr>
  `;

  const bucketsHtml = d.buckets.map(b => {
    const balance = b.balancePaise === null ? 'Not allocated' : formatInrFull(b.balancePaise);
    const target = b.targetPaise === null ? 'Unspecified' : formatInrFull(b.targetPaise);
    const funded = b.fundedRatio === null ? b.targetNote : `${pct(b.fundedRatio)} of ${target}`;
    const progressPct = b.targetPaise && b.targetPaise > 0n && b.balancePaise
      ? Math.min(100, (Number(b.balancePaise) / Number(b.targetPaise)) * 100).toFixed(1)
      : 0;
    return `
      <div class="bucket-card">
        <div class="bucket-header">
          <h4>${escapeMarkdown(b.name)}</h4>
          <span class="bucket-status ${b.fundedRatio !== null && b.fundedRatio >= 1 ? 'met' : ''}">
            ${b.fundedRatio !== null && b.fundedRatio >= 1 ? 'Target Met' : 'Building'}
          </span>
        </div>
        <div class="bucket-progress">
          <div class="progress-bar"><div class="progress-fill" style="width: ${progressPct}%"></div></div>
          <div class="progress-labels">
            <span>${balance}</span>
            <span>${funded}</span>
          </div>
        </div>
        <p class="bucket-mandate">${escapeMarkdown(b.targetNote)}</p>
      </div>
    `;
  }).join('');

  const milestonesHtml = d.milestones.filter(m => !m.completedOn).map(m => `
    <div class="milestone-card open">
      <h4>${escapeMarkdown(m.name)}</h4>
      <p>${escapeMarkdown(m.spec)}</p>
      <span class="days-outstanding">${m.daysOutstanding !== null ? `${m.daysOutstanding} days outstanding` : 'No start date recorded'}</span>
    </div>
  `).join('') || '<p class="no-data">All milestones completed</p>';

  const nextVestHtml = d.nextVest ? `
    <div class="vest-card">
      <h4>Next RSU Vest</h4>
      <p class="vest-date">${d.nextVest.vestOn}</p>
      <p class="vest-amount">${formatInrCompact(d.nextVest.netPaise)} net (projected)</p>
    </div>
  ` : '<p class="no-data">No upcoming vests in projection window</p>';

  const stalenessHtml = d.staleness.map(s => `
    <div class="staleness-row ${s.state}">
      <span class="source">${escapeMarkdown(s.source)}</span>
      <span class="age">${s.ageHours === Infinity ? 'Never' : s.ageHours.toFixed(1)}h</span>
      <span class="limit">${s.limitHours}h</span>
      <span class="state-badge ${s.state}">${s.state.toUpperCase()}</span>
    </div>
  `).join('');

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Sentinel — Wealth Dashboard</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    :root {
      --bg: #07080c;
      --bg-elevated: #0d0f17;
      --card: rgba(18, 22, 33, 0.85);
      --card-hover: rgba(26, 32, 48, 0.95);
      --border: rgba(255, 255, 255, 0.06);
      --border-glow: rgba(99, 102, 241, 0.15);
      --text: #f8fafc;
      --text-dim: #94a3b8;
      --text-muted: #64748b;
      --green: #10b981;
      --green-bg: rgba(16, 185, 129, 0.1);
      --red: #ef4444;
      --red-bg: rgba(239, 68, 68, 0.1);
      --blue: #3b82f6;
      --purple: #8b5cf6;
      --yellow: #f59e0b;
      --indigo: #6366f1;
      --font: 'Plus Jakarta Sans', 'Outfit', -apple-system, sans-serif;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--font);
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 2rem;
      line-height: 1.6;
      background-image:
        radial-gradient(circle at 5% 5%, rgba(99, 102, 241, 0.12) 0%, transparent 40%),
        radial-gradient(circle at 95% 95%, rgba(236, 72, 153, 0.1) 0%, transparent 40%),
        radial-gradient(circle at 50% 50%, rgba(16, 185, 129, 0.05) 0%, transparent 50%);
      background-attachment: fixed;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      display: flex; flex-direction: column; align-items: flex-start; gap: 1rem;
      margin-bottom: 2rem; border-bottom: 1px solid var(--border);
      padding-bottom: 1.5rem;
    }
    .brand h1 { font-size: 1.75rem; font-weight: 800; background: linear-gradient(135deg, #fff 30%, #c7d2fe 70%, #f472b6 100%); -webkit-background-clip: text; -webkit-text-fill-color: transparent; letter-spacing: -0.03em; }
    .brand p { color: var(--text-dim); font-size: 0.875rem; margin-top: 0.25rem; }
    .header-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem; width: 100%; }
    .last-updated { background: rgba(255,255,255,0.04); padding: 0.5rem 1rem; border-radius: 9999px; font-size: 0.75rem; color: var(--text-dim); border: 1px solid var(--border); display: flex; align-items: center; gap: 0.5rem; flex-shrink: 0; }
    .last-updated::before { content: ''; width: 6px; height: 6px; background: var(--green); border-radius: 50%; box-shadow: 0 0 6px var(--green); }
    .dashboard-link { display: inline-flex; align-items: center; gap: 0.5rem; background: var(--indigo); color: white; padding: 0.5rem 1rem; border-radius: 0.5rem; font-weight: 600; text-decoration: none; font-size: 0.875rem; flex-shrink: 0; }
    .dashboard-link:hover { opacity: 0.9; }

    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
    .stat-card { background: var(--card); backdrop-filter: blur(16px); border: 1px solid var(--border); border-radius: 1rem; padding: 1.25rem; position: relative; overflow: hidden; transition: all 0.3s; box-shadow: 0 4px 30px rgba(0,0,0,0.2); }
    .stat-card::before { content: ''; position: absolute; top: 0; left: 0; width: 4px; height: 100%; background: var(--indigo); }
    .stat-card.positive::before { background: var(--green); }
    .stat-card.negative::before { background: var(--red); }
    .stat-card.liabilities::before { background: var(--yellow); }
    .stat-card.networth::before { background: linear-gradient(to bottom, var(--indigo), var(--purple)); }
    .stat-card:hover { transform: translateY(-4px); border-color: var(--border-glow); box-shadow: 0 12px 24px -10px rgba(99,102,241,0.2); }
    .stat-label { font-size: 0.7rem; font-weight: 700; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.075em; }
    .stat-val { font-size: 1.5rem; font-weight: 800; margin-top: 0.5rem; letter-spacing: -0.02em; }
    .stat-sub { font-size: 0.75rem; margin-top: 0.5rem; display: flex; align-items: center; gap: 0.35rem; color: var(--text-muted); }
    .trend-up { color: var(--green); font-weight: 600; }
    .trend-down { color: var(--red); font-weight: 600; }

    .section { margin-bottom: 2rem; }
    .section-header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; margin-bottom: 1.25rem; gap: 0.75rem; }
    .section-header h2 { font-size: 1.125rem; font-weight: 700; }
    .card { background: var(--card); backdrop-filter: blur(16px); border: 1px solid var(--border); border-radius: 1rem; padding: 1.5rem; box-shadow: 0 4px 30px rgba(0,0,0,0.2); }
    .charts-grid { display: grid; grid-template-columns: 1.1fr 1fr; gap: 1.5rem; }
    @media (max-width: 1024px) { .charts-grid { grid-template-columns: 1fr; } }
    .chart-container { position: relative; width: 100%; height: 300px; }

    .table-wrapper { overflow-x: auto; border-radius: 0.75rem; border: 1px solid var(--border); background: rgba(0,0,0,0.15); }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 0.8rem; }
    th { background: rgba(255,255,255,0.02); color: var(--text-dim); font-weight: 700; padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); text-transform: uppercase; font-size: 0.65rem; letter-spacing: 0.075em; }
    td { padding: 0.75rem 1rem; border-bottom: 1px solid var(--border); color: var(--text); vertical-align: middle; }
    tr:hover td { background: rgba(255,255,255,0.015); }
    .no-data { text-align: center; color: var(--text-muted); padding: 2rem !important; }
    .num { font-family: 'Outfit', monospace; font-size: 0.825rem; font-weight: 600; }
    .highlight-red { color: #fca5a5; }
    .badge { padding: 0.25rem 0.5rem; border-radius: 0.375rem; font-size: 0.725rem; font-weight: 600; display: inline-block; }
    .badge-green { background: var(--green-bg); color: var(--green); }
    .badge-red { background: var(--red-bg); color: var(--red); }
    .badge-yellow { background: rgba(245,158,11,0.1); color: var(--yellow); }
    .badge-blue { background: rgba(99,102,241,0.1); color: var(--blue); }
    .breach-badge { background: var(--red-bg); color: var(--red); padding: 0.2rem 0.5rem; border-radius: 0.25rem; font-size: 0.7rem; font-weight: 700; margin-left: 0.5rem; }
    .drift-over { color: var(--red); }
    .drift-under { color: var(--yellow); }

    .allocation-table { width: 100%; }
    .allocation-table td { padding: 0.6rem 0.75rem; }

    .bucket-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; }
    .bucket-card { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 0.75rem; padding: 1.25rem; }
    .bucket-header { display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; gap: 0.5rem; }
    .bucket-header h4 { font-size: 0.9rem; font-weight: 700; }
    .bucket-status { font-size: 0.65rem; font-weight: 700; padding: 0.2rem 0.5rem; border-radius: 999px; background: var(--yellow); color: var(--bg); white-space: nowrap; }
    .bucket-status.met { background: var(--green); color: var(--bg); }
    .bucket-progress { margin-bottom: 0.75rem; }
    .progress-bar { height: 6px; background: rgba(255,255,255,0.05); border-radius: 3px; overflow: hidden; }
    .progress-fill { height: 100%; background: linear-gradient(90deg, var(--indigo), var(--purple)); border-radius: 3px; transition: width 0.5s; }
    .progress-labels { display: flex; justify-content: space-between; font-size: 0.7rem; color: var(--text-dim); margin-top: 0.5rem; }
    .bucket-mandate { font-size: 0.75rem; color: var(--text-muted); }

    .milestone-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; }
    .milestone-card { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 0.75rem; padding: 1.25rem; }
    .milestone-card.open { border-left: 4px solid var(--red); }
    .milestone-card h4 { font-size: 0.9rem; font-weight: 700; margin-bottom: 0.5rem; }
    .milestone-card p { color: var(--text-dim); font-size: 0.8rem; margin-bottom: 0.5rem; }
    .days-outstanding { font-size: 0.7rem; color: var(--red); font-weight: 600; }

    .vest-card { background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 0.75rem; padding: 1.25rem; max-width: 100%; }
    .vest-card h4 { font-size: 0.9rem; font-weight: 700; margin-bottom: 0.5rem; }
    .vest-date { color: var(--text-dim); font-size: 0.8rem; margin-bottom: 0.25rem; }
    .vest-amount { font-size: 1.25rem; font-weight: 800; color: var(--green); }

    .staleness-table { width: 100%; }
    .staleness-row { display: grid; grid-template-columns: 2fr 1fr 1fr 1fr; gap: 0.75rem; padding: 0.75rem; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: 0.5rem; margin-bottom: 0.5rem; align-items: center; }
    .staleness-row.unimplemented { opacity: 0.5; }
    .state-badge { padding: 0.2rem 0.5rem; border-radius: 999px; font-size: 0.65rem; font-weight: 700; text-transform: uppercase; white-space: nowrap; }
    .state-badge.fresh { background: var(--green-bg); color: var(--green); }
    .state-badge.stale { background: var(--red-bg); color: var(--red); }
    .state-badge.unimplemented { background: rgba(255,255,255,0.1); color: var(--text-muted); }

    .footer { text-align: center; padding: 1.5rem; color: var(--text-muted); font-size: 0.75rem; border-top: 1px solid var(--border); margin-top: 2rem; }
    .footer a { color: var(--blue); text-decoration: none; }
    .footer a:hover { text-decoration: underline; }

    @media (max-width: 640px) {
      body { padding: 1rem; }
      header { gap: 0.75rem; }
      .brand h1 { font-size: 1.5rem; }
      .header-meta { flex-direction: column; align-items: stretch; }
      .dashboard-link { justify-content: center; }
      .last-updated { justify-content: center; }
      .stats-grid { grid-template-columns: 1fr 1fr; }
      .stat-val { font-size: 1.25rem; }
      .charts-grid { grid-template-columns: 1fr; }
      .chart-container { height: 250px; }
      .bucket-grid, .milestone-grid { grid-template-columns: 1fr; }
      .staleness-row { grid-template-columns: 1fr; gap: 0.5rem; text-align: center; }
      .state-badge { justify-self: center; }
      .section-header { flex-direction: column; align-items: flex-start; }
      table { font-size: 0.7rem; }
      th, td { padding: 0.5rem 0.5rem; }
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <h1>Sentinel Wealth Dashboard</h1>
        <p>Consolidated portfolio intelligence — ${d.businessDate} (IPS v${d.ipsVersion})</p>
      </div>
      <div class="header-meta">
        <a href="${dashboardUrl}" class="dashboard-link" target="_blank">🔗 Open Live Dashboard</a>
        <div class="last-updated">Generated ${generatedAt} UTC</div>
      </div>
    </header>

    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Assets</div>
        <div class="stat-val">${formatInrCompact(d.assetsPaise)}</div>
        <div class="stat-sub">Across ${d.byAccount.length} accounts</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Total Liabilities</div>
        <div class="stat-val highlight-red">${formatInrCompact(d.liabilitiesPaise)}</div>
        <div class="stat-sub">Loans & credit cards</div>
      </div>
      <div class="stat-card ${netWorthChange !== null && netWorthChange >= 0n ? 'positive' : netWorthChange !== null ? 'negative' : ''}">
        <div class="stat-label">Net Worth</div>
        <div class="stat-val ${netWorthChange !== null && netWorthChange >= 0n ? 'trend-up' : netWorthChange !== null ? 'trend-down' : ''}">
          ${formatInrCompact(d.netPaise)}
        </div>
        <div class="stat-sub">
          ${netWorthChange !== null
            ? `<span class="${netWorthChange >= 0n ? 'trend-up' : 'trend-down'}">${netWorthChange >= 0n ? '+' : ''}${formatInrCompact(netWorthChange)}</span> since last sync`
            : '<span>First snapshot — day-over-day starts next run</span>'}
        </div>
      </div>
      <div class="stat-card networth">
        <div class="stat-label">Funded Status (FI Floor)</div>
        <div class="stat-val">${pct(d.funded.floorRatio)}</div>
        <div class="stat-sub" style="color: #c7d2fe;">Stretch: ${pct(d.funded.stretchRatio)} — reporting only, never a risk input</div>
      </div>
    </div>

    <div class="section">
      <div class="section-header"><h2>By Account</h2></div>
      <div class="card">
        <div class="table-wrapper">
          <table>
            <thead><tr><th>Account</th><th class="num">Value</th></tr></thead>
            <tbody>
              ${[...d.byAccount].sort((a, b) => Number(b[1] - a[1])).map(([account, value]) => {
                const label = account === 'fidelity' ? 'Fidelity (ServiceNow NOW)' : account;
                return `<tr><td>${escapeMarkdown(label)}</td><td class="num">${formatInrCompact(value)}</td></tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="section">
      <div class="section-header"><h2>Allocation vs IPS §3.3</h2></div>
      <div class="charts-grid">
        <div class="card">
          <h3>Asset Allocation</h3>
          <div class="chart-container"><canvas id="assetChart"></canvas></div>
        </div>
        <div class="card">
          <h3>Allocation Detail</h3>
          <div class="table-wrapper">
            <table class="allocation-table">
              <thead><tr><th>Asset Class</th><th class="num">Actual</th><th class="num">Band</th><th class="num">Drift</th><th>Status</th></tr></thead>
              <tbody>
                ${d.drift.map(row => `
                  <tr>
                    <td>${row.assetClass}</td>
                    <td class="num">${pct(row.actual)}</td>
                    <td class="num">${pct(row.min)} – ${pct(row.max)}</td>
                    <td class="num ${driftClass(row.driftPaise)}">${row.driftPaise !== 0n ? (row.driftPaise > 0n ? '+' : '') + formatInrCompact(row.driftPaise) : '—'}</td>
                    <td>${breachFlag(row.breach)}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    ${d.railBreaches.length > 0 ? `
    <div class="section">
      <div class="section-header"><h2>Your Rails (Not IPS)</h2></div>
      <div class="card">
        <ul style="list-style: none;">
          ${d.railBreaches.map(b => `<li style="margin: 0.5rem 0; padding: 0.75rem; background: var(--red-bg); border: 1px solid var(--red); border-radius: 0.5rem; color: var(--red);">⚠️ ${escapeMarkdown(b.message)}</li>`).join('')}
        </ul>
      </div>
    </div>
    ` : ''}

    ${d.breaches.length > 0 ? `
    <div class="section">
      <div class="section-header"><h2>Concentration Breaches (IPS §3.5)</h2></div>
      <div class="card">
        <ul style="list-style: none;">
          ${d.breaches.map(b => `<li style="margin: 0.5rem 0; padding: 0.75rem; background: var(--red-bg); border: 1px solid var(--red); border-radius: 0.5rem; color: var(--red);">⚠️ ${escapeMarkdown(b)}</li>`).join('')}
        </ul>
      </div>
    </div>
    ` : ''}

    <div class="section">
      <div class="section-header"><h2>Buckets</h2></div>
      <div class="bucket-grid">${bucketsHtml}</div>
    </div>

    <div class="section">
      <div class="section-header"><h2>Protection Milestones</h2></div>
      <div class="milestone-grid">${milestonesHtml}</div>
    </div>

    <div class="section">
      <div class="section-header"><h2>RSU Pipeline</h2></div>
      <div style="display: flex; gap: 1.5rem; flex-wrap: wrap;">${nextVestHtml}</div>
    </div>

    <div class="section">
      <div class="section-header"><h2>Data Freshness</h2></div>
      <div class="card">
        <div style="display: flex; flex-direction: column; gap: 0.75rem;">
          ${stalenessHtml}
        </div>
        ${d.staleness.some(s => s.stale) ? '<p style="margin-top: 1rem; color: var(--red); font-size: 0.875rem;">⚠️ Stale sources block recommendations for affected instruments (FR-31).</p>' : '<p style="margin-top: 1rem; color: var(--green);">✅ All sources fresh.</p>'}
      </div>
    </div>

    <div class="footer">
      Generated by Sentinel • <a href="${dashboardUrl}" target="_blank">Live Dashboard</a> •
      Data as of ${d.businessDate} • IPS v${d.ipsVersion}
    </div>
  </div>

  <script>
    const pct = (n) => (n * 100).toFixed(1) + '%';
    const assetCtx = document.getElementById('assetChart').getContext('2d');
    new Chart(assetCtx, {
      type: 'doughnut',
      data: {
        labels: ['Equity', 'Debt', 'Gold', 'Cash'],
        datasets: [{
          data: [${assetClassData.join(',')}],
          backgroundColor: ['#6366f1', '#8b5cf6', '#f59e0b', '#10b981'],
          borderWidth: 1,
          borderColor: '#1e293b'
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { position: 'right', labels: { color: '#94a3b8', font: { family: 'Plus Jakarta Sans', size: 12, weight: '600' } } },
          tooltip: {
            callbacks: {
              label: function(ctx) {
                const val = ctx.raw; const total = ctx.dataset.data.reduce((a,b)=>a+b,0);
                return ctx.label + ': ' + pct(val/100) + ' (' + (val).toFixed(1) + '%)';
              }
            }
          }
        }
      }
    });
  </script>
</body>
</html>`;

  return html;
}

export { generateDashboardHtml };