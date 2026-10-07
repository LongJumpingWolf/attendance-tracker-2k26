-- Phase 3: profile and invite RPCs.
-- Why SECURITY DEFINER: profiles and invites have no client SELECT/INSERT/UPDATE/DELETE grant at all (so no directory and
-- no listing is possible); these narrow functions are the only way in. Each pins search_path to '' and schema-qualifies
-- everything. EXECUTE is granted to `authenticated` only (never PUBLIC or anon). The caller is the JWT `sub`.

-- upsert_profile: users/{uid} create/update, own profile only, name 1..40 (parity with the rule).
create function public.upsert_profile(p_name text) returns void
language plpgsql security definer set search_path = ''
as $$
declare me text := app_private.require_uid();
begin
  if p_name is null or char_length(p_name) not between 1 and 40 then
    raise exception 'invalid name' using errcode = '22023';
  end if;
  insert into public.profiles (uid, name, updated_at) values (me, p_name, now())
  on conflict (uid) do update set name = excluded.name, updated_at = now();
end $$;

-- get_profile_name: returns ONE name for ONE uid. Exact match only, no pattern, no listing, returns only the name.
-- (Firestore let any signed-in user read any profile; a QR/link carries the uid, which is the capability.)
create function public.get_profile_name(p_uid text) returns text
language plpgsql stable security definer set search_path = ''
as $$
declare r text;
begin
  perform app_private.require_uid();
  if p_uid is null or char_length(p_uid) not between 1 and 128 then
    raise exception 'invalid uid' using errcode = '22023';
  end if;
  select name into r from public.profiles where uid = p_uid;
  return r;                                   -- null when there is no profile
end $$;

-- create_invite: owner is the caller; expiry is the SERVER clock (the old client-clock expiry is not trusted).
-- A token that already exists is never overwritten (that would let one user take over another's invite).
create function public.create_invite(p_token text, p_owner_name text, p_minutes integer default 15)
returns timestamptz
language plpgsql security definer set search_path = ''
as $$
declare me text := app_private.require_uid(); exp timestamptz;
begin
  if p_token is null or p_token !~ '^[A-Za-z0-9_-]{16,64}$' then raise exception 'invalid token' using errcode = '22023'; end if;
  if p_owner_name is null or char_length(p_owner_name) > 40 then raise exception 'invalid name' using errcode = '22023'; end if;
  if p_minutes is null or p_minutes not between 1 and 1440 then raise exception 'invalid lifetime' using errcode = '22023'; end if;
  exp := now() + make_interval(mins => p_minutes);
  insert into public.invites (token, owner, owner_name, expires_at, created_at) values (p_token, me, p_owner_name, exp, now());
  return exp;                                 -- a duplicate token raises unique_violation (23505)
end $$;

-- get_invite: a direct get by token, as Firestore allowed. `expired` is computed here, on the server clock.
create function public.get_invite(p_token text)
returns table (owner text, owner_name text, expires_at timestamptz, expired boolean)
language plpgsql stable security definer set search_path = ''
as $$
begin
  perform app_private.require_uid();
  if p_token is null or char_length(p_token) not between 1 and 128 then raise exception 'invalid token' using errcode = '22023'; end if;
  return query select i.owner, i.owner_name, i.expires_at, i.expires_at < now() from public.invites i where i.token = p_token;
end $$;

-- delete_invite: owner only. A missing token is a no-op (as a Firestore delete of a missing document is).
create function public.delete_invite(p_token text) returns void
language plpgsql security definer set search_path = ''
as $$
declare me text := app_private.require_uid(); o text;
begin
  select owner into o from public.invites where token = p_token for update;
  if not found then return; end if;
  if o <> me then raise exception 'not your invite' using errcode = '42501'; end if;
  delete from public.invites where token = p_token;
end $$;

revoke all on function public.upsert_profile(text), public.get_profile_name(text),
  public.create_invite(text, text, integer), public.get_invite(text), public.delete_invite(text)
  from public, anon, authenticated;
grant execute on function public.upsert_profile(text), public.get_profile_name(text),
  public.create_invite(text, text, integer), public.get_invite(text), public.delete_invite(text)
  to authenticated;
