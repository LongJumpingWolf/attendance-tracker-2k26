-- Distinguish a user explicitly declining attendance integration from a result that was applied.
-- This is a new migration (not an edit to an already-applied schema migration).
alter table public.pings
  add column if not exists dismissed_at timestamptz;

alter table public.pings drop constraint if exists pings_status_check;
alter table public.pings
  add constraint pings_status_check
  check (status in ('asking', 'answered', 'processed', 'dismissed'));

comment on column public.pings.dismissed_at is
  'Server time when the asker explicitly declined to integrate a reply into attendance. Distinct from processed_at.';

-- ---- dismiss_ping -----------------------------------------------------------------------------------------------
-- answered -> dismissed, for good. Requires the live lease so another device cannot independently apply the same reply.
create function public.dismiss_ping(p_id text, p_device_id text) returns text
language plpgsql security definer set search_path = ''
as $$
declare me text := app_private.require_uid(); p public.pings;
begin
  if p_device_id is null or p_device_id !~ '^[A-Za-z0-9_-]{8,64}$' then
    raise exception 'invalid device' using errcode = '22023';
  end if;

  select * into p from public.pings where id = p_id for update;
  if not found then raise exception 'no such ping' using errcode = 'P0002'; end if;
  if p.from_uid <> me then raise exception 'only the asker can dismiss' using errcode = '42501'; end if;
  if p.status = 'dismissed' then return 'already-dismissed'; end if;
  if p.status = 'processed' then return 'already-processed'; end if;
  if p.status <> 'answered' then raise exception 'not answered yet' using errcode = '55000'; end if;
  if p.claimed_by is distinct from p_device_id
     or p.claimed_at is null
     or p.claimed_at + interval '2 minutes' <= now() then
    raise exception 'live Ping lease required' using errcode = '55000';
  end if;

  update public.pings
     set status = 'dismissed', dismissed_at = now()
   where id = p_id;
  return 'dismissed';
end $$;

revoke all on function public.dismiss_ping(text, text) from public, anon, authenticated;
grant execute on function public.dismiss_ping(text, text) to authenticated;
