import { db } from '../../lib/data.js';
import { ensureWebIngestion, listUploads } from '../../lib/ingest.js';
import { readKiteConnection } from '../../lib/kite-auth.js';
import { Badge, PageHead, Notice } from '../../lib/ui.js';
import UploadForm from './upload-form.js';
import ReviewPanel from './review-panel.js';

export const dynamic = 'force-dynamic';

export default async function ImportPage({
  searchParams,
}: {
  searchParams: Promise<{ kite?: string; reason?: string; rows?: string }>;
}) {
  const sp = await searchParams;
  const d = await db();
  await ensureWebIngestion(d);
  const [uploads, kite] = await Promise.all([listUploads(d, 20), readKiteConnection(d)]);
  const llmConfigured = Boolean(process.env.LLM_API_KEY);
  const kiteReady = Boolean(process.env.KITE_API_KEY && process.env.KITE_API_SECRET);

  const pending = uploads.filter((u) => u.status === 'proposed');
  const history = uploads.filter((u) => u.status !== 'proposed');

  return (
    <>
      <PageHead
        title="Import statements"
        badge={<Badge tone="indigo">owner-gated</Badge>}
        sub="Upload a brokerage or Fidelity RSU statement, or connect Kite to pull your holdings straight from Zerodha. The file is archived immediately, and when an LLM is configured its reading of your costs or vests appears here as proposals — nothing is written to your portfolio until you confirm each one."
      />

      {!llmConfigured ? (
        <Notice tone="amber">
          <strong>LLM not configured.</strong> Set <code>LLM_API_KEY</code> (and optionally{' '}
          <code>LLM_MODEL</code>) in the repo-root <code>.env</code> and restart the server. Uploads
          will still be archived and filed here, but marked unusable until then.
        </Notice>
      ) : null}

      {sp.kite === 'ok' ? (
        <Notice tone="green">
          <strong>Kite connected.</strong> Authenticated at Zerodha and pulled {sp.rows ?? ''} holdings
          into your database as the current <code>kite</code> snapshot. See them under{' '}
          <a href="/holdings">Holdings</a>.
        </Notice>
      ) : null}
      {sp.kite === 'error' ? (
        <Notice tone="red">
          <strong>Kite connect failed.</strong> {sp.reason ? decodeURIComponent(sp.reason) : 'Unknown error'}.
          Start again from the button below.
        </Notice>
      ) : null}

      <UploadForm llmConfigured={llmConfigured} />

      <div className="grid">
        <section className="card">
          <header className="card-head">
            <span className="card-title">Connect a provider</span>
            <span className="card-aside">statement import and live Kite sync both work today</span>
          </header>
          <div className="card-body">
            <div className="providers">
              <div className="provider">
                <span className="provider-name">Kite (Zerodha)</span>
                <span className="provider-actions">
                  {kite.connected
                    ? <Badge tone="green">connected</Badge>
                    : kiteReady
                      ? <Badge tone="gray">not connected</Badge>
                      : <Badge tone="gray">not configured</Badge>}
                  {kiteReady
                    ? <a className="btn btn-sm btn-primary" href="/api/kite/login">Connect Kite</a>
                    : null}
                  <a className="btn btn-sm" href="#statement">Import statement</a>
                </span>
              </div>
              <p className="dim" style={{ margin: '4px 0 0' }}>
                {kite.connected ? (
                  <>Connected to Zerodha — the token, encrypted at rest, is valid until{' '}
                    {new Date(kite.expiresAt!).toLocaleString('en-IN', { hour12: false })}.
                    Re-connect after it expires at 06:00 IST.</>
                ) : kiteReady ? (
                  <>KITE_API_KEY and KITE_API_SECRET are set. Connect opens Zerodha's own login page —
                    authenticating there is your human-in-the-loop unlock. Your holdings are then pulled
                    and written as the <code>kite</code> snapshot; no password is ever stored. Make sure
                    the redirect URI is registered in your Kite connect console.</>
                ) : (
                  <>Set <code>KITE_API_KEY</code>, <code>KITE_API_SECRET</code> and register the redirect
                    URI in the Kite connect console to enable the live login button. Until then, bring Kite
                    data in via statement upload.</>
                )}
              </p>
            </div>
          </div>
        </section>

        <section className="card">
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