-- Remove the permissive RLS policies (found 2026-10-16, owner-approved).
--
-- Eighteen tables were created with `create policy <t>_owner on <t> using (true) with check (true)`.
-- With no TO clause the policy applies to PUBLIC, and Supabase grants the `anon` and
-- `authenticated` roles table privileges by default, so anyone holding the project's anon key
-- could read and insert through the REST API — including `web_passkeys`, i.e. register a
-- passkey and log into the dashboard. The app connects as the table owner via DATABASE_URL and
-- bypasses RLS, so these policies granted nothing it needs. RLS stays enabled with no policy:
-- the posture the PRD asks for and the one the 35 Phase 0/1 tables already have.
--
-- Drops every public-schema policy that is unconditionally true for PUBLIC, so a table added
-- later with the same copy-pasted pattern is caught by re-running this, and it is idempotent.
do $$
declare p record;
begin
  for p in
    select schemaname, tablename, policyname from pg_policies
     where schemaname = 'public' and roles = '{public}' and qual = 'true'
       and (with_check is null or with_check = 'true')
  loop
    execute format('drop policy %I on %I.%I', p.policyname, p.schemaname, p.tablename);
  end loop;
end $$;
