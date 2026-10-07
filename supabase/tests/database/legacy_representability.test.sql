-- Phase 2B: the schema can REPRESENT every legacy and current shape the decision lock requires.
-- Representability only: no authorization is tested (Phase 3). Runs against the LOCAL database only:
--   npx supabase test db
-- pgTAP wraps the file in a transaction that is rolled back, so nothing persists.

begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;

select plan(39);

-- Inventory: exactly the intended application tables exist (no surprises)
select is(
  (select array_agg(table_name::text order by table_name) from information_schema.tables
    where table_schema = 'public' and table_type = 'BASE TABLE'),
  array['connection_aliases','connections','invites','legacy_requests','pings','profiles','push_tokens',
        'quarantined_records','shadow_mismatch','syncs'],
  'public schema holds exactly the ten intended tables');

-- Firebase uids are text, not uuid
select col_type_is('public', 'profiles',    'uid',      'text', 'profiles.uid is text');
select col_type_is('public', 'connections', 'from_uid', 'text', 'connections.from_uid is text');
select col_type_is('public', 'pings',       'to_uid',   'text', 'pings.to_uid is text');
select col_type_is('public', 'syncs',       'uid',      'text', 'syncs.uid is text');

-- No foreign key from pings to anything (decision 2b)
select is((select count(*)::int from pg_constraint where conrelid = 'public.pings'::regclass and contype = 'f'), 0,
  'pings has no foreign keys');

-- A. normal current connection
select lives_ok($$
  insert into connections (id, from_uid, to_uid, from_name, to_name, status, created_at, responded_at)
  values ('reqAAAAAAAAAAAAAAAA01', 'uidAliceAliceAliceAlice001', 'uidBobBobBobBobBobBobBob0001', 'Alice', 'Bob',
          'accepted', now(), now())$$, 'A: normal accepted connection');

-- New duplicate active pair, in EITHER direction, is rejected
select throws_ok($$
  insert into connections (id, from_uid, to_uid, status)
  values ('reqNEWDUPSAMEDIR00001', 'uidAliceAliceAliceAlice001', 'uidBobBobBobBobBobBobBob0001', 'pending')$$,
  '23505', null, 'new same-direction duplicate active pair is rejected');
select throws_ok($$
  insert into connections (id, from_uid, to_uid, status)
  values ('reqNEWDUPOPPOSITE0001', 'uidBobBobBobBobBobBobBob0001', 'uidAliceAliceAliceAlice001', 'pending')$$,
  '23505', null, 'new opposite-direction duplicate active pair is rejected');

-- Declined rows may coexist with an active pair
select lives_ok($$
  insert into connections (id, from_uid, to_uid, status)
  values ('reqDECLINED000000001', 'uidBobBobBobBobBobBobBob0001', 'uidAliceAliceAliceAlice001', 'declined')$$,
  'declined row coexists with an accepted pair');

-- B. historical duplicate friend pair: both documents stay traceable, nothing merged or deleted
select lives_ok($$
  insert into legacy_requests (id, raw) values
    ('reqDUPLICATE00000001',
     '{"from":"uidBobBobBobBobBobBobBob0001","to":"uidAliceAliceAliceAlice001","status":"accepted","participants":["uidBobBobBobBobBobBobBob0001","uidAliceAliceAliceAlice001"],"createdAt":{"seconds":1790000000}}'::jsonb);
  insert into connection_aliases (legacy_id, canonical_id, reason, note)
  values ('reqDUPLICATE00000001', 'reqAAAAAAAAAAAAAAAA01', 'D-4', 'second accepted document for one pair')$$,
  'B: historical duplicate pair archived verbatim with alias');
select is((select raw->>'status' from legacy_requests where id = 'reqDUPLICATE00000001'), 'accepted',
  'B: archived duplicate keeps its original status and raw document');
select is((select canonical_id from connection_aliases where legacy_id = 'reqDUPLICATE00000001'), 'reqAAAAAAAAAAAAAAAA01',
  'B: alias resolves to the canonical connection');

-- C. historical request whose counterpart was deleted: alias to an id that no longer exists in connections
select lives_ok($$
  insert into legacy_requests (id, raw) values ('reqORPHAN0000000001', '{"from":"uidGoneGoneGoneGoneGone01","to":"uidAliceAliceAliceAlice001","status":"pending"}'::jsonb);
  insert into connection_aliases (legacy_id, canonical_id, reason)
  values ('reqORPHAN0000000001', 'reqDELETEDCANONICAL01', 'D-1')$$,
  'C: alias to a canonical row that does not exist (deleted counterpart) is representable');

-- A legacy connection with missing names and missing timestamps (nothing forced into fake values)
select lives_ok($$
  insert into connections (id, from_uid, to_uid, from_name, to_name, status, created_at, responded_at)
  values ('reqNOTIMES0000000001', 'uidCarolCarolCarolCarol01', 'uidDaveDaveDaveDaveDave01', null, null, 'pending', null, null)$$,
  'legacy connection with null names and null timestamps');
select is((select created_at from connections where id = 'reqNOTIMES0000000001'), null::timestamptz,
  'explicit NULL created_at is preserved (the default does not override it)');

-- D. normal current Ping
select lives_ok($$
  insert into pings (id, from_uid, to_uid, from_name, to_name, request_id, class_date, items, status)
  values ('pingNormal0001', 'uidAliceAliceAliceAlice001', 'uidBobBobBobBobBobBobBob0001', 'Alice', 'Bob',
          'reqAAAAAAAAAAAAAAAA01', '2026-10-06',
          '[{"key":"math@09:00","subjectId":"s1","name":"Maths","t":"09:00","answer":null}]'::jsonb, 'asking')$$,
  'D: normal current Ping');
select isnt((select created_at from pings where id = 'pingNormal0001'), null::timestamptz,
  'D: new Ping gets a database timestamp by default');

-- E. legacy Ping with more than 8 items (12), stored exactly
select lives_ok($$
  insert into pings (id, from_uid, to_uid, request_id, class_date, items, status, created_at, legacy, legacy_flags)
  values ('pingTwelveItems1', 'uidAliceAliceAliceAlice001', 'uidBobBobBobBobBobBobBob0001', 'reqAAAAAAAAAAAAAAAA01', '2026-09-01',
          (select jsonb_agg(jsonb_build_object('key','k'||g,'subjectId','s'||g,'name','N'||g,'answer',null)) from generate_series(1,12) g),
          'asking', now(), true, array['items>8'])$$,
  'E: legacy Ping with 12 items');
select is((select jsonb_array_length(items) from pings where id = 'pingTwelveItems1'), 12, 'E: all 12 items kept');

-- F. legacy Ping with an odd date representation, stored verbatim
select lives_ok($$
  insert into pings (id, from_uid, to_uid, request_id, class_date, items, status, legacy, legacy_flags, created_at)
  values ('pingOddDate0001', 'uidAliceAliceAliceAlice001', 'uidBobBobBobBobBobBobBob0001', 'reqAAAAAAAAAAAAAAAA01',
          '9/5/2026 (Sat)', '[]'::jsonb, 'asking', true, array['date-format'], null)$$,
  'F: legacy Ping with a non-YYYY-MM-DD date, empty items and null created_at');
select is((select class_date from pings where id = 'pingOddDate0001'), '9/5/2026 (Sat)', 'F: odd date preserved verbatim');

-- G. answered-but-unprocessed Ping keeps its answer, response time and no processed time
select lives_ok($$
  insert into pings (id, from_uid, to_uid, request_id, class_date, items, status, created_at, responded_at, legacy, legacy_flags)
  values ('pingAnswered001', 'uidAliceAliceAliceAlice001', 'uidBobBobBobBobBobBobBob0001', 'reqAAAAAAAAAAAAAAAA01', '2026-09-20',
          '[{"key":"a","subjectId":"s","name":"A","answer":"yes"},{"key":"b","subjectId":"s","name":"B","answer":"no"}]'::jsonb,
          'answered', now() - interval '2 days', now() - interval '1 day', true, array['no-created-at'])$$,
  'G: answered-but-unprocessed Ping');
select is((select processed_at from pings where id = 'pingAnswered001'), null::timestamptz, 'G: processed_at stays null');

-- H. Ping whose old connection/request no longer exists
select lives_ok($$
  insert into pings (id, from_uid, to_uid, request_id, class_date, items, status, legacy, legacy_flags)
  values ('pingNoRequest01', 'uidAliceAliceAliceAlice001', 'uidBobBobBobBobBobBobBob0001', 'reqDoesNotExistAnymore', '2026-09-10',
          '[{"key":"x","subjectId":"s","name":"X","answer":"yes"}]'::jsonb, 'processed', true, array['request-missing'])$$,
  'H: Ping whose request_id matches no connection');

-- Structural guards still hold
select throws_ok($$
  insert into pings (id, from_uid, to_uid, class_date, items, status)
  values ('pingNotArray001', 'uidA', 'uidB', '2026-10-06', '{"not":"a list"}'::jsonb, 'asking')$$,
  '23514', null, 'items must be a JSON array');
select throws_ok($$
  insert into pings (id, from_uid, to_uid, class_date, items, status)
  values ('pingSelf000001', 'uidSame', 'uidSame', '2026-10-06', '[]'::jsonb, 'asking')$$,
  '23514', null, 'a Ping to oneself is rejected');
select throws_ok($$
  insert into pings (id, from_uid, to_uid, class_date, items, status, legacy, legacy_flags)
  values ('pingFlagNoLeg01', 'uidA', 'uidB', '2026-10-06', '[]'::jsonb, 'asking', false, array['items>8'])$$,
  '23514', null, 'legacy_flags on a non-legacy Ping is rejected');

-- I. normal push token  J. multiple tokens for one uid
select lives_ok($$
  insert into push_tokens (uid, device_id, token) values ('uidAliceAliceAliceAlice001', 'legacy', 'fcm-token-1')$$,
  'I: normal push token');
select lives_ok($$
  insert into push_tokens (uid, device_id, token) values
    ('uidAliceAliceAliceAlice001', 'devicePhone0001', 'fcm-token-2'),
    ('uidAliceAliceAliceAlice001', 'deviceLaptop001', 'fcm-token-3')$$,
  'J: several devices for one uid');
select is((select count(*)::int from push_tokens where uid = 'uidAliceAliceAliceAlice001'), 3, 'J: all three registrations kept');

-- K. sync blob byte-for-byte: leading/trailing whitespace, CRLF, tab, base64 punctuation, non-ASCII, padding
select lives_ok($$
  insert into syncs (uid, data, rev, updated_at)
  values ('uidAliceAliceAliceAlice001', ' gz1:H4sIAAAA+/==  '||E'\r\n\t'||'é中😀 ', 7, 1790000123456)$$,
  'K: sync blob stored');
select is((select data from syncs where uid = 'uidAliceAliceAliceAlice001'),
          ' gz1:H4sIAAAA+/==  '||E'\r\n\t'||'é中😀 ', 'K: blob is returned identical (no trim, no padding, no re-encoding)');
select is((select encode(sha256(convert_to(data, 'UTF8')), 'hex') from syncs where uid = 'uidAliceAliceAliceAlice001'),
          encode(sha256(convert_to(' gz1:H4sIAAAA+/==  '||E'\r\n\t'||'é中😀 ', 'UTF8')), 'hex'), 'K: SHA-256 of stored bytes equals the source');
select lives_ok($$insert into syncs (uid, data, rev, updated_at) values ('uidKnownVector000000000000001', 'abc', 1, 1)$$, 'K: known-vector row stored');
select is((select encode(sha256(convert_to(data, 'UTF8')), 'hex') from syncs where uid = 'uidKnownVector000000000000001'),
          'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'K: SHA-256 matches the published value for "abc"');

-- Quarantine keeps the original payload and is idempotent per (collection, doc_id)
select lives_ok($$
  insert into quarantined_records (collection, doc_id, raw, reasons, exported_at)
  values ('pings', 'pingForged00001', '{"status":"weird","participants":["x"]}'::jsonb, array['status-not-in-set'], now())$$,
  'quarantine stores the original document');
select throws_ok($$
  insert into quarantined_records (collection, doc_id, raw, reasons, exported_at)
  values ('pings', 'pingForged00001', '{}'::jsonb, array['again'], now())$$,
  '23505', null, 're-quarantining the same document is rejected (idempotent import)');

-- The Data API roles have no access before Phase 3
select is(
  (select count(*)::int from information_schema.role_table_grants
    where table_schema = 'public' and grantee in ('anon', 'authenticated') and privilege_type <> 'SELECT'), 0,
  'anon and authenticated hold no write grants on application tables (Phase 3 adds SELECT on four; see security.test.sql)');

select * from finish();
rollback;
