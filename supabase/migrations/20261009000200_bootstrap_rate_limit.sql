-- Phase 6E: database-backed rate limit for the auth-role-bootstrap Edge Function. LOCAL migration only: NOT applied to production
-- and not to be pushed without the owner's explicit approval (`supabase db push --dry-run --linked` first).
--
-- What it is: a fixed-window counter. The Edge Function calls public.bootstrap_rate_check() with the service-role key; the
-- function counts the call in the current window and answers true while the count is within the limit.
-- What it is not: authentication. Keys are chosen by the caller (the verified Firebase uid, a hash, or the word 'global');
-- the function trusts nothing it cannot bound, and only service_role may execute it.
--
-- Hardening: the table lives in app_private (not exposed by the Data API) with RLS on and no policy and no grant for
-- anon/authenticated; the function is SECURITY DEFINER with search_path pinned to the empty path, schema-qualified, input
-- validated, EXECUTE revoked from PUBLIC/anon/authenticated and granted to service_role only.

create table app_private.rate_limits (
  bucket       text        not null check (bucket in ('uid', 'ip', 'global')),
  key          text        not null check (char_length(key) between 1 and 128),
  window_start timestamptz not null,
  hits         integer     not null check (hits > 0),
  primary key (bucket, key, window_start)
);
alter table app_private.rate_limits enable row level security;       -- no policy: deny-all for the Data API roles
revoke all on app_private.rate_limits from public, anon, authenticated;
create index rate_limits_window_idx on app_private.rate_limits (window_start);

create function public.bootstrap_rate_check(p_bucket text, p_key text, p_limit integer, p_window_seconds integer)
returns boolean
language plpgsql security definer set search_path = ''
as $$
declare
  w timestamptz;
  n integer;
begin
  if p_bucket is null or p_bucket not in ('uid', 'ip', 'global') then raise exception 'invalid bucket' using errcode = '22023'; end if;
  if p_key is null or char_length(p_key) not between 1 and 128 then raise exception 'invalid key' using errcode = '22023'; end if;
  if p_limit is null or p_limit not between 1 and 100000 then raise exception 'invalid limit' using errcode = '22023'; end if;
  if p_window_seconds is null or p_window_seconds not between 1 and 86400 then raise exception 'invalid window' using errcode = '22023'; end if;

  w := to_timestamp(floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds);
  -- atomic: concurrent callers serialize on the row, so N parallel calls produce exactly counts 1..N
  insert into app_private.rate_limits as r (bucket, key, window_start, hits) values (p_bucket, p_key, w, 1)
  on conflict (bucket, key, window_start) do update set hits = r.hits + 1
  returning r.hits into n;

  -- opportunistic cleanup of expired windows (the longest window is one day), so no scheduler is needed
  if random() < 0.02 then
    delete from app_private.rate_limits where window_start < now() - interval '2 days';
  end if;
  return n <= p_limit;
end $$;

revoke all on function public.bootstrap_rate_check(text, text, integer, integer) from public, anon, authenticated;
grant execute on function public.bootstrap_rate_check(text, text, integer, integer) to service_role;
