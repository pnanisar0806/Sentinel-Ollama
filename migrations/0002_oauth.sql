-- OAuth tables for INDmoney dynamic client registration + PKCE
-- client_secret is encrypted at rest with AES-256-GCM under TOKEN_ENCRYPTION_KEY
-- (same scheme as oauth_tokens.refresh_token_enc) — never plaintext in DB.

create table oauth_clients (
  provider          text primary key,
  issuer            text not null,
  client_id         text not null,
  client_secret_enc bytea,                 -- encrypted with AES-256-GCM; null if token_endpoint_auth_method='none'
  redirect_uri      text not null,
  registered_at     timestamptz not null default now()
);

create table oauth_tokens (
  provider           text primary key,
  access_token_enc   bytea not null,
  refresh_token_enc  bytea,                 -- encrypted with AES-256-GCM
  expires_at         timestamptz not null,
  scope              text not null,
  updated_at         timestamptz not null default now()
);