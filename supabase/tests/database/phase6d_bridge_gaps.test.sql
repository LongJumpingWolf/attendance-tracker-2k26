-- Phase 6D: extra local checks for gaps the Phase 3 suite did not assert. It does not modify or relax any existing test.
-- Run: npx supabase test db     (local database only; everything is rolled back)
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

create schema tests6d;
grant usage on schema tests6d to public;
create function tests6d.claims(p_claims jsonb) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', (jsonb_build_object('iss', 'https://securetoken.google.com/attendance-tracker-2k26', 'aud', 'attendance-tracker-2k26') || p_claims)::text, true);
  set local role authenticated;
end $$;
create function tests6d.err(q text) returns text language plpgsql as $$
begin execute q; return 'ok'; exception when others then return sqlstate; end $$;

select no_plan();

insert into syncs (uid, data, rev, updated_at) values ('AliceFbUid0000000000000000a1', 'alice-data', 1, 1790000000000);

-- ---- function hygiene beyond `public` (the Phase 3 catalog test only looked at public) -------------------------------------
select is((select count(*)::int from pg_proc p where p.pronamespace in ('public'::regnamespace, 'app_private'::regnamespace)
            and not coalesce(p.proconfig @> array['search_path=""'], false)), 0,
  'every function in public AND app_private pins search_path to the empty path');
select is((select count(*)::int from pg_proc p where p.pronamespace in ('public'::regnamespace, 'app_private'::regnamespace)
            and p.prosecdef and not coalesce(p.proconfig @> array['search_path=""'], false)), 0,
  'every SECURITY DEFINER function pins search_path');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
            and pg_get_functiondef(p.oid) !~ 'app_private\.(require_uid|current_uid)\(\)'), 0,
  'every public SECURITY DEFINER function derives the caller from current_uid()/require_uid()');
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prosecdef
            and pg_get_functiondef(p.oid) ~* 'auth\.uid\(\)'), 0, 'no function uses auth.uid() (it casts to uuid and fails for Firebase uids)');
select is((select count(*)::int from pg_policy po where pg_get_expr(po.polqual, po.polrelid) ~* 'auth\.uid\(\)'), 0, 'no policy uses auth.uid()');
select is((select count(*)::int from pg_proc p where p.pronamespace in ('public'::regnamespace, 'app_private'::regnamespace) and p.prosecdef
            and pg_get_userbyid(p.proowner) in ('anon', 'authenticated')), 0, 'no SECURITY DEFINER function is owned by a Data API role');

-- ---- direct mutation of EVERY application table, for both Data API roles --------------------------------------------------
select is((select count(*)::int from pg_class c, unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) pr
            where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
              and (has_table_privilege('authenticated', c.oid, pr) or has_table_privilege('anon', c.oid, pr))), 0,
  'neither anon nor authenticated holds any mutating privilege on any public table');
select is((select count(*)::int from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and has_table_privilege('anon', c.oid, 'SELECT')), 0,
  'anon cannot SELECT any public table');
select is((select count(*)::int from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and not c.relrowsecurity), 0, 'RLS is on for every public table');
select is((select count(*)::int from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relforcerowsecurity), 0,
  'FORCE RLS is not used (the import and SECURITY DEFINER functions rely on owner bypass); recorded so a change is deliberate');
select is((select count(*)::int from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind in ('v', 'm', 'f')), 0, 'there is no view, materialized view or foreign table in public that could bypass RLS');

-- ---- claims the client controls --------------------------------------------------------------------------------------------
-- A Firebase token also carries `uid`, `user_id`, `email`, `name`. Only `sub` is an identity.
select tests6d.claims('{"sub":"BobFbUid000000000000000000b2","role":"authenticated","user_id":"AliceFbUid0000000000000000a1","uid":"AliceFbUid0000000000000000a1","firebase":{"identities":{"email":["alice@example.com"]}}}');
select is(app_private.current_uid(), 'BobFbUid000000000000000000b2', 'user_id/uid/firebase claims never override sub');
select is((select count(*)::int from syncs), 0, '... so Alice''s sync stays invisible');

-- A claim `role: service_role` inside the JWT does not change the Postgres role the Data API already chose, so RLS still applies.
select tests6d.claims('{"sub":"BobFbUid000000000000000000b2","role":"service_role"}');
select is(current_user::text, 'authenticated', 'the Postgres role is set by the platform, not by a claim inside the token body');
select is((select count(*)::int from syncs), 0, 'a service_role claim string does not bypass RLS');
select is(tests6d.err($$update syncs set data = 'x'$$), '42501', 'a service_role claim string does not allow a direct write');
select is(tests6d.err($$select * from public.legacy_requests$$), '42501', 'server-only tables stay closed to a token claiming service_role');
select is(tests6d.err($$select * from app_private.current_uid()$$), 'ok', 'current_uid() itself is callable (it reads only the caller''s own claim)');
select is(tests6d.err($$select app_private.require_uid()$$), '42501', 'require_uid() is not callable by authenticated');

-- ---- identity shapes -------------------------------------------------------------------------------------------------------
select tests6d.claims('{"sub":"AliceFbUid0000000000000000a1","role":"authenticated"}');
select is(pg_typeof(app_private.current_uid())::text, 'text', 'the identity type is text (a Firebase uid is not a uuid)');
select tests6d.claims('{"sub":"","role":"authenticated"}');
select is(app_private.current_uid(), null, 'an empty sub is no identity');
select tests6d.claims('{"role":"authenticated"}');
select is(app_private.current_uid(), null, 'a token without sub is no identity');
select tests6d.claims('{"sub":12345,"role":"authenticated"}');
select is(app_private.current_uid(), '12345', 'a numeric sub is read as text, never cast to uuid');

-- ---- Realtime ---------------------------------------------------------------------------------------------------------------
reset role;
select is((select count(*)::int from pg_publication_tables where pubname = 'supabase_realtime'), 0,
  'no table is published to Realtime yet: enabling it is a later, reviewed step (it also needs the restrictive issuer/audience policies)');

select * from finish();
rollback;
