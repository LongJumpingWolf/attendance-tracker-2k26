-- Phase 3: sync and push-token write paths.
-- Why SECURITY DEFINER: clients have SELECT only (own rows, by RLS). Writes need uid from the JWT and an atomic compare-and-set;
-- search_path pinned, objects schema-qualified, EXECUTE to `authenticated` only. The sync blob is never parsed or altered.

-- sync_put: compare-and-set on rev. p_expected_rev = the rev the client last read (0 when it has none).
--   0 and no row  -> insert rev 1;   n and row at rev n -> update to n+1;   anything else -> 40001 (re-pull and merge).
-- Parity with the rule: data is a string under 900000 (bytes here, stricter). updated_at is the client's number, as before.
create function public.sync_put(p_expected_rev integer, p_data text, p_updated_at bigint) returns integer
language plpgsql security definer set search_path = ''
as $$
declare me text := app_private.require_uid(); r integer;
begin
  if p_expected_rev is null or p_expected_rev < 0 then raise exception 'invalid revision' using errcode = '22023'; end if;
  if p_data is null or octet_length(p_data) >= 900000 then raise exception 'invalid data' using errcode = '22023'; end if;
  if p_expected_rev = 0 then
    insert into public.syncs (uid, data, rev, updated_at) values (me, p_data, 1, p_updated_at)
    on conflict (uid) do nothing returning rev into r;
  else
    update public.syncs set data = p_data, rev = rev + 1, updated_at = p_updated_at
    where uid = me and rev = p_expected_rev returning rev into r;
  end if;
  if r is null then raise exception 'revision conflict' using errcode = '40001'; end if;
  return r;
end $$;

-- save_push_token: this device's token, for the caller only. Existing single tokens import as device 'legacy'.
-- At most 20 devices per account, so one account cannot grow the table without bound.
create function public.save_push_token(p_token text, p_device_id text default 'legacy') returns void
language plpgsql security definer set search_path = ''
as $$
declare me text := app_private.require_uid();
begin
  if p_token is null or char_length(p_token) not between 1 and 4095 then raise exception 'invalid token' using errcode = '22023'; end if;
  if p_device_id is null or p_device_id !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'invalid device' using errcode = '22023'; end if;
  if not exists (select 1 from public.push_tokens where uid = me and device_id = p_device_id)
     and (select count(*) from public.push_tokens where uid = me) >= 20 then
    raise exception 'too many devices' using errcode = '54000';
  end if;
  insert into public.push_tokens (uid, device_id, token, updated_at) values (me, p_device_id, p_token, now())
  on conflict (uid, device_id) do update set token = excluded.token, updated_at = now();
end $$;

-- delete_push_token: the caller's own. A device id removes that device; null removes all of the caller's tokens.
create function public.delete_push_token(p_device_id text default null) returns void
language plpgsql security definer set search_path = ''
as $$
declare me text := app_private.require_uid();
begin
  delete from public.push_tokens where uid = me and (p_device_id is null or device_id = p_device_id);
end $$;

revoke all on function public.sync_put(integer, text, bigint), public.save_push_token(text, text), public.delete_push_token(text)
  from public, anon, authenticated;
grant execute on function public.sync_put(integer, text, bigint), public.save_push_token(text, text), public.delete_push_token(text)
  to authenticated;
