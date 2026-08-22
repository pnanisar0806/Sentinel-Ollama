import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { openDb } from '../db/client.js';
import { runMigrations } from '../db/migrate.js';
import { loadEnv } from '../config/env.js';
import {
  authorizeUrl, discoverMetadata, exchangeCode, loadClientSecret, pkcePair, registerClient, saveTokens, saveClientSecret,
} from '../sources/oauth.js';

const ISSUER = 'https://mcp.indmoney.com';
const PORT = 8765;
const REDIRECT_URI = `http://127.0.0.1:${PORT}/callback`;
const SCOPES = ['portfolio:read'];

const env = loadEnv(process.env, ['crypto']);
const key = Buffer.from(env.tokenEncryptionKey, 'base64');
if (key.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes, base64-encoded');

const db = await openDb(env.databaseUrl);
await runMigrations(db);

const md = await discoverMetadata(ISSUER);

const existing = await db.query<{ client_id: string }>(
  'select client_id from oauth_clients where provider = $1', ['indmoney'],
);
let clientId = existing[0]?.client_id;
let clientSecret = existing[0] ? await loadClientSecret(db, 'indmoney', key) : undefined;

if (!clientId) {
  const registered = await registerClient(md, REDIRECT_URI);
  clientId = registered.clientId;
  clientSecret = registered.clientSecret;
  await db.query(
    `insert into oauth_clients (provider, issuer, client_id, client_secret_enc, redirect_uri)
     values ('indmoney', $1, $2, $3, $4)`,
    [md.issuer, clientId, clientSecret ? Buffer.from('placeholder') : null, REDIRECT_URI],
  );
  if (clientSecret) {
    await saveClientSecret(db, 'indmoney', clientSecret, key);
  }
  console.log(`Registered Sentinel as OAuth client ${clientId}`);
}

const { verifier, challenge } = pkcePair();
const state = randomBytes(16).toString('hex');
const url = authorizeUrl(md, { clientId, redirectUri: REDIRECT_URI, challenge, scopes: SCOPES, state });

let timeoutHandle: NodeJS.Timeout;
const code = await new Promise<string>((resolve, reject) => {
  const server = createServer((req, res) => {
    const incoming = new URL(req.url ?? '/', REDIRECT_URI);
    if (incoming.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }

    const params = incoming.searchParams;
    const returnedState = params.get('state');
    const returnedCode = params.get('code');
    const oauthError = params.get('error');

    const settle = (html: string, error?: Error) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(html);
      server.close();
      clearTimeout(timeoutHandle);
      if (error) reject(error);
    };
    const failed = '<h1>Login failed</h1><p>You can close this tab and try again.</p>';

    // Report what the provider actually said. Folding an error response into the state
    // check below reports "possible CSRF" for what is really a refusal or a bad request.
    if (oauthError) {
      settle(failed, new Error(
        `INDmoney refused the authorization: ${oauthError} — ` +
        `${params.get('error_description') ?? '(no description)'}`,
      ));
      return;
    }

    // Neither a code nor an error: a bare probe of the port (browser prefetch, a scanner,
    // a stray reload). Answer it and keep listening — one stray request must not burn the
    // whole five-minute window, which is how the first attempt died.
    if (!returnedCode) {
      console.log(`Ignoring a /callback request carrying no code and no error: ${incoming.search || '(no query string)'}`);
      res.writeHead(204).end();
      return;
    }

    if (returnedState !== state) {
      settle(failed, new Error(
        returnedState === null
          ? 'the callback carried a code but no state parameter'
          : 'state mismatch (possible CSRF) — this callback did not come from this login attempt',
      ));
      return;
    }

    settle('<h1>Sentinel is connected to INDmoney.</h1><p>You can close this tab.</p>');
    resolve(returnedCode);
  });

  server.on('error', (err) => {
    clearTimeout(timeoutHandle);
    reject(new Error(`could not listen on 127.0.0.1:${PORT} — ${err.message}`));
  });

  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\nOpening INDmoney login. Complete OTP + MPIN on INDmoney's own page.\n${url}\n`);
    // NOT `cmd /c start`: cmd.exe treats the URL's `&` query separators as command
    // separators and opens only the fragment before the first one. rundll32 receives the
    // URL as a single argv element, so no shell ever parses it.
    spawn('rundll32', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' }).unref();
  });

  timeoutHandle = setTimeout(() => {
    server.close();
    reject(new Error('login timed out after 5 minutes'));
  }, 300_000);
});

const tokens = await exchangeCode(md, {
  code, clientId, redirectUri: REDIRECT_URI, verifier,
  ...(clientSecret ? { clientSecret } : {}),
});
await saveTokens(db, 'indmoney', tokens, key);
await db.query(
  `insert into audit_log (entity, entity_id, action, actor, payload)
   values ('oauth', 'indmoney', 'AUTHORIZED', 'owner', $1::jsonb)`,
  [JSON.stringify({ scope: tokens.scope, expiresAt: tokens.expiresAt })],
);

console.log(`Connected. Scope: ${tokens.scope}. Refresh token stored encrypted.`);
await db.close();