-- PROPOSED, NOT A MIGRATION. This file is deliberately OUTSIDE supabase/migrations so no `db push` can pick it up.
-- It is the draft of the push outbox (Phase 10). It needs the owner's explicit approval to become a migration, a hosted secret for the
-- sender, and the validation listed in HOSTED_READINESS_PLAN.md. It has been replayed ONLY in throwaway LOCAL databases
-- (tests/local-supabase/hosted-readiness.test.ts), after all 13 existing migrations.
--
-- Design (the decision logic is lib/backend/supabase/push-dispatch.ts; this is its durable outbox):
--   * one row per (ping, kind) -> an event is enqueued EXACTLY ONCE, however often the RPC is retried (unique + ON CONFLICT DO NOTHING);
--   * the recipient is derived inside the trigger from the Ping row, never from anything a client sends;
--   * only new, non-legacy Pings enqueue: the service-role import of old Pings (legacy = true) must never send a push;
--   * clients cannot see or touch it at all (RLS on, no policy, no grants): only service_role (the sender) can claim and finish rows;
--   * a claim is a LEASE: a sender that dies leaves the row to be reclaimed after lease_until; claiming uses FOR UPDATE SKIP LOCKED so
--     two senders never take the same row;
--   * attempts are bounded and counted here; the sender (dispatchPingEvent) decides sent / retry / give up and reports back through finish.

create table public.push_outbox (
  id              bigint generated always as identity primary key,
  ping_id         text not null,
  kind            text not null check (kind in ('incoming', 'result')),
  recipient_uid   text not null,
  status          text not null default 'pending'
                  check (status in ('pending', 'claimed', 'sent', 'no-token', 'token-removed', 'gave-up', 'expired', 'stale', 'gone')),
  attempts        integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_until     timestamptz,
  created_at      timestamptz not null default now(),
  done_at         timestamptz,
  unique (ping_id, kind)
);
comment on table public.push_outbox is 'Phase 10 (proposed). One row per Ping event. service_role only; clients have no access of any kind.';
create index push_outbox_due_idx on public.push_outbox (next_attempt_at) where status in ('pending', 'claimed');

alter table public.push_outbox enable row level security;       -- no policy: nothing is visible to anon / authenticated
revoke all on public.push_outbox from public, anon, authenticated;
grant select, insert, update on public.push_outbox to service_role;

-- ---- enqueue: from the Ping row itself ------------------------------------------------------------------------------------------------
create function app_private.enqueue_ping_push() returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.legacy is not true and new.status = 'asking' then
      insert into public.push_outbox (ping_id, kind, recipient_uid) values (new.id, 'incoming', new.to_uid) on conflict (ping_id, kind) do nothing;
    end if;
  elsif tg_op = 'UPDATE' then
    if new.legacy is not true and old.status = 'asking' and new.status = 'answered' then
      insert into public.push_outbox (ping_id, kind, recipient_uid) values (new.id, 'result', new.from_uid) on conflict (ping_id, kind) do nothing;
    end if;
  end if;
  return null;
end $$;
revoke all on function app_private.enqueue_ping_push() from public, anon, authenticated;

create trigger pings_enqueue_push after insert or update of status on public.pings
  for each row execute function app_private.enqueue_ping_push();

-- ---- claim: a leased batch for ONE sender ---------------------------------------------------------------------------------------------
create function public.push_outbox_claim(p_batch integer, p_lease_seconds integer) returns setof public.push_outbox
language plpgsql security definer set search_path = ''
as $$
begin
  if p_batch is null or p_batch < 1 or p_batch > 100 then raise exception 'invalid batch' using errcode = '22023'; end if;
  if p_lease_seconds is null or p_lease_seconds < 10 or p_lease_seconds > 900 then raise exception 'invalid lease' using errcode = '22023'; end if;
  return query
    update public.push_outbox o
       set status = 'claimed', lease_until = now() + make_interval(secs => p_lease_seconds), attempts = o.attempts + 1
     where o.id in (
       select id from public.push_outbox
        where (status = 'pending' and next_attempt_at <= now()) or (status = 'claimed' and lease_until <= now())
        order by next_attempt_at, id
        limit p_batch
        for update skip locked)
    returning o.*;
end $$;

-- ---- finish: the sender reports the outcome of ONE claimed row ------------------------------------------------------------------------
-- outcome 'retry' puts it back with a delay (bounded by the caller's own attempt limit); anything else is final.
create function public.push_outbox_finish(p_id bigint, p_outcome text, p_retry_seconds integer) returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if p_outcome not in ('sent', 'no-token', 'token-removed', 'gave-up', 'expired', 'stale', 'gone', 'retry') then raise exception 'invalid outcome' using errcode = '22023'; end if;
  if p_outcome = 'retry' then
    if p_retry_seconds is null or p_retry_seconds < 1 or p_retry_seconds > 3600 then raise exception 'invalid delay' using errcode = '22023'; end if;
    update public.push_outbox set status = 'pending', lease_until = null, next_attempt_at = now() + make_interval(secs => p_retry_seconds)
     where id = p_id and status = 'claimed';
  else
    update public.push_outbox set status = p_outcome, lease_until = null, done_at = now() where id = p_id and status = 'claimed';
  end if;
end $$;

revoke all on function public.push_outbox_claim(integer, integer), public.push_outbox_finish(bigint, text, integer) from public, anon, authenticated;
grant execute on function public.push_outbox_claim(integer, integer), public.push_outbox_finish(bigint, text, integer) to service_role;

-- ---- housekeeping the plan needs (not created here): delete finished rows older than 30 days, like Pings' own history window.
