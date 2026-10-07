-- Phase 3: connection (friend request) RPCs.
-- Why SECURITY DEFINER: clients have no INSERT/UPDATE/DELETE grant on connections; identity fields are set here from the
-- JWT, never accepted from the client. search_path pinned, objects schema-qualified, EXECUTE to `authenticated` only.
-- Historical duplicates are untouched: nothing here reads or writes legacy_requests.

-- send_request: from = caller (cannot be forged), status 'pending', timestamps server-side. A second ACTIVE request between
-- the same two people, in either direction, is refused by the unique index (23505): that is the new-world duplicate rule.
create function public.send_request(p_to_uid text, p_from_name text, p_to_name text) returns text
language plpgsql security definer set search_path = ''
as $$
declare me text := app_private.require_uid(); new_id text := replace(gen_random_uuid()::text, '-', '');
begin
  if p_to_uid is null or p_to_uid = '' or char_length(p_to_uid) > 128 or p_to_uid = me then
    raise exception 'invalid recipient' using errcode = '22023';
  end if;
  if p_from_name is null or char_length(p_from_name) > 40 or p_to_name is null or char_length(p_to_name) > 40 then
    raise exception 'invalid name' using errcode = '22023';
  end if;
  insert into public.connections (id, from_uid, to_uid, from_name, to_name, status, created_at)
  values (new_id, me, p_to_uid, p_from_name, p_to_name, 'pending', now());
  return new_id;
end $$;

-- respond_request: only the person who was asked, only while pending, only to accepted/declined. Nothing else can change.
create function public.respond_request(p_id text, p_status text) returns void
language plpgsql security definer set search_path = ''
as $$
declare me text := app_private.require_uid(); c public.connections;
begin
  if p_status is null or p_status not in ('accepted', 'declined') then raise exception 'invalid status' using errcode = '22023'; end if;
  select * into c from public.connections where id = p_id for update;
  if not found then raise exception 'no such request' using errcode = 'P0002'; end if;
  if c.to_uid <> me then raise exception 'only the recipient can respond' using errcode = '42501'; end if;
  if c.status <> 'pending' then raise exception 'already answered' using errcode = '55000'; end if;
  update public.connections set status = p_status, responded_at = now() where id = p_id;
end $$;

-- remove_request: either participant, any status (parity). A legacy id resolves through connection_aliases to the canonical
-- row; the archived legacy document is never touched. A missing id is a no-op.
create function public.remove_request(p_id text) returns void
language plpgsql security definer set search_path = ''
as $$
declare me text := app_private.require_uid(); target text := p_id; c public.connections;
begin
  if not exists (select 1 from public.connections where id = p_id) then
    select canonical_id into target from public.connection_aliases where legacy_id = p_id;
    if target is null then return; end if;
  end if;
  select * into c from public.connections where id = target for update;
  if not found then return; end if;
  if c.from_uid <> me and c.to_uid <> me then raise exception 'not your connection' using errcode = '42501'; end if;
  delete from public.connections where id = target;
end $$;

revoke all on function public.send_request(text, text, text), public.respond_request(text, text), public.remove_request(text)
  from public, anon, authenticated;
grant execute on function public.send_request(text, text, text), public.respond_request(text, text), public.remove_request(text)
  to authenticated;
