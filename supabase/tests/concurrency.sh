#!/usr/bin/env bash
# Phase 3: real two-session race tests against the LOCAL database (pgTAP cannot run concurrent transactions).
# Uses the local Supabase Postgres container only. Creates its own fixtures and removes them. Exit 1 on any failure.
set -u
T=$(mktemp -d)
C=${DB_CONTAINER:-supabase_db_Attendance_tracker}
psql_() { docker exec -i "$C" psql -U postgres -X -q -v ON_ERROR_STOP=1 -tA "$@"; }
as() { # as <uid> <sql> : run one statement as an authenticated caller with that JWT sub
  psql_ -c "begin; select set_config('request.jwt.claims', json_build_object('sub','$1','role','authenticated')::text, true); set local role authenticated; $2; commit;" 2>&1
}
fail=0; check() { if [ "$2" = "$3" ]; then echo "PASS $1"; else echo "FAIL $1 (got '$2', want '$3')"; fail=1; fi; }
A=RaceAliceUid00000000000000a1; B=RaceBobUid0000000000000000b2
cleanup() { psql_ -c "delete from public.pings where from_uid='$A'; delete from public.connections where id='race-conn-AB'; delete from public.syncs where uid='$A';" >/dev/null; }
cleanup
psql_ -c "insert into public.connections (id,from_uid,to_uid,status,created_at) values ('race-conn-AB','$A','$B','accepted',now());" >/dev/null
TODAY=$(psql_ -c "select to_char((now() at time zone 'UTC')::date,'YYYY-MM-DD')")
ITEMS='[{"key":"k@09:00","subjectId":"s1","name":"Maths","t":"09:00","answer":null}]'
CALL="select public.create_ping('race-ping-0001','$B','Alice','Bob','race-conn-AB','$TODAY','$ITEMS'::jsonb)"

# 1. double tap: two identical creates at once -> exactly one Ping, both calls succeed
as $A "$CALL" > $T/r1.out & as $A "$CALL" > $T/r2.out & wait
check "double create leaves exactly one Ping" "$(psql_ -c "select count(*) from public.pings where id='race-ping-0001'")" 1
check "double create: both callers succeed (created/existing)" "$(cat $T/r1.out $T/r2.out | grep -cE '^(created|existing)$')" 2

# 2. lease race: ask Bob's answer first, then two devices race for the lease while one holds the row lock for 2s
psql_ -c "update public.pings set status='answered', items='[{\"key\":\"k@09:00\",\"subjectId\":\"s1\",\"name\":\"Maths\",\"t\":\"09:00\",\"answer\":\"yes\"}]', responded_at=now() where id='race-ping-0001'" >/dev/null
as $A "select public.lease_ping('race-ping-0001','deviceRace0001'), pg_sleep(2)" > $T/l1.out &
sleep 0.5
as $A "select public.lease_ping('race-ping-0001','deviceRace0002')" > $T/l2.out &
wait
check "lease race: exactly one device wins" "$(cat $T/l1.out $T/l2.out | grep -c '^t')" 1
check "lease race: exactly one device is refused" "$(cat $T/l1.out $T/l2.out | grep -c '^f')" 1

# 3. finalize race: two finalizes at once -> one 'processed', one 'already'
as $A "select public.finalize_ping('race-ping-0001'), pg_sleep(1)" > $T/f1.out &
sleep 0.3
as $A "select public.finalize_ping('race-ping-0001')" > $T/f2.out &
wait
check "finalize race: one processed" "$(cat $T/f1.out $T/f2.out | grep -c '^processed')" 1
check "finalize race: one already" "$(cat $T/f1.out $T/f2.out | grep -c '^already')" 1

# 4. sync compare-and-set: two writers with the same expected rev -> one wins, one gets 40001
as $A "select public.sync_put(0,'base',1)" >/dev/null
as $A "select public.sync_put(1,'writer-1',2), pg_sleep(1.5)" > $T/s1.out &
sleep 0.3
as $A "select public.sync_put(1,'writer-2',3)" > $T/s2.out &
wait
check "sync CAS: exactly one writer wins" "$(cat $T/s1.out $T/s2.out | grep -cE '^2')" 1
check "sync CAS: the loser is refused with 40001" "$(cat $T/s1.out $T/s2.out | grep -c 'revision conflict')" 1
check "sync CAS: final rev is 2" "$(psql_ -c "select rev from public.syncs where uid='$A'")" 2

cleanup
[ $fail = 0 ] && echo "ALL CONCURRENCY CHECKS PASSED" || echo "CONCURRENCY CHECKS FAILED"
exit $fail
