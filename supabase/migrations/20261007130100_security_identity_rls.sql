-- Phase 3: identity helper, RLS, and direct-table grants. LOCAL ONLY. No Firebase bridge exists yet.
--
-- IDENTITY ASSUMPTION (Phase 5 must satisfy it): the request JWT carries
--     sub  = the Firebase uid (text, 28 chars, NOT a uuid)
--     role = 'authenticated'
-- Identity is read ONLY from auth.jwt()->>'sub'. auth.uid() is never used (it casts to uuid). A uid, display name or
-- email supplied by the client as a parameter is never trusted as the caller's identity.

create schema if not exists app_private;
revoke all on schema app_private from public;
grant usage on schema app_private to authenticated;          -- RLS policies run as the caller and call current_uid()

-- SECURITY INVOKER on purpose: it only reads the caller's own JWT claim and needs no elevated rights.
create function app_private.current_uid() returns text
language sql stable security invoker set search_path = ''
as $$ select nullif(auth.jwt() ->> 'sub', '') $$;
revoke all on function app_private.current_uid() from public;   -- Postgres grants EXECUTE to PUBLIC by default
grant execute on function app_private.current_uid() to authenticated;

-- Used inside the SECURITY DEFINER functions: refuses a request that carries no identity.
create function app_private.require_uid() returns text
language plpgsql stable security invoker set search_path = ''
as $$
declare u text := app_private.current_uid();
begin
  if u is null then raise exception 'not signed in' using errcode = '42501'; end if;
  return u;
end $$;
revoke all on function app_private.require_uid() from public;   -- Postgres grants EXECUTE to PUBLIC by default

-- Functions created in public later must not be callable by the Data API roles unless granted on purpose.
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- ---------------------------------------------------------------------------------------------------------------
-- Row level security: enabled on EVERY application table. Tables with no policy are deny-all for anon/authenticated
-- (service_role and the table owner bypass RLS, which the import and the SECURITY DEFINER functions rely on).
-- ---------------------------------------------------------------------------------------------------------------
alter table public.profiles            enable row level security;   -- deny-all: read only via get_profile_name
alter table public.invites             enable row level security;   -- deny-all: no listing, only get_invite(token)
alter table public.connections         enable row level security;
alter table public.pings               enable row level security;
alter table public.push_tokens         enable row level security;
alter table public.syncs               enable row level security;
alter table public.legacy_requests     enable row level security;   -- server only
alter table public.connection_aliases  enable row level security;   -- server only
alter table public.quarantined_records enable row level security;   -- server only
alter table public.shadow_mismatch     enable row level security;   -- migration only

-- Read policies (the only direct table access a client gets). `(select ...)` lets Postgres evaluate the claim once.
create policy connections_participant_select on public.connections for select to authenticated
  using (from_uid = (select app_private.current_uid()) or to_uid = (select app_private.current_uid()));

create policy pings_participant_select on public.pings for select to authenticated
  using (from_uid = (select app_private.current_uid()) or to_uid = (select app_private.current_uid()));

create policy push_tokens_owner_select on public.push_tokens for select to authenticated
  using (uid = (select app_private.current_uid()));

create policy syncs_owner_select on public.syncs for select to authenticated
  using (uid = (select app_private.current_uid()));

-- Grants: SELECT only, on four tables. No INSERT/UPDATE/DELETE/TRUNCATE for anon or authenticated anywhere.
-- (Phase 2 already revoked everything; this adds back the minimum.)
grant select on public.connections, public.pings, public.push_tokens, public.syncs to authenticated;
