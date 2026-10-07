-- Phase 3: local security suite. Impersonates callers through JWT claims (sub = a Firebase-style TEXT uid, role = authenticated).
-- This tests the database security model under the EXPECTED identity shape only. It does not prove the Firebase bridge (Phase 5).
-- Run: npx supabase test db     (local database only; everything is rolled back)

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

-- ------------------------------------------------------------------------------------------------------------------
-- Test helpers (live in a throwaway schema, rolled back with the file)
-- ------------------------------------------------------------------------------------------------------------------
create schema tests;
grant usage on schema tests to public;

create function tests.act_as(p_uid text, p_extra jsonb default '{}') returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', (jsonb_build_object('sub', p_uid, 'role', 'authenticated') || p_extra)::text, true);
  set local role authenticated;
end $$;
create function tests.act_claims(p_claims jsonb) returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', p_claims::text, true);
  set local role authenticated;
end $$;
create function tests.act_anon() returns void language plpgsql as $$
begin
  reset role;
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
  set local role anon;
end $$;
create function tests.back() returns void language plpgsql as $$ begin reset role; end $$;

-- SQLSTATE of a statement, or 'ok' when it succeeds
create function tests.err(q text) returns text language plpgsql as $$
begin execute q; return 'ok';
exception when others then return sqlstate; end $$;

create function tests.today(d integer default 0) returns text language sql stable as
$$ select to_char(((now() at time zone 'UTC')::date + d), 'YYYY-MM-DD') $$;

create function tests.items(n integer) returns jsonb language sql stable as $$
  select coalesce(jsonb_agg(jsonb_build_object('key', 'sub' || g || '@09:00', 'subjectId', 's' || g, 'name', 'Subject ' || g, 't', '09:00', 'answer', null) order by g), '[]'::jsonb)
  from generate_series(1, n) g $$;

create function tests.answered(items jsonb, ans text) returns jsonb language sql stable as $$
  select jsonb_agg(e || jsonb_build_object('answer', ans) order by o) from jsonb_array_elements(items) with ordinality t(e, o) $$;

select no_plan();

-- ------------------------------------------------------------------------------------------------------------------
-- Fixtures: four Firebase-style uids (28-char text, NOT uuids) and their connections. Created as the table owner.
-- ------------------------------------------------------------------------------------------------------------------
-- A alice, B bob, C carol, D dave, M mallory (stranger)
insert into connections (id, from_uid, to_uid, from_name, to_name, status, created_at, responded_at) values
  ('conn-AB-accepted', 'AliceFbUid0000000000000000a1', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'accepted', now(), now()),
  ('conn-AD-accepted', 'AliceFbUid0000000000000000a1', 'DaveFbUid00000000000000000d4', 'Alice', 'Dave', 'accepted', now(), now()),
  ('conn-CM-canonical', 'CarolFbUid000000000000000000c3', 'MalloryFbUid0000000000000m5', 'Carol', 'Mallory', 'accepted', now(), now());

-- ==================================================================================================================
-- CATALOG: RLS, grants, function hygiene (as the owner)
-- ==================================================================================================================
select is((select count(*)::int from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r' and c.relrowsecurity), 10,
  'RLS is enabled on all 10 application tables');
select is((select count(*)::int from information_schema.role_table_grants
           where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'), 0,
  'anon and authenticated hold no INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/TRIGGER on any table');
select is((select count(*)::int from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon'), 0,
  'anon holds no grant on any table');
select is((select array_agg(table_name::text order by table_name) from information_schema.role_table_grants
           where table_schema = 'public' and grantee = 'authenticated'),
  array['connections', 'pings', 'push_tokens', 'syncs'], 'authenticated can SELECT only connections, pings, push_tokens, syncs');
select ok(has_table_privilege('service_role', 'public.legacy_requests', 'insert'), 'service_role keeps access to the migration tables');
select is((select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace), 16, 'public exposes exactly the 16 intended functions');
select is((select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace and not prosecdef), 0, 'all of them are SECURITY DEFINER (each justified in its migration)');
select is((select count(*)::int from pg_proc where pronamespace = 'public'::regnamespace
           and not coalesce(proconfig @> array['search_path=""'], false)), 0, 'every public function pins search_path to the empty path');
select is((select count(*)::int from pg_proc p where pronamespace = 'public'::regnamespace and has_function_privilege('anon', p.oid, 'execute')), 0,
  'anon cannot EXECUTE any public function');
select is((select count(*)::int from pg_proc p, aclexplode(p.proacl) a
           where p.pronamespace in ('public'::regnamespace, 'app_private'::regnamespace) and a.grantee = 0), 0,
  'no function is granted to PUBLIC');
select is((select count(*)::int from pg_proc p where pronamespace = 'public'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute')), 16,
  'authenticated can EXECUTE all 16');
select is((select count(*)::int from pg_proc p where pronamespace = 'app_private'::regnamespace and has_function_privilege('authenticated', p.oid, 'execute')), 1,
  'of the private helpers authenticated can execute only current_uid()');

-- ==================================================================================================================
-- IDENTITY
-- ==================================================================================================================
select tests.act_as('AliceFbUid0000000000000000a1');
select is(app_private.current_uid(), 'AliceFbUid0000000000000000a1', 'identity is the JWT sub');
select ok(app_private.current_uid() !~ '^[0-9a-f]{8}-[0-9a-f]{4}-', 'a Firebase uid is handled as text, not a uuid');
-- a parameter can never name the caller: there is no uid parameter on any write function
select tests.back();
select is((select count(*)::int from pg_proc p where p.pronamespace = 'public'::regnamespace
           and p.proname in ('create_ping','answer_ping','lease_ping','finalize_ping','remove_ping','sync_put','save_push_token','delete_push_token','send_request','respond_request','remove_request','upsert_profile','create_invite','delete_invite')
           and exists (select 1 from unnest(coalesce(p.proargnames, '{}')) n where n in ('p_from_uid', 'p_uid', 'p_owner', 'p_user')) ), 0,
  'no write function accepts a caller uid as a parameter');

-- a token with no sub (only email / name) has no identity
select tests.act_claims('{"role":"authenticated","email":"alice@example.com","name":"Alice"}');
select is(app_private.current_uid(), null, 'email and display name are not an identity');
select is(tests.err($$select public.save_push_token('tok')$$), '42501', 'a token without sub is refused by every write function');
select is(tests.err($$select public.upsert_profile('Alice')$$), '42501', 'a token without sub cannot write a profile');
select is((select count(*)::int from connections), 0, 'a token without sub sees no connections');

-- the display name / email of ANOTHER user in the claims does not grant that user's data
select tests.act_as('MalloryFbUid0000000000000m5', '{"name":"Alice","email":"alice@example.com"}');
select is((select count(*)::int from connections), 1, 'claiming the name "Alice" shows only the caller''s own connections (Mallory has one)');
select is(tests.err($$select public.sync_put(0, 'mallory-data', 1)$$), 'ok', 'caller creates a sync for their own uid');
select tests.back();
select is((select array_agg(uid) from syncs), array['MalloryFbUid0000000000000m5'], 'the sync row belongs to the JWT sub, not to a claimed name');
delete from syncs;

-- anon
select tests.act_anon();
select is(tests.err($$select * from public.pings$$), '42501', 'anon cannot read pings');
select is(tests.err($$select public.get_invite('tokenAAAAAAAAAAAAAAAAAA')$$), '42501', 'anon cannot call get_invite');
select is(tests.err($$select public.sync_put(0,'x',1)$$), '42501', 'anon cannot call sync_put');

-- ==================================================================================================================
-- SYNC
-- ==================================================================================================================
select tests.act_as('AliceFbUid0000000000000000a1');
select is(public.sync_put(0, 'gz1:AAAA', 1790000000001), 1, 'owner creates the sync at rev 1');
select is(public.sync_put(1, ' gz1:H4sI+/== '||E'\r\n'||'é中😀', 1790000000002), 2, 'owner updates with the right revision');
select is((select data from syncs where uid = 'AliceFbUid0000000000000000a1'), ' gz1:H4sI+/== '||E'\r\n'||'é中😀', 'owner reads the blob back byte-identical');
select is(tests.err($$select public.sync_put(1, 'stale', 3)$$), '40001', 'a stale revision is refused (compare-and-set)');
select is(tests.err($$select public.sync_put(0, 'again', 3)$$), '40001', 'creating over an existing sync is refused');
select is(tests.err($$select public.sync_put(2, repeat('a', 900000), 3)$$), '22023', 'a blob at the size limit is refused');
select is(tests.err($$insert into syncs (uid, data, rev) values ('AliceFbUid0000000000000000a1', 'x', 9)$$), '42501', 'direct INSERT into syncs is denied');
select is(tests.err($$update syncs set data = 'x'$$), '42501', 'direct UPDATE of syncs is denied');
select is(tests.err($$delete from syncs$$), '42501', 'DELETE of syncs is denied');
select tests.act_as('BobFbUid000000000000000000b2');
select is((select count(*)::int from syncs), 0, 'a non-owner reads nothing');
select is(tests.err($$select public.sync_put(2, 'bob-overwrites-alice', 1)$$), '40001', 'a non-owner cannot update the owner''s sync (no row of their own at that rev)');
select tests.back();
select is((select rev from syncs where uid = 'AliceFbUid0000000000000000a1'), 2, 'the owner''s sync is unchanged by the non-owner');

-- ==================================================================================================================
-- PROFILES
-- ==================================================================================================================
select tests.act_as('AliceFbUid0000000000000000a1');
select lives_ok($$select public.upsert_profile('Alice')$$, 'caller writes their own profile');
select is(tests.err($$select public.upsert_profile('')$$), '22023', 'empty name refused');
select is(tests.err($$select public.upsert_profile(repeat('x', 41))$$), '22023', 'name over 40 refused');
select tests.act_as('BobFbUid000000000000000000b2');
select is(public.get_profile_name('AliceFbUid0000000000000000a1'), 'Alice', 'a signed-in user can look up one name by uid');
select is(public.get_profile_name('NobodyFbUid00000000000000000'), null, 'an unknown uid gives null');
select is(tests.err($$select public.get_profile_name('')$$), '22023', 'an empty uid is refused');
select is(tests.err($$select * from public.profiles$$), '42501', 'there is no profile directory (direct SELECT denied)');
select is(tests.err($$insert into public.profiles (uid, name) values ('BobFbUid000000000000000000b2', 'x')$$), '42501', 'direct INSERT into profiles denied');
select is(tests.err($$update public.profiles set name = 'hacked'$$), '42501', 'direct UPDATE of profiles denied');
select lives_ok($$select public.upsert_profile('Bob')$$, 'second user writes their own profile');
select tests.back();
select is((select name from profiles where uid = 'AliceFbUid0000000000000000a1'), 'Alice', 'one user''s write never changes another''s profile');

-- ==================================================================================================================
-- INVITES
-- ==================================================================================================================
select tests.act_as('AliceFbUid0000000000000000a1');
select ok(public.create_invite('inviteTokenAAAAAAAAAA', 'Alice', 15) > now(), 'invite created; expiry comes from the server clock');
select is(tests.err($$select public.create_invite('short', 'Alice', 15)$$), '22023', 'a malformed token is refused');
select is(tests.err($$select public.create_invite('inviteTokenBBBBBBBBBB', 'Alice', 0)$$), '22023', 'a zero lifetime is refused');
select is(tests.err($$select public.create_invite('inviteTokenBBBBBBBBBB', 'Alice', 99999)$$), '22023', 'an absurd lifetime is refused');
select tests.act_as('BobFbUid000000000000000000b2');
select is((select owner from public.get_invite('inviteTokenAAAAAAAAAA')), 'AliceFbUid0000000000000000a1', 'any signed-in user can look up one invite by token');
select is((select expired from public.get_invite('inviteTokenAAAAAAAAAA')), false, 'a fresh invite is not expired');
select is(tests.err($$select * from public.invites$$), '42501', 'token listing is impossible (direct SELECT denied)');
select is(tests.err($$update public.invites set owner = 'BobFbUid000000000000000000b2'$$), '42501', 'direct UPDATE (owner takeover) denied');
select is(tests.err($$insert into public.invites (token, owner, expires_at) values ('inviteTokenCCCCCCCCCC', 'AliceFbUid0000000000000000a1', now())$$), '42501', 'direct INSERT (forging an owner) denied');
select is(tests.err($$select public.delete_invite('inviteTokenAAAAAAAAAA')$$), '42501', 'a non-owner cannot delete an invite');
select is(tests.err($$select public.create_invite('inviteTokenAAAAAAAAAA', 'Bob', 15)$$), '23505', 'an existing token is never overwritten');
select tests.back();
select is((select owner from invites where token = 'inviteTokenAAAAAAAAAA'), 'AliceFbUid0000000000000000a1', 'the invite is still the owner''s');
update invites set expires_at = now() - interval '1 minute' where token = 'inviteTokenAAAAAAAAAA';
insert into invites (token, owner, owner_name, expires_at, created_at) values ('legacyInviteToken0001', 'GoneFbUid', null, now() - interval '9 days', null);
select tests.act_as('BobFbUid000000000000000000b2');
select is((select expired from public.get_invite('inviteTokenAAAAAAAAAA')), true, 'expiry is judged on the server clock');
select is((select owner from public.get_invite('legacyInviteToken0001')), 'GoneFbUid', 'a legacy invite with null name and null created_at is still representable and readable');
select tests.act_as('AliceFbUid0000000000000000a1');
select lives_ok($$select public.delete_invite('inviteTokenAAAAAAAAAA')$$, 'the owner deletes their invite');

-- ==================================================================================================================
-- CONNECTIONS
-- ==================================================================================================================
select tests.act_as('AliceFbUid0000000000000000a1');
select is((select count(*)::int from connections), 2, 'a participant reads only connections involving them (A has two)');
select tests.act_as('BobFbUid000000000000000000b2');
select is((select count(*)::int from connections), 1, 'the other participant sees theirs');
select tests.act_as('MalloryFbUid0000000000000m5');
select is((select count(*)::int from connections where id like 'conn-A%'), 0, 'an unrelated user cannot read someone else''s connections');
select tests.act_as('AliceFbUid0000000000000000a1');
select is(tests.err($$insert into connections (id, from_uid, to_uid, status) values ('forged000000000000001', 'BobFbUid000000000000000000b2', 'AliceFbUid0000000000000000a1', 'accepted')$$), '42501', 'forged direct INSERT (from_uid / accepted) denied');
select is(tests.err($$update connections set status = 'accepted'$$), '42501', 'direct UPDATE denied');
select is(tests.err($$delete from connections$$), '42501', 'direct DELETE denied');
select is(tests.err($$select public.send_request('AliceFbUid0000000000000000a1', 'A', 'A')$$), '22023', 'a request to oneself is refused');
select is(tests.err($$select public.send_request('BobFbUid000000000000000000b2', 'Alice', 'Bob')$$), '23505', 'a NEW duplicate active pair is refused (same direction)');
select tests.act_as('BobFbUid000000000000000000b2');
select is(tests.err($$select public.send_request('AliceFbUid0000000000000000a1', 'Bob', 'Alice')$$), '23505', 'a NEW duplicate active pair is refused (opposite direction)');
select is(tests.err($$select public.send_request('CarolFbUid000000000000000000c3', repeat('x', 41), 'Carol')$$), '22023', 'a name over 40 is refused');
select tests.act_as('CarolFbUid000000000000000000c3');
create temp table req as select public.send_request('AliceFbUid0000000000000000a1', 'Carol', 'Alice') as id;
grant select on req to public;
select tests.back();
select is((select from_uid || '>' || to_uid || ':' || status from connections where id = (select id from req)),
  'CarolFbUid000000000000000000c3>AliceFbUid0000000000000000a1:pending', 'the sender is the caller and the status is pending, set by the server');
select isnt((select created_at from connections where id = (select id from req)), null::timestamptz, 'created_at is set by the server');
select tests.act_as('CarolFbUid000000000000000000c3');
select is(tests.err(format($$select public.respond_request(%L, 'accepted')$$, (select id from req))), '42501', 'the sender cannot accept their own request');
select tests.act_as('MalloryFbUid0000000000000m5');
select is(tests.err(format($$select public.respond_request(%L, 'accepted')$$, (select id from req))), '42501', 'a stranger cannot respond');
select is(tests.err(format($$select public.remove_request(%L)$$, (select id from req))), '42501', 'a stranger cannot delete');
select tests.act_as('AliceFbUid0000000000000000a1');
select is(tests.err(format($$select public.respond_request(%L, 'maybe')$$, (select id from req))), '22023', 'only accepted or declined is allowed');
select is(tests.err(format($$select public.respond_request(%L, 'accepted')$$, (select id from req))), 'ok', 'the recipient accepts');
select is(tests.err(format($$select public.respond_request(%L, 'declined')$$, (select id from req))), '55000', 'a request cannot be answered twice');
select is(tests.err(format($$select public.remove_request(%L)$$, (select id from req))), 'ok', 'either participant can remove (recipient here)');
select is(tests.err($$select public.remove_request('doesNotExist000000000')$$), 'ok', 'removing a missing request is a no-op');
-- legacy duplicate handling: an alias resolves to the canonical row; the archived document stays
select tests.back();
insert into legacy_requests (id, raw) values ('legacyDupRequest00000001', '{"from":"MalloryFbUid0000000000000m5","to":"CarolFbUid000000000000000000c3","status":"accepted"}');
insert into connection_aliases (legacy_id, canonical_id, reason) values ('legacyDupRequest00000001', 'conn-CM-canonical', 'D-4');
select tests.act_as('MalloryFbUid0000000000000m5');
select is(tests.err($$select public.remove_request('legacyDupRequest00000001')$$), 'ok', 'removing by a legacy id removes the canonical connection');
select tests.back();
select is((select count(*)::int from connections where id = 'conn-CM-canonical'), 0, 'the canonical row is gone');
select is((select count(*)::int from legacy_requests where id = 'legacyDupRequest00000001'), 1, 'the archived legacy document is untouched');

-- ==================================================================================================================
-- PINGS
-- ==================================================================================================================
select tests.act_as('AliceFbUid0000000000000000a1');
select is(public.create_ping('ping-AB-0001', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'conn-AB-accepted', tests.today(-1), tests.items(2)), 'created', 'an asker creates a Ping for an accepted mate');
select is(public.create_ping('ping-AB-0001', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'conn-AB-accepted', tests.today(-1), tests.items(2)), 'existing', 'a retry with the same id is the same Ping (idempotent)');
select is(tests.err($$select public.create_ping('ping-AB-0001', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'conn-AB-accepted', tests.today(-1), tests.items(3))$$), '23505', 'the same id with a different request is refused, not merged');
select is(tests.err($$select public.create_ping('ping-AB-0002', 'AliceFbUid0000000000000000a1', 'Alice', 'Alice', 'conn-AB-accepted', tests.today(), tests.items(1))$$), '22023', 'a Ping to oneself is refused');
select is(tests.err($$select public.create_ping('ping-AC-0001', 'CarolFbUid000000000000000000c3', 'Alice', 'Carol', 'conn-AB-accepted', tests.today(), tests.items(1))$$), '42501', 'forged receiver: Carol is not on that connection');
select is(tests.err($$select public.create_ping('ping-AB-0003', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'conn-AD-accepted', tests.today(), tests.items(1))$$), '42501', 'forged connection: it names a different pair');
select is(tests.err($$select public.create_ping('ping-AB-0004', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'noSuchConnection', tests.today(), tests.items(1))$$), '42501', 'forged connection: it does not exist');
select tests.act_as('MalloryFbUid0000000000000m5');
select is(tests.err($$select public.create_ping('ping-MB-0001', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'conn-AB-accepted', tests.today(), tests.items(1))$$), '42501', 'forged asker: Mallory cannot ping as part of Alice and Bob''s connection');
select tests.act_as('AliceFbUid0000000000000000a1');
select is(tests.err($$select public.create_ping('ping-AB-0005', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'conn-AB-accepted', tests.today(), tests.items(9))$$), '22023', 'more than 8 classes is refused for a NEW Ping');
select is(tests.err($$select public.create_ping('ping-AB-0006', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'conn-AB-accepted', tests.today(), '[]'::jsonb)$$), '22023', 'zero classes is refused');
select is(tests.err($$select public.create_ping('ping-AB-0007', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'conn-AB-accepted', tests.today(), tests.items(8))$$), 'ok', 'exactly 8 classes is allowed');
select is(tests.err($$select public.create_ping('ping-AB-0008', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'conn-AB-accepted', tests.today(), (select jsonb_agg(e || '{"answer":"yes"}') from jsonb_array_elements(tests.items(1)) e))$$), '22023', 'a Ping born already answered is refused');
select is(tests.err($$select public.create_ping('ping-AB-0009', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'conn-AB-accepted', tests.today(), (select jsonb_agg(e || '{"extra":1}') from jsonb_array_elements(tests.items(1)) e))$$), '22023', 'an extra field on a class is refused');
select is(tests.err($$select public.create_ping('ping-AB-0010', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'conn-AB-accepted', tests.today(), (select jsonb_agg(e || jsonb_build_object('name', repeat('n', 61))) from jsonb_array_elements(tests.items(1)) e))$$), '22023', 'a class name over 60 is refused');
select is(tests.err($$select public.create_ping('ping-AB-0011', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'conn-AB-accepted', tests.today(), (select jsonb_agg(e || '{"subjectId":7}') from jsonb_array_elements(tests.items(1)) e))$$), '22023', 'a non-string subjectId is refused');
select is(tests.err($$select public.create_ping('ping-AB-0012', 'BobFbUid000000000000000000b2', 'Alice', repeat('b', 41), 'conn-AB-accepted', tests.today(), tests.items(1))$$), '22023', 'a name over 40 is refused');
select is(tests.err($$select public.create_ping('ping-AB-0013', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'conn-AB-accepted', tests.today(-10), tests.items(1))$$), '22023', 'a class day months/weeks ago is refused');
select is(tests.err($$select public.create_ping('ping-AB-0014', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'conn-AB-accepted', tests.today(3), tests.items(1))$$), '22023', 'a class day far ahead is refused');
select is(tests.err($$select public.create_ping('ping-AB-0015', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'conn-AB-accepted', '2026-02-30', tests.items(1))$$), '22023', 'an impossible calendar date is refused');
select is(tests.err($$select public.create_ping('ping-AB-0016', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'conn-AB-accepted', 'tomorrow', tests.items(1))$$), '22023', 'a non-YYYY-MM-DD date is refused for NEW Pings');
select is(tests.err($$select public.create_ping('bad id', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'conn-AB-accepted', tests.today(), tests.items(1))$$), '22023', 'the id has to be a plain token');
select is(tests.err($$insert into pings (id, from_uid, to_uid, class_date, items, status) values ('forgedPing0001', 'BobFbUid000000000000000000b2', 'AliceFbUid0000000000000000a1', '2026-10-06', '[]', 'answered')$$), '42501', 'direct INSERT of a forged Ping is denied (forged asker, status, timestamps)');
-- reading
select is((select count(*)::int from pings where id = 'ping-AB-0001'), 1, 'the asker reads it');
select tests.act_as('BobFbUid000000000000000000b2');
select is((select count(*)::int from pings where id = 'ping-AB-0001'), 1, 'the receiver reads it');
select tests.act_as('MalloryFbUid0000000000000m5');
select is((select count(*)::int from pings), 0, 'an unrelated user reads no Pings');
select tests.act_as('DaveFbUid00000000000000000d4');
select is((select count(*)::int from pings), 0, 'a connected-to-someone-else user reads none either');
-- server stamps, not client
select tests.back();
select is((select created_at = now() from pings where id = 'ping-AB-0001'), true, 'created_at is the server clock');
select is((select legacy from pings where id = 'ping-AB-0001'), false, 'a new Ping is never legacy');
-- answering
select tests.act_as('AliceFbUid0000000000000000a1');
select is(tests.err(format($$select public.answer_ping('ping-AB-0001', %L::jsonb)$$, tests.answered(tests.items(2), 'yes'))), '42501', 'the asker cannot answer their own Ping');
select tests.act_as('MalloryFbUid0000000000000m5');
select is(tests.err(format($$select public.answer_ping('ping-AB-0001', %L::jsonb)$$, tests.answered(tests.items(2), 'yes'))), '42501', 'a stranger cannot answer');
select tests.act_as('BobFbUid000000000000000000b2');
select is(tests.err(format($$select public.answer_ping('ping-AB-0001', %L::jsonb)$$, tests.answered(tests.items(2), 'maybe'))), '22023', 'only yes or no is accepted');
select is(tests.err(format($$select public.answer_ping('ping-AB-0001', %L::jsonb)$$, tests.answered(tests.items(1), 'yes'))), '22023', 'the number of classes cannot change');
select is(tests.err(format($$select public.answer_ping('ping-AB-0001', %L::jsonb)$$, (select jsonb_agg(e || '{"name":"Free period"}') from jsonb_array_elements(tests.answered(tests.items(2), 'yes')) e))), '22023', 'forged class details: the name cannot change');
select is(tests.err(format($$select public.answer_ping('ping-AB-0001', %L::jsonb)$$, (select jsonb_agg(e || '{"subjectId":"other"}') from jsonb_array_elements(tests.answered(tests.items(2), 'yes')) e))), '22023', 'forged class details: the subject cannot change');
select is(tests.err(format($$select public.answer_ping('ping-AB-0001', %L::jsonb)$$, (select jsonb_agg(e || '{"key":"x@10:00"}') from jsonb_array_elements(tests.answered(tests.items(2), 'yes')) e))), '22023', 'forged class details: the key cannot change');
select is(tests.err(format($$select public.answer_ping('ping-AB-0001', %L::jsonb)$$, (select jsonb_agg(e || '{"t":"11:00"}') from jsonb_array_elements(tests.answered(tests.items(2), 'yes')) e))), '22023', 'forged class details: the time cannot change');
select is(tests.err(format($$select public.answer_ping('ping-AB-0001', %L::jsonb)$$, (select jsonb_agg(e || '{"extra":1}') from jsonb_array_elements(tests.answered(tests.items(2), 'yes')) e))), '22023', 'a field cannot be added');
select is(tests.err($$update pings set status = 'processed'$$), '42501', 'the receiver cannot skip straight to processed (direct UPDATE denied)');
select is(tests.err($$update pings set created_at = now() + interval '30 days'$$), '42501', 'forged timestamps: direct UPDATE of created_at denied');
select is(tests.err(format($$select public.answer_ping('ping-AB-0001', %L::jsonb)$$, tests.answered(tests.items(2), 'yes'))), 'ok', 'the receiver answers yes/no on each class');
select is(tests.err(format($$select public.answer_ping('ping-AB-0001', %L::jsonb)$$, tests.answered(tests.items(2), 'no'))), '55000', 'it cannot be answered twice');
select tests.back();
select is((select status || ':' || (responded_at = now())::text from pings where id = 'ping-AB-0001'), 'answered:true', 'answered, with the server''s respond time');
select is((select items -> 0 ->> 'answer' from pings where id = 'ping-AB-0001'), 'yes', 'the answers are stored');

-- expiry
select tests.act_as('AliceFbUid0000000000000000a1');
select is(public.create_ping('ping-AB-exp1', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'conn-AB-accepted', tests.today(), tests.items(1)), 'created', 'setup: Ping to expire');
select is(public.create_ping('ping-AB-edge', 'BobFbUid000000000000000000b2', 'Alice', 'Bob', 'conn-AB-accepted', tests.today(), tests.items(1)), 'created', 'setup: Ping just inside its life');
select tests.back();
update pings set created_at = now() - interval '3 days 1 minute' where id = 'ping-AB-exp1';
update pings set created_at = now() - interval '2 days 23 hours 59 minutes' where id = 'ping-AB-edge';
select tests.act_as('BobFbUid000000000000000000b2');
select is(tests.err(format($$select public.answer_ping('ping-AB-exp1', %L::jsonb)$$, tests.answered(tests.items(1), 'yes'))), '55000', 'an expired Ping cannot be answered, whatever the app''s clock says');
select is(tests.err(format($$select public.answer_ping('ping-AB-edge', %L::jsonb)$$, tests.answered(tests.items(1), 'yes'))), 'ok', 'a Ping just inside its life can be answered');

-- connection ended
select tests.act_as('AliceFbUid0000000000000000a1');
select is(public.create_ping('ping-AD-0001', 'DaveFbUid00000000000000000d4', 'Alice', 'Dave', 'conn-AD-accepted', tests.today(), tests.items(1)), 'created', 'setup: Ping to a mate whose connection will end');
select tests.back();
delete from connections where id = 'conn-AD-accepted';
select tests.act_as('DaveFbUid00000000000000000d4');
select is(tests.err(format($$select public.answer_ping('ping-AD-0001', %L::jsonb)$$, tests.answered(tests.items(1), 'yes'))), '42501', 'cannot be answered once the connection has ended');

-- legacy rows: strict new-world rules are NOT forced onto them
select tests.back();
insert into pings (id, from_uid, to_uid, request_id, class_date, items, status, created_at, legacy, legacy_flags) values
  ('legacy-twelve-01', 'AliceFbUid0000000000000000a1', 'BobFbUid000000000000000000b2', 'conn-AB-accepted', '2026-10-05', tests.items(12), 'asking', now(), true, array['items>8']),
  ('legacy-nodate-01', 'AliceFbUid0000000000000000a1', 'BobFbUid000000000000000000b2', 'conn-AB-accepted', '5/10', tests.items(1), 'asking', null, true, array['no-created-at', 'date-format']),
  ('legacy-ans-0001', 'AliceFbUid0000000000000000a1', 'BobFbUid000000000000000000b2', 'conn-gone', 'weird date', tests.answered(tests.items(10), 'yes'), 'answered', null, true, array['items>8', 'request-missing']);
select tests.act_as('BobFbUid000000000000000000b2');
select is(tests.err(format($$select public.answer_ping('legacy-twelve-01', %L::jsonb)$$, tests.answered(tests.items(12), 'yes'))), '55000', 'a legacy Ping with 12 classes cannot be answered');
select is(tests.err(format($$select public.answer_ping('legacy-nodate-01', %L::jsonb)$$, tests.answered(tests.items(1), 'yes'))), '55000', 'a legacy Ping with no created_at cannot be answered');
select tests.act_as('AliceFbUid0000000000000000a1');
select is(public.lease_ping('legacy-ans-0001', 'deviceLegacy01'), true, 'an answered legacy Ping (10 classes, removed request) can be leased');
select is(public.finalize_ping('legacy-ans-0001'), 'processed', 'and finished: the unapplied favour is not lost');

-- lease
select tests.act_as('BobFbUid000000000000000000b2');
select is(tests.err($$select public.lease_ping('ping-AB-0001', 'deviceBobBob01')$$), '42501', 'only the asker can lease');
select is(tests.err($$select public.finalize_ping('ping-AB-0001')$$), '42501', 'only the asker can finalize');
select tests.act_as('MalloryFbUid0000000000000m5');
select is(tests.err($$select public.lease_ping('ping-AB-0001', 'deviceMallory1')$$), '42501', 'a stranger cannot lease');
select tests.act_as('AliceFbUid0000000000000000a1');
select is(public.lease_ping('ping-AB-0007', 'deviceAlice0001'), false, 'an unanswered Ping cannot be leased');
select is(tests.err($$select public.finalize_ping('ping-AB-0007')$$), '55000', 'an unanswered Ping cannot be finalized');
select is(tests.err($$select public.lease_ping('ping-AB-0001', 'x')$$), '22023', 'a malformed device id is refused');
select is(public.lease_ping('ping-AB-0001', 'deviceAlice0001'), true, 'the first device takes the lease');
select is(public.lease_ping('ping-AB-0001', 'deviceAlice0002'), false, 'a second device cannot while it is live');
select is(public.lease_ping('ping-AB-0001', 'deviceAlice0001'), true, 'the holder renews its own lease straight away (crash recovery)');
select tests.back();
update pings set claimed_at = now() - interval '3 minutes' where id = 'ping-AB-0001';
select tests.act_as('AliceFbUid0000000000000000a1');
select is(public.lease_ping('ping-AB-0001', 'deviceAlice0002'), true, 'another device takes over once the lease has run out (server clock)');
select tests.back();
select is((select claimed_by from pings where id = 'ping-AB-0001'), 'deviceAlice0002', 'the new holder is recorded');
-- the lease holder identity / claimed_at cannot be forged by a client: no direct write path
select tests.act_as('AliceFbUid0000000000000000a1');
select is(tests.err($$update pings set claimed_by = 'deviceForged01', claimed_at = null$$), '42501', 'a client cannot backdate or clear a lease directly');

-- remove
select is(tests.err($$select public.remove_ping('ping-AB-0001')$$), '55000', 'an answer cannot be thrown away before it has been applied (asker)');
select tests.act_as('BobFbUid000000000000000000b2');
select is(tests.err($$select public.remove_ping('ping-AB-0001')$$), '55000', 'an answer cannot be thrown away before it has been applied (receiver)');
select is(tests.err($$delete from pings$$), '42501', 'direct DELETE denied');
select tests.act_as('MalloryFbUid0000000000000m5');
select is(tests.err($$select public.remove_ping('ping-AB-0007')$$), '42501', 'a stranger cannot withdraw a waiting Ping');
select tests.act_as('BobFbUid000000000000000000b2');
select is(tests.err($$select public.remove_ping('ping-AB-0007')$$), 'ok', 'either person can withdraw a waiting Ping');
select is(tests.err($$select public.remove_ping('ping-AB-0007')$$), 'ok', 'withdrawing it again is a no-op');

-- finalize
select tests.act_as('AliceFbUid0000000000000000a1');
select is(public.finalize_ping('ping-AB-0001'), 'processed', 'the asker finishes it');
select is(public.finalize_ping('ping-AB-0001'), 'already', 'a second finalize is recognised as done');
select is(public.lease_ping('ping-AB-0001', 'deviceAlice0003'), false, 'a processed Ping cannot be leased again');
select tests.act_as('BobFbUid000000000000000000b2');
select is(tests.err(format($$select public.answer_ping('ping-AB-0001', %L::jsonb)$$, tests.answered(tests.items(2), 'no'))), '55000', 'a processed Ping cannot be changed by an answer');
select tests.back();
select is((select status || ':' || (processed_at = now())::text from pings where id = 'ping-AB-0001'), 'processed:true', 'processed_at is the server clock');
select tests.act_as('AliceFbUid0000000000000000a1');
select is(tests.err($$select public.remove_ping('ping-AB-0001')$$), 'ok', 'a processed Ping can be cleared');

-- ==================================================================================================================
-- PUSH TOKENS
-- ==================================================================================================================
select tests.act_as('AliceFbUid0000000000000000a1');
select lives_ok($$select public.save_push_token('fcm-token-legacy')$$, 'owner saves a token (default device legacy)');
select lives_ok($$select public.save_push_token('fcm-token-phone', 'devicePhone01')$$, 'owner saves a second device');
select lives_ok($$select public.save_push_token('fcm-token-phone-2', 'devicePhone01')$$, 'saving the same device again replaces its token');
select is((select count(*)::int from push_tokens), 2, 'owner reads their own tokens');
select is(tests.err($$select public.save_push_token('')$$), '22023', 'an empty token is refused');
select is(tests.err($$select public.save_push_token(repeat('t', 4096))$$), '22023', 'a token of 4096 is refused');
select is(tests.err($$insert into push_tokens (uid, device_id, token) values ('AliceFbUid0000000000000000a1', 'devX', 't')$$), '42501', 'direct INSERT denied');
select tests.act_as('BobFbUid000000000000000000b2');
select is((select count(*)::int from push_tokens), 0, 'another user reads none of them (no token directory)');
select lives_ok($$select public.delete_push_token()$$, 'another user deleting "all" removes only their own');
select tests.back();
select is((select count(*)::int from push_tokens where uid = 'AliceFbUid0000000000000000a1'), 2, 'the owner''s tokens are intact');
insert into push_tokens (uid, device_id, token) select 'EveFbUid0000000000000000000e6', 'dev' || g, 't' from generate_series(1, 20) g;
select tests.act_as('EveFbUid0000000000000000000e6');
select is(tests.err($$select public.save_push_token('t', 'deviceOverflow')$$), '54000', 'an account cannot register more than 20 devices');
select is(tests.err($$select public.save_push_token('t2', 'dev1')$$), 'ok', 'but an existing device can still refresh its token');

-- ==================================================================================================================
-- MIGRATION / SERVER-ONLY TABLES: the browser roles have no access at all
-- ==================================================================================================================
select tests.act_as('AliceFbUid0000000000000000a1');
select is(tests.err('select 1 from public.legacy_requests'), '42501', 'authenticated cannot read legacy_requests');
select is(tests.err($$insert into public.legacy_requests (id, raw) values ('x', '{}')$$), '42501', 'authenticated cannot write legacy_requests');
select is(tests.err('select 1 from public.connection_aliases'), '42501', 'authenticated cannot read connection_aliases');
select is(tests.err($$insert into public.connection_aliases (legacy_id, canonical_id, reason) values ('x', 'y', 'D-1')$$), '42501', 'authenticated cannot write connection_aliases');
select is(tests.err('select 1 from public.quarantined_records'), '42501', 'authenticated cannot read quarantined_records');
select is(tests.err($$insert into public.quarantined_records (collection, doc_id, raw, reasons, exported_at) values ('pings','x','{}','{a}',now())$$), '42501', 'authenticated cannot write quarantined_records');
select is(tests.err('select 1 from public.shadow_mismatch'), '42501', 'authenticated cannot read shadow_mismatch');
select is(tests.err($$insert into public.shadow_mismatch (domain, key) values ('d','k')$$), '42501', 'authenticated cannot write shadow_mismatch');
select is(tests.err('delete from public.quarantined_records'), '42501', 'authenticated cannot delete quarantined_records');
select tests.act_anon();
select is(tests.err('select 1 from public.legacy_requests'), '42501', 'anon cannot read legacy_requests');
select is(tests.err($$insert into public.shadow_mismatch (domain, key) values ('d','k')$$), '42501', 'anon cannot write shadow_mismatch');
select is(tests.err('select 1 from public.connections'), '42501', 'anon cannot read connections');
select is(tests.err('select 1 from public.syncs'), '42501', 'anon cannot read syncs');
select is(tests.err('select 1 from public.push_tokens'), '42501', 'anon cannot read push_tokens');

select * from finish();
rollback;
