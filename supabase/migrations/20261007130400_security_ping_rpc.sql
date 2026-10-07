-- Phase 3: Ping security. The state machine asking -> answered -> processed lives in these functions.
-- Why SECURITY DEFINER: clients have SELECT only on pings; every mutation needs several checks and a row lock to be atomic,
-- and identity/timestamps must come from the server. search_path pinned, objects schema-qualified, EXECUTE to
-- `authenticated` only. Row locks (FOR UPDATE) serialise racing devices.
--
-- Parity target: the deployed Firestore rules (R3). Strict limits apply to NEW pings and to answering; legacy rows (9..12
-- items, odd dates, missing created_at, removed requests) stay readable, leasable and finalizable (decision 2b).
-- Deliberate, documented difference (decision 2b rule 6): the "connected" check on ANSWER is pair-based (an accepted
-- connection between exactly from_uid and to_uid), not by the stored request id.

-- ---- helpers (not callable by clients) -----------------------------------------------------------------------------

create function app_private.accepted_between(a text, b text) returns boolean
language sql stable set search_path = ''
as $$
  select exists (select 1 from public.connections c
                 where c.status = 'accepted'
                   and ((c.from_uid = a and c.to_uid = b) or (c.from_uid = b and c.to_uid = a)))
$$;

-- Shape of a NEW Ping's classes: 1..8, only the known keys, answer present and null, string key/subjectId/name (name <= 60).
create function app_private.valid_new_items(p_items jsonb) returns boolean
language plpgsql stable set search_path = ''
as $$
declare e jsonb; k text;
begin
  if p_items is null or jsonb_typeof(p_items) <> 'array' then return false; end if;
  if jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 8 then return false; end if;
  if octet_length(p_items::text) > 16384 then return false; end if;
  for e in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(e) <> 'object' then return false; end if;
    for k in select jsonb_object_keys(e) loop
      if k not in ('key', 'subjectId', 'name', 't', 'answer') then return false; end if;
    end loop;
    if not (e ? 'answer') or jsonb_typeof(e -> 'answer') <> 'null' then return false; end if;
    if jsonb_typeof(e -> 'key') is distinct from 'string'
       or jsonb_typeof(e -> 'subjectId') is distinct from 'string'
       or jsonb_typeof(e -> 'name') is distinct from 'string' then return false; end if;
    if char_length(e ->> 'key') > 200 or char_length(e ->> 'subjectId') > 200 or char_length(e ->> 'name') > 60 then return false; end if;
    if (e ? 't') and (jsonb_typeof(e -> 't') <> 'string' or char_length(e ->> 't') > 16) then return false; end if;
  end loop;
  return true;
end $$;

-- An answer changes ONLY each class's `answer` to yes or no; same count, same order, everything else identical.
create function app_private.valid_answer(p_old jsonb, p_new jsonb) returns boolean
language plpgsql stable set search_path = ''
as $$
begin
  if p_new is null or jsonb_typeof(p_new) <> 'array' or jsonb_typeof(p_old) <> 'array' then return false; end if;
  if jsonb_array_length(p_new) <> jsonb_array_length(p_old) then return false; end if;
  for i in 0 .. jsonb_array_length(p_old) - 1 loop
    if jsonb_typeof(p_new -> i) <> 'object' or jsonb_typeof(p_old -> i) <> 'object' then return false; end if;
    if (p_new -> i) - 'answer' <> (p_old -> i) - 'answer' then return false; end if;
    if jsonb_typeof(p_new -> i -> 'answer') <> 'string' or (p_new -> i ->> 'answer') not in ('yes', 'no') then return false; end if;
  end loop;
  return true;
end $$;

revoke all on function app_private.accepted_between(text, text), app_private.valid_new_items(jsonb),
  app_private.valid_answer(jsonb, jsonb) from public;   -- Postgres grants EXECUTE to PUBLIC by default; only the definer functions call these

-- ---- create_ping -----------------------------------------------------------------------------------------------
-- from = caller. created_at = server clock. request_id must name an accepted connection between exactly these two people
-- (directly or through an alias). A retry with the same id and the same logical request returns 'existing'; the same id with
-- a different request is refused (23505); both are safe under a double tap because the insert is atomic.
create function public.create_ping(
  p_id text, p_to_uid text, p_from_name text, p_to_name text, p_request_id text, p_date text, p_items jsonb
) returns text
language plpgsql security definer set search_path = ''
as $$
declare
  me text := app_private.require_uid();
  ex public.pings;
  day timestamptz;
  n integer;
  keys jsonb;
begin
  if p_id is null or p_id !~ '^[A-Za-z0-9_-]{8,64}$' then raise exception 'invalid ping id' using errcode = '22023'; end if;
  keys := case when jsonb_typeof(p_items) = 'array'
               then (select coalesce(jsonb_agg(e -> 'key'), '[]'::jsonb) from jsonb_array_elements(p_items) e) else '[]'::jsonb end;

  -- idempotent retry (checked first so a retry still resolves after the answer, or after the connection ended)
  select * into ex from public.pings where id = p_id;
  if found then
    if ex.from_uid = me and ex.to_uid = p_to_uid and ex.class_date = p_date and ex.request_id is not distinct from p_request_id
       and (select coalesce(jsonb_agg(e -> 'key'), '[]'::jsonb) from jsonb_array_elements(ex.items) e) = keys then
      return 'existing';
    end if;
    raise exception 'ping id already used' using errcode = '23505';
  end if;

  if p_to_uid is null or p_to_uid = '' or char_length(p_to_uid) > 128 or p_to_uid = me then raise exception 'invalid recipient' using errcode = '22023'; end if;
  if p_from_name is null or char_length(p_from_name) > 40 or p_to_name is null or char_length(p_to_name) > 40 then raise exception 'invalid name' using errcode = '22023'; end if;
  if p_request_id is null or char_length(p_request_id) > 128 then raise exception 'invalid connection' using errcode = '22023'; end if;
  if not app_private.valid_new_items(p_items) then raise exception 'invalid classes' using errcode = '22023'; end if;

  if p_date is null or p_date !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'invalid date' using errcode = '22023'; end if;
  begin
    day := (p_date::date)::timestamp at time zone 'UTC';
  exception when others then
    raise exception 'invalid date' using errcode = '22023';
  end;
  -- Same window as the rule: not older than the Ping's lifetime (3 days), not more than a day ahead (time zones).
  if day < now() - interval '3 days' or day > now() + interval '1 day' then raise exception 'class day not recent' using errcode = '22023'; end if;

  if not exists (
    select 1 from public.connections c
    where c.status = 'accepted'
      and ((c.from_uid = me and c.to_uid = p_to_uid) or (c.from_uid = p_to_uid and c.to_uid = me))
      and c.id in (p_request_id, coalesce((select a.canonical_id from public.connection_aliases a where a.legacy_id = p_request_id), p_request_id))
  ) then
    raise exception 'not connected' using errcode = '42501';
  end if;

  insert into public.pings (id, from_uid, to_uid, from_name, to_name, request_id, class_date, items, status, created_at, legacy)
  values (p_id, me, p_to_uid, p_from_name, p_to_name, p_request_id, p_date, p_items, 'asking', now(), false)
  on conflict (id) do nothing;
  get diagnostics n = row_count;
  if n = 1 then return 'created'; end if;

  -- lost a race with an identical concurrent create: that is still exactly one Ping
  select * into ex from public.pings where id = p_id;
  if ex.from_uid = me and ex.to_uid = p_to_uid and ex.class_date = p_date and ex.request_id is not distinct from p_request_id then return 'existing'; end if;
  raise exception 'ping id already used' using errcode = '23505';
end $$;

-- ---- answer_ping -----------------------------------------------------------------------------------------------
create function public.answer_ping(p_id text, p_items jsonb) returns void
language plpgsql security definer set search_path = ''
as $$
declare me text := app_private.require_uid(); p public.pings;
begin
  select * into p from public.pings where id = p_id for update;
  if not found then raise exception 'no such ping' using errcode = 'P0002'; end if;
  if p.to_uid <> me then raise exception 'only the person asked can answer' using errcode = '42501'; end if;
  if p.status <> 'asking' then raise exception 'not waiting for an answer' using errcode = '55000'; end if;
  -- expiry on the server clock; a row with no created_at, or one dated in the future, cannot be answered (legacy: expires)
  if p.created_at is null or p.created_at > now() or now() >= p.created_at + interval '3 days' then
    raise exception 'ping expired or not answerable' using errcode = '55000';
  end if;
  if jsonb_array_length(p.items) > 8 then raise exception 'legacy ping cannot be answered' using errcode = '55000'; end if;
  if not app_private.accepted_between(p.from_uid, p.to_uid) then raise exception 'not connected' using errcode = '42501'; end if;
  if not app_private.valid_answer(p.items, p_items) then raise exception 'invalid answer' using errcode = '22023'; end if;
  update public.pings set items = p_items, status = 'answered', responded_at = now() where id = p_id;
end $$;

-- ---- lease_ping ------------------------------------------------------------------------------------------------
-- True when this device now holds the lease (free, its own, or run out after 2 minutes on the server clock).
-- False when another device holds a live lease or the Ping is not waiting to be applied. Legacy answered Pings can be leased.
create function public.lease_ping(p_id text, p_device_id text) returns boolean
language plpgsql security definer set search_path = ''
as $$
declare me text := app_private.require_uid(); p public.pings;
begin
  if p_device_id is null or p_device_id !~ '^[A-Za-z0-9_-]{8,64}$' then raise exception 'invalid device' using errcode = '22023'; end if;
  select * into p from public.pings where id = p_id for update;
  if not found then return false; end if;
  if p.from_uid <> me then raise exception 'only the asker can lease' using errcode = '42501'; end if;
  if p.status <> 'answered' then return false; end if;
  if p.claimed_at is null or p.claimed_by = p_device_id or p.claimed_at + interval '2 minutes' <= now() then
    update public.pings set claimed_by = p_device_id, claimed_at = now() where id = p_id;
    return true;
  end if;
  return false;
end $$;

-- ---- finalize_ping ---------------------------------------------------------------------------------------------
-- answered -> processed, for good. Already processed is reported, not an error. Legacy answered Pings can be finalized.
create function public.finalize_ping(p_id text) returns text
language plpgsql security definer set search_path = ''
as $$
declare me text := app_private.require_uid(); p public.pings;
begin
  select * into p from public.pings where id = p_id for update;
  if not found then raise exception 'no such ping' using errcode = 'P0002'; end if;
  if p.from_uid <> me then raise exception 'only the asker can finish' using errcode = '42501'; end if;
  if p.status = 'processed' then return 'already'; end if;
  if p.status <> 'answered' then raise exception 'not answered yet' using errcode = '55000'; end if;
  update public.pings set status = 'processed', processed_at = now() where id = p_id;
  return 'processed';
end $$;

-- ---- remove_ping -----------------------------------------------------------------------------------------------
-- Either participant, except an answer that has not been applied yet. A missing Ping is a no-op.
create function public.remove_ping(p_id text) returns void
language plpgsql security definer set search_path = ''
as $$
declare me text := app_private.require_uid(); p public.pings;
begin
  select * into p from public.pings where id = p_id for update;
  if not found then return; end if;
  if p.from_uid <> me and p.to_uid <> me then raise exception 'not your ping' using errcode = '42501'; end if;
  if p.status = 'answered' then raise exception 'answer not applied yet' using errcode = '55000'; end if;
  delete from public.pings where id = p_id;
end $$;

revoke all on function public.create_ping(text, text, text, text, text, text, jsonb), public.answer_ping(text, jsonb),
  public.lease_ping(text, text), public.finalize_ping(text), public.remove_ping(text) from public, anon, authenticated;
grant execute on function public.create_ping(text, text, text, text, text, text, jsonb), public.answer_ping(text, jsonb),
  public.lease_ping(text, text), public.finalize_ping(text), public.remove_ping(text) to authenticated;
