-- Phase 8 (LOCAL FIRST): Postgres Changes for the single sync document.
-- The sync client never reads the event payload as data: an event only tells it to re-read through the normal, RLS-checked
-- select. So nothing about the table changes (no replica identity, no new grant, no new policy): the existing select policies
-- (syncs_owner_select and the Firebase project guard) decide who receives an event, because Realtime applies the subscriber's RLS.
-- Idempotent. NOT applied to production by this file's existence: a production `db push` needs the owner's explicit approval.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'syncs') then
    alter publication supabase_realtime add table public.syncs;
  end if;
end $$;
