'use client';

import { useState } from 'react';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';

/**
 * Sign-in with a passkey, and first-time registration of one.
 *
 * Registration asks for the setup token because it is the dangerous step: whoever
 * registers first owns the app. The token lives only in the deployment's environment.
 */
export default function LoginPage() {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [registering, setRegistering] = useState(false);
  const [setupToken, setSetupToken] = useState('');
  const [label, setLabel] = useState('');

  const next = (): string => {
    const target = new URLSearchParams(window.location.search).get('next') ?? '/';
    // Only ever a same-site path; an absolute URL here would be an open redirect.
    return target.startsWith('/') && !target.startsWith('//') ? target : '/';
  };

  async function post(url: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({})) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(json['error'] ?? `failed (${res.status})`));
    return json;
  }

  async function signIn() {
    setBusy(true);
    setMessage(null);
    try {
      const options = await post('/api/auth/login/options', {});
      const response = await startAuthentication({ optionsJSON: options as never });
      await post('/api/auth/login/verify', { response });
      window.location.assign(next());
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function register() {
    setBusy(true);
    setMessage(null);
    try {
      const options = await post('/api/auth/register/options', { setupToken });
      const response = await startRegistration({ optionsJSON: options as never });
      await post('/api/auth/register/verify', { response, label });
      window.location.assign(next());
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card" style={{ maxWidth: 440 }}>
      <header className="card-head">
        <span className="card-title">Sign in</span>
      </header>
      <div className="card-body">
        <p className="muted">Sentinel is private to its owner. Use your passkey to continue.</p>

        <button className="btn btn-primary" onClick={signIn} disabled={busy}>
          {busy && !registering ? 'Waiting for your passkey…' : 'Sign in with passkey'}
        </button>

        {!registering ? (
          <p className="dim">
            New device?{' '}
            <button className="btn btn-sm" onClick={() => setRegistering(true)} disabled={busy}>
              Register a passkey
            </button>
          </p>
        ) : (
          <div className="stack" style={{ gap: 10 }}>
            <label className="dim">
              Setup token
              <input
                type="password"
                autoComplete="off"
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                style={{ display: 'block', width: '100%', marginTop: 4 }}
              />
            </label>
            <label className="dim">
              Name this device (optional)
              <input
                type="text"
                placeholder="laptop, phone…"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                style={{ display: 'block', width: '100%', marginTop: 4 }}
              />
            </label>
            <button className="btn btn-primary" onClick={register} disabled={busy || setupToken === ''}>
              {busy ? 'Waiting for your device…' : 'Register this device'}
            </button>
          </div>
        )}

        {message !== null ? <p className="tone-red" role="alert">{message}</p> : null}
      </div>
    </section>
  );
}
