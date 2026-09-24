-- The owner's passkeys for the web app.
--
-- The deployed web app had no authentication at all: no middleware and no session
-- check. `POST /api/approvals/*/approve`, `/api/exits/promote` and `/api/import` were
-- reachable by anyone holding the URL. The Phase 2 plan required single-owner auth
-- "before remote deployment" (PRD §12.3), and the app was already deployed.
--
-- Single user by construction (PRD: no multi-tenancy, no accounts). Every row here is the
-- owner's; there is no user column because there is no second user to tell apart.
--
-- NOT append-only, unlike most tables here: WebAuthn's signature counter must be
-- updated on every login to detect a cloned authenticator. The login events themselves
-- go to `audit_log`, which is.
create table web_passkeys (
  -- The credential id, base64url, exactly as the authenticator reports it.
  id            text primary key,
  -- COSE public key, base64url.
  public_key    text not null,
  counter       bigint not null default 0 check (counter >= 0),
  transports    jsonb not null default '[]'::jsonb,
  -- Free text so the owner can tell "laptop" from "phone" when revoking one.
  label         text not null default '',
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz
);

alter table web_passkeys enable row level security;
create policy web_passkeys_owner on web_passkeys
  using (true) with check (true);
