import { db } from '../../lib/data.js';
import { ensureWebIngestion, listUploads } from '../../lib/ingest.js';
import { Badge, PageHead, Notice } from '../../lib/ui.js';
import UploadForm from './upload-form.js';
import ReviewPanel from './review-panel.js';

export const dynamic = 'force-dynamic';

export default async function ImportPage() {
  const d = await db();
  await ensureWebIngestion(d);
  const uploads = await listUploads(d, 20);
  const llmConfigured = Boolean(process.env.LLM_API_KEY);

  const pending = uploads.filter((u) => u.status === 'proposed');
  const history = uploads.filter((u) => u.status !== 'proposed');

  return (
    <>
      <PageHead
        title="Import statements"
        badge={<Badge tone="indigo">owner-gated</Badge>}
        sub="Upload a brokerage or Fidelity RSU statement. The file is archived immediately, and when an LLM is configured its reading of your costs or vests appears here as proposals — nothing is written to your portfolio until you confirm each one."
      />

      {!llmConfigured ? (
        <Notice tone="amber">
          <strong>LLM not configured.</strong> Set <code>LLM_API_KEY</code> (and optionally{' '}
          <code>LLM_MODEL</code>) in the repo-root <code>.env</code> and restart the server. Uploads
          will still be archived and filed here, but marked unusable until then.
        </Notice>
      ) : null}

      <UploadForm llmConfigured={llmConfigured} />

      <div className="grid">
        <section className="card span-2">
          <header className="card-head">
            <span className="card-title">LLM extraction</span>
            <span className="card-aside">reads uploaded statements into proposals</span>
          </header>
          <div className="card-body">
            <div className="providers">
              <div className="provider">
                <span className="provider-name">OpenRouter vision</span>
                {llmConfigured
                  ? <Badge tone="green">configured</Badge>
                  : <Badge tone="amber">off</Badge>}
              </div>
              <p className="dim" style={{ margin: '4px 0 0' }}>
                {llmConfigured
                  ? 'LLM_API_KEY is set — statements are read into proposals you review before anything writes.'
                  : 'Set LLM_API_KEY in the repo .env to enable reading. Without it, uploads are filed but marked unusable.'}
              </p>
            </div>
          </div>
        </section>
      </div>

      <div className="stack">
        <section>
          <h2 className="page-sub">Pending your decision</h2>
          {pending.length === 0
            ? <p className="muted" style={{ marginTop: 8 }}>Nothing waiting — good.</p>
            : <div className="grid">{pending.map((u) => <ReviewPanel key={u.id} upload={u} />)}</div>}
        </section>

        <section>
          <h2 className="page-sub">History</h2>
          {history.length === 0
            ? <p className="muted" style={{ marginTop: 8 }}>No imports yet.</p>
            : <div className="grid">{history.map((u) => <ReviewPanel key={u.id} upload={u} />)}</div>}
        </section>
      </div>
    </>
  );
}