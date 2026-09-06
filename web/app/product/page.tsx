import { AREAS, STAGE_LABEL } from '../../lib/product';
import { Badge, Card, DataTable, Notice, PageHead } from '../../lib/ui';

const stageTone = (stage: string) =>
  stage === 'live' ? 'green' : stage === 'p1' ? 'indigo' : 'gray';

export default function ProductPage() {
  const rows = AREAS.map((a) => ({
    key: a.slug,
    name: a.name,
    stage: a.stage,
    task: a.task,
    what: a.what,
    works: a.works,
    missing: a.missing,
  }));

  return (
    <>
      <PageHead
        title="Product map"
        sub="Every area of the product, its state, and what is actually there. This is the honest ledger behind all the other pages."
      />
      <div className="legend">
        <span><Badge tone="green">live</Badge> built and real, reading today's data</span>
        <span><Badge tone="indigo">Phase 1</Badge> planned — shell page, builds with the task noted</span>
        <span><Badge tone="gray">Phase 2</Badge> deliberately deferred — never trade-path enabled</span>
      </div>
      <Notice tone="amber">
        No trading paths exist by design — no F&amp;O, no intraday, no leverage, no loan-against-securities. Orders,
        when they eventually exist in Phase 2, require a fresh human approval every time. Null override flag; these are
        absent code paths, not disabled features.
      </Notice>
      <div className="card" style={{ padding: '0.3rem 0' }}>
        <DataTable
          rows={rows}
          cols={[
            { label: 'Area', value: (r) => <strong>{r.name}</strong> },
            { label: 'State', value: (r) => (<><Badge tone={stageTone(r.stage)}>{STAGE_LABEL[r.stage]}</Badge>{r.task ? <> · <Badge tone="indigo">{r.task}</Badge></> : null}</>) },
            { label: 'What it is', value: (r) => <span className="dim">{r.what}</span> },
            { label: 'Works today', value: (r) => <span className="dim">{r.works.join('; ')}</span> },
            { label: 'Missing', value: (r) => <span className="dim">{r.missing.join('; ')}</span> },
          ]}
        />
      </div>
      <Card title="Reading this map">
        <p style={{ margin: '0.3rem 0' }}>
          Every <Badge tone="green">live</Badge> page in this app renders directly from the database through the same
          pure domain functions the Telegram jobs use — not copies of the logic. Every{' '}
          <Badge tone="indigo">Phase 1</Badge> page is a real route with the honest 'not built yet — Task N' state and
          the buttons it will carry, disabled with the reason as a tooltip. Watch the map as the plan lands: rows flip
          from Phase 1 to live when their task closes.
        </p>
      </Card>
    </>
  );
}