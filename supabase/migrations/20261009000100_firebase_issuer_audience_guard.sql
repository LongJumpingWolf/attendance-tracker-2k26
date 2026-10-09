-- Phase 6D: Firebase issuer/audience guard. LOCAL migration only: it has NOT been applied to the production project and must
-- not be pushed without the owner's explicit approval (`supabase db push --dry-run` first). Test helpers in supabase/tests now
-- supply the production iss/aud, and supabase/tests/database/issuer_audience_guard.test.sql covers the guard.
--
-- WHY: Firebase signs the ID tokens of EVERY Firebase project with the same keys. Supabase's own third-party setting rejects
-- unregistered issuers (verified in the Phase 5 spike, S8), but the database itself currently trusts any `sub`. The Supabase
-- documentation asks for a second, database-side check on `iss` and `aud`. This migration makes the database fail closed:
--   1. app_private.current_uid() returns NULL unless the JWT is issued for the production Firebase project. Every RLS policy
--      and every SECURITY DEFINER function derives identity from it (through require_uid()), so all of them inherit the check.
--   2. AS RESTRICTIVE policies on every table a client can read require the same thing, so a permissive policy added later
--      cannot bypass it.
--
-- Project id: `attendance-tracker-2k26` (.firebaserc, MIGRATION_CHECKPOINT.md). The owner must confirm that is the project
-- whose Firebase Auth tokens the production web app uses before this is promoted. Nothing else here is project specific.
--
-- No new function is created and no grant changes, so the catalog assertions of the existing security suite still hold.

create or replace function app_private.current_uid() returns text
language sql stable security invoker set search_path = ''
as $$
  select case
    when (auth.jwt() ->> 'iss') = 'https://securetoken.google.com/attendance-tracker-2k26'
     and (auth.jwt() ->> 'aud') = 'attendance-tracker-2k26'
    then nullif(auth.jwt() ->> 'sub', '')
  end
$$;
-- CREATE OR REPLACE keeps the existing ACL: no PUBLIC, EXECUTE for `authenticated` only (asserted by the test).

create policy connections_firebase_project on public.connections as restrictive for select to authenticated
  using ((select app_private.current_uid()) is not null);
create policy pings_firebase_project on public.pings as restrictive for select to authenticated
  using ((select app_private.current_uid()) is not null);
create policy push_tokens_firebase_project on public.push_tokens as restrictive for select to authenticated
  using ((select app_private.current_uid()) is not null);
create policy syncs_firebase_project on public.syncs as restrictive for select to authenticated
  using ((select app_private.current_uid()) is not null);
