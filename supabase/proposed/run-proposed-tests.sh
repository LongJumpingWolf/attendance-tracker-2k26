#!/usr/bin/env bash
# Phase 6D: applies the PROPOSED issuer/audience guard to the LOCAL database inside one transaction, runs its pgTAP tests,
# and ROLLS EVERYTHING BACK. Nothing is committed and nothing remote is touched (it talks only to the local Supabase container).
# Usage: bash supabase/proposed/run-proposed-tests.sh        (needs `npx supabase start` to be running)
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
C=${DB_CONTAINER:-supabase_db_Attendance_tracker}
case "$C" in supabase_db_*) ;; *) echo "refusing: DB_CONTAINER must be a local supabase_db_* container"; exit 2;; esac
OUT=$( { echo "begin;"; cat "$HERE/20261009000100_firebase_issuer_audience_guard.sql"; cat "$HERE/firebase_issuer_audience_guard.test.sql"; echo "rollback;"; } \
  | docker exec -i "$C" psql -U postgres -X -q -v ON_ERROR_STOP=1 -tA 2>&1 )
RC=$?
echo "$OUT"
if [ $RC -ne 0 ] || echo "$OUT" | grep -q "^not ok" || ! echo "$OUT" | grep -q "^ok"; then echo "PROPOSED TESTS: FAIL"; exit 1; fi
echo "PROPOSED TESTS: PASS ($(echo "$OUT" | grep -c '^ok') ok, 0 not ok, rolled back)"
