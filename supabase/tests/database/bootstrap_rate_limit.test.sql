-- Phase 6E: tests for the bootstrap rate limiter (migration 20261009000200). Local only; rolled back.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

create schema trl;
grant usage on schema trl to public;
create function trl.err(q text) returns text language plpgsql as $$
begin execute q; return 'ok'; exception when others then return sqlstate; end $$;
create function trl.as_role(r text, claims jsonb default '{}') returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', claims::text, true);
  execute format('set local role %I', r);
end $$;
-- calls the limiter n times as service_role and returns the array of answers
create function trl.hammer(b text, k text, lim int, win int, n int) returns boolean[] language plpgsql as $$
declare res boolean[] := '{}'; i int;
begin
  for i in 1..n loop res := res || public.bootstrap_rate_check(b, k, lim, win); end loop;
  return res;
end $$;

select no_plan();

-- ---- catalog -----------------------------------------------------------------------------------------------------------
select ok((select prosecdef from pg_proc where oid = 'public.bootstrap_rate_check(text,text,integer,integer)'::regprocedure), 'the limiter is SECURITY DEFINER');
select ok((select proconfig @> array['search_path=""'] from pg_proc where oid = 'public.bootstrap_rate_check(text,text,integer,integer)'::regprocedure), 'search_path is pinned to the empty path');
select is((select array_agg(g.grantee::regrole::text order by g.grantee::regrole::text) from pg_proc p, aclexplode(p.proacl) g
           where p.oid = 'public.bootstrap_rate_check(text,text,integer,integer)'::regprocedure and g.privilege_type = 'EXECUTE'),
  array['postgres', 'service_role'], 'EXECUTE is held only by the owner and service_role (not PUBLIC, anon or authenticated)');
select ok(not has_function_privilege('anon', 'public.bootstrap_rate_check(text,text,integer,integer)', 'execute'), 'anon cannot execute it');
select ok(not has_function_privilege('authenticated', 'public.bootstrap_rate_check(text,text,integer,integer)', 'execute'), 'authenticated cannot execute it');
select ok((select relrowsecurity from pg_class where oid = 'app_private.rate_limits'::regclass), 'RLS is on for the counter table');
select is((select count(*)::int from pg_policy where polrelid = 'app_private.rate_limits'::regclass), 0, 'and it has no policy (deny-all for the Data API roles)');
select is((select count(*)::int from information_schema.role_table_grants where table_schema = 'app_private' and table_name = 'rate_limits' and grantee in ('anon', 'authenticated', 'PUBLIC')), 0,
  'anon, authenticated and PUBLIC hold no grant on the counter table');
select is((select count(*)::int from pg_namespace n where n.nspname = 'app_private' and has_schema_privilege('anon', n.oid, 'usage')), 0, 'anon has no USAGE on app_private');

-- ---- callers -----------------------------------------------------------------------------------------------------------
select trl.as_role('anon', '{"role":"anon"}');
select is(trl.err($$select public.bootstrap_rate_check('uid', 'x', 5, 60)$$), '42501', 'anon is refused');
select is(trl.err($$select * from app_private.rate_limits$$), '42501', 'anon cannot read the table');
select trl.as_role('authenticated', '{"sub":"AliceFbUid0000000000000000a1","role":"authenticated","iss":"https://securetoken.google.com/attendance-tracker-2k26","aud":"attendance-tracker-2k26"}');
select is(trl.err($$select public.bootstrap_rate_check('uid', 'x', 5, 60)$$), '42501', 'a signed-in user cannot call it (so cannot reset or inflate counters)');
select is(trl.err($$select * from app_private.rate_limits$$), '42501', 'a signed-in user cannot read the table');
select is(trl.err($$insert into app_private.rate_limits values ('uid','x',now(),1)$$), '42501', 'a signed-in user cannot write the table');
select is(trl.err($$delete from app_private.rate_limits$$), '42501', 'a signed-in user cannot delete from the table');
select trl.as_role('service_role', '{"role":"service_role"}');
select is(trl.err($$select public.bootstrap_rate_check('uid', 'x', 5, 60)$$), 'ok', 'service_role can call it');

-- ---- limiting ----------------------------------------------------------------------------------------------------------
select is(trl.hammer('uid', 'u1', 3, 3600, 5), array[true, true, true, false, false], 'the first 3 calls pass, the next are refused');
select is(trl.hammer('uid', 'u2', 3, 3600, 1), array[true], 'another key has its own counter');
select is(trl.hammer('ip', 'u1', 3, 3600, 1), array[true], 'another bucket has its own counter');
select is(trl.hammer('global', 'g', 1, 3600, 3), array[true, false, false], 'a limit of 1 allows exactly one');
reset role;
select is((select hits from app_private.rate_limits where bucket = 'uid' and key = 'u1'), 5, 'refused calls are still counted (an attacker cannot probe for free)');

-- ---- expiry and cleanup --------------------------------------------------------------------------------------------------
insert into app_private.rate_limits (bucket, key, window_start, hits) values ('uid', 'old', now() - interval '3 days', 99), ('uid', 'recent', now() - interval '1 hour', 99);
select trl.as_role('service_role', '{"role":"service_role"}');
select is(public.bootstrap_rate_check('uid', 'old', 2, 60), true, 'an old window never counts against a new one');
select is(public.bootstrap_rate_check('uid', 'recent', 2, 60), true, 'a different (current) window starts again at 1');
reset role;
select setseed(0.123);
do $$ begin for i in 1..400 loop perform public.bootstrap_rate_check('global', 'sweep', 100000, 60); end loop; end $$;
select is((select count(*)::int from app_private.rate_limits where key = 'old' and window_start < now() - interval '2 days'), 0, 'expired windows are swept opportunistically');
select is((select count(*)::int from app_private.rate_limits where key = 'recent'), 2, 'recent windows are kept');

-- ---- validation -----------------------------------------------------------------------------------------------------------
select trl.as_role('service_role', '{"role":"service_role"}');
select is(trl.err($$select public.bootstrap_rate_check('nope', 'k', 5, 60)$$), '22023', 'unknown bucket refused');
select is(trl.err($$select public.bootstrap_rate_check(null, 'k', 5, 60)$$), '22023', 'null bucket refused');
select is(trl.err($$select public.bootstrap_rate_check('uid', '', 5, 60)$$), '22023', 'empty key refused');
select is(trl.err($$select public.bootstrap_rate_check('uid', null, 5, 60)$$), '22023', 'null key refused');
select is(trl.err($$select public.bootstrap_rate_check('uid', repeat('k', 129), 5, 60)$$), '22023', 'oversized key refused');
select is(trl.err($$select public.bootstrap_rate_check('uid', 'k', 0, 60)$$), '22023', 'zero limit refused');
select is(trl.err($$select public.bootstrap_rate_check('uid', 'k', 100001, 60)$$), '22023', 'absurd limit refused');
select is(trl.err($$select public.bootstrap_rate_check('uid', 'k', 5, 0)$$), '22023', 'zero window refused');
select is(trl.err($$select public.bootstrap_rate_check('uid', 'k', 5, 86401)$$), '22023', 'window over one day refused');
select is(trl.err($$select public.bootstrap_rate_check('uid', 'k', null, 60)$$), '22023', 'null limit refused');
select is(trl.err($$select public.bootstrap_rate_check('uid', repeat('k', 128), 5, 60)$$), 'ok', 'a 128-character key is accepted');

reset role;
select * from finish();
rollback;
