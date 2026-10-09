-- Phase 6D: tests for the PROPOSED issuer/audience guard. Run with supabase/proposed/run-proposed-tests.sh, which applies
-- 20261009000100_firebase_issuer_audience_guard.sql INSIDE a transaction in front of this file and rolls everything back.
-- The runner supplies `begin;` and `rollback;`. LOCAL DATABASE ONLY.
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

create schema tests;
grant usage on schema tests to public;
create function tests.claims(p_claims jsonb) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', p_claims::text, true);
  set local role authenticated;
end $$;
create function tests.back() returns void language plpgsql as $$ begin reset role; end $$;
create function tests.err(q text) returns text language plpgsql as $$
begin execute q; return 'ok'; exception when others then return sqlstate; end $$;
-- a well-formed production token for a uid; `extra` overrides or adds claims
create function tests.good(p_uid text, p_extra jsonb default '{}') returns void language sql as $$
  select tests.claims(jsonb_build_object('sub', p_uid, 'role', 'authenticated',
    'iss', 'https://securetoken.google.com/attendance-tracker-2k26', 'aud', 'attendance-tracker-2k26') || p_extra) $$;

select no_plan();

insert into syncs (uid, data, rev, updated_at) values ('AliceFbUid0000000000000000a1', 'alice-data', 1, 1790000000000);
insert into connections (id, from_uid, to_uid, status, created_at) values ('c-ab', 'AliceFbUid0000000000000000a1', 'BobFbUid000000000000000000b2', 'accepted', now());

-- ---- catalog: nothing else changed ------------------------------------------------------------------------------------
select is((select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid
           where c.relnamespace = 'public'::regnamespace and not p.polpermissive), 4, 'exactly four RESTRICTIVE policies exist');
select is((select array_agg(c.relname::text order by c.relname) from pg_policy p join pg_class c on c.oid = p.polrelid
           where c.relnamespace = 'public'::regnamespace and not p.polpermissive),
  array['connections', 'pings', 'push_tokens', 'syncs'], 'one restrictive policy on each client-readable table');
select is((select count(*)::int from pg_policy p join pg_class c on c.oid = p.polrelid
           where c.relnamespace = 'public'::regnamespace and p.polpermissive), 4, 'the four permissive owner/participant policies are unchanged');
select is((select count(*)::int from pg_proc p, aclexplode(p.proacl) a
           where p.pronamespace in ('public'::regnamespace, 'app_private'::regnamespace) and a.grantee = 0), 0, 'no function is granted to PUBLIC');
select is((select count(*)::int from pg_proc p where pronamespace = 'app_private'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute')), 1,
  'authenticated can still execute only current_uid() among the private helpers');
select is((select count(*)::int from pg_proc p where pronamespace = 'app_private'::regnamespace and has_function_privilege('anon', p.oid, 'execute')), 0, 'anon can execute no private helper');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid = 'app_private.current_uid()'::regprocedure), 'current_uid() still pins search_path');
select ok(not (select prosecdef from pg_proc where oid = 'app_private.current_uid()'::regprocedure), 'current_uid() is still SECURITY INVOKER');
select is((select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace), 16, 'public still exposes exactly the 16 functions');

-- ---- a production token works -------------------------------------------------------------------------------------------
select tests.good('AliceFbUid0000000000000000a1');
select is(app_private.current_uid(), 'AliceFbUid0000000000000000a1', 'a production-project token yields its sub');
select is((select count(*)::int from syncs), 1, 'the owner reads their sync under a production token');
select is((select count(*)::int from connections), 1, 'a participant reads their connection under a production token');
select is(tests.err($$select public.sync_put(1, 'alice-data-2', 1790000000001)$$), 'ok', 'the owner can call an RPC under a production token');
select is(tests.err($$select public.upsert_profile('Alice')$$), 'ok', 'upsert_profile works under a production token');

-- ---- tokens that must not give an identity ------------------------------------------------------------------------------
select tests.claims('{"sub":"AliceFbUid0000000000000000a1","role":"authenticated"}');
select is(app_private.current_uid(), null, 'no iss/aud (the shape the Phase 3 suite uses) gives no identity');
select is((select count(*)::int from syncs), 0, '... and reads nothing');
select is(tests.err($$select public.sync_put(2, 'x', 1790000000002)$$), '42501', '... and every RPC refuses it');
select is(tests.err($$select public.upsert_profile('Alice')$$), '42501', '... including upsert_profile');

select tests.good('AliceFbUid0000000000000000a1', '{"aud":"some-other-firebase-project"}');
select is(app_private.current_uid(), null, 'wrong audience gives no identity');
select is(tests.err($$select public.sync_put(2, 'x', 1790000000002)$$), '42501', 'wrong audience: RPC refused');
select is((select count(*)::int from syncs), 0, 'wrong audience: reads nothing');

select tests.good('AliceFbUid0000000000000000a1', '{"iss":"https://securetoken.google.com/some-other-firebase-project"}');
select is(app_private.current_uid(), null, 'wrong issuer (other Firebase project) gives no identity');
select is(tests.err($$select public.sync_put(2, 'x', 1790000000002)$$), '42501', 'wrong issuer: RPC refused');

select tests.good('AliceFbUid0000000000000000a1', '{"iss":"https://accounts.google.com"}');
select is(app_private.current_uid(), null, 'a Google (non-Firebase) issuer gives no identity');

select tests.good('AliceFbUid0000000000000000a1', '{"iss":"https://securetoken.google.com/Attendance-Tracker-2K26"}');
select is(app_private.current_uid(), null, 'issuer comparison is exact (case differs)');

select tests.good('AliceFbUid0000000000000000a1', '{"aud":["attendance-tracker-2k26"]}');
select is(app_private.current_uid(), null, 'an array audience is not accepted (Firebase sends a string)');

select tests.good('AliceFbUid0000000000000000a1', '{"iss":null}');
select is(app_private.current_uid(), null, 'a null issuer gives no identity');

select tests.good('', '{}');
select is(app_private.current_uid(), null, 'an empty sub gives no identity even with the right iss/aud');

-- ---- client-chosen fields are not an identity ---------------------------------------------------------------------------
select tests.good('BobFbUid000000000000000000b2', '{"user_id":"AliceFbUid0000000000000000a1","uid":"AliceFbUid0000000000000000a1","email":"alice@example.com","name":"Alice"}');
select is(app_private.current_uid(), 'BobFbUid000000000000000000b2', 'only sub is the identity; user_id, uid, email and name are ignored');
select is((select count(*)::int from syncs), 0, 'a caller who claims another uid in other fields reads nothing of theirs');
select is((select count(*)::int from connections), 1, 'Bob still sees his own connection (as a participant) and nothing else');

-- ---- a token for another account still sees nothing, and anon is still shut out -------------------------------------------
select tests.good('MalloryFbUid0000000000000m5');
select is((select count(*)::int from syncs), 0, 'a stranger with a valid production token reads no sync');
select is((select count(*)::int from connections), 0, 'a stranger reads no connection');
select tests.back();
select tests.claims('{"role":"anon"}');
reset role;
set local role anon;
select is(tests.err($$select * from public.syncs$$), '42501', 'anon is still denied');

-- ---- direct mutation stays denied under a production token --------------------------------------------------------------
select tests.good('AliceFbUid0000000000000000a1');
select is(tests.err($$insert into syncs (uid, data, rev) values ('AliceFbUid0000000000000000a1', 'x', 9)$$), '42501', 'direct INSERT denied');
select is(tests.err($$update syncs set data = 'x'$$), '42501', 'direct UPDATE denied');
select is(tests.err($$delete from syncs$$), '42501', 'direct DELETE denied');
select is(tests.err($$truncate syncs$$), '42501', 'TRUNCATE denied');
select tests.back();

select * from finish();
