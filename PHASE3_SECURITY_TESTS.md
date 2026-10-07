# PHASE3_SECURITY_TESTS.md

Record of the Phase 3 local security validation. Local Docker database only. No `supabase link`, no `--linked`, no `db push`, no Firebase access.

## Migrations added

```
supabase/migrations/20261007130100_security_identity_rls.sql      identity helper, RLS on 10 tables, 4 read policies, SELECT grants
supabase/migrations/20261007130200_security_profile_invite_rpc.sql upsert_profile, get_profile_name, create_invite, get_invite, delete_invite
supabase/migrations/20261007130300_security_connection_rpc.sql     send_request, respond_request, remove_request
supabase/migrations/20261007130400_security_ping_rpc.sql           create_ping, answer_ping, lease_ping, finalize_ping, remove_ping (+3 private helpers)
supabase/migrations/20261007130500_security_sync_push_rpc.sql      sync_put, save_push_token, delete_push_token
```

## Commands and results

| Command | Result |
|---|---|
| `npx supabase db reset` | all 10 migrations applied from an empty local database, no error |
| `npx supabase test db` | **228 of 228 pass** in 2 files: `legacy_representability.test.sql` 39, `security.test.sql` 189 |
| `bash supabase/tests/concurrency.sh` | **9 of 9 pass** (two real concurrent sessions, see below) |
| `npx supabase db lint` | "No schema errors found" (schemas `app_private`, `extensions`, `public`) |
| `npm test` | 16 files, 232 tests pass |
| `npm run typecheck` | clean |

Direct catalog inspection after the reset: RLS enabled on 10 of 10 tables (none forced, so the definer functions and the service role still work); 4 policies, all SELECT to `authenticated`; `authenticated` holds SELECT on exactly connections, pings, push_tokens, syncs and nothing else; `anon` holds nothing; 16 public functions, all `SECURITY DEFINER`, all `search_path=""`, `authenticated` yes, `anon` no, PUBLIC none.

## What the 189 security assertions cover

| Area | Assertions (negative ones in bold) |
|---|---|
| Catalog | RLS on 10 tables; **no write grants**; anon holds none; exact SELECT list; service_role keeps access; 16 functions, all definer, pinned path, **none to anon or PUBLIC**; private helpers not executable by `authenticated` except `current_uid` |
| Identity | identity is the JWT sub; Firebase uid handled as text; **no write function takes a uid parameter**; **token with only email/name has no identity and is refused by every write function and sees nothing**; **claiming another user's name shows only the caller's rows and writes only the caller's row**; **anon refused** |
| Sync | owner create/update/read; byte-identical read-back; **stale rev, create-over-existing, oversize, direct INSERT/UPDATE/DELETE, non-owner read and update all refused**; owner row unchanged |
| Profiles | own write; **empty/long name; empty uid; no directory; direct writes**; one user cannot change another |
| Invites | server-clock expiry; **bad token, zero and absurd lifetime, listing, takeover, forged owner, non-owner delete, token overwrite refused**; legacy invite readable |
| Connections | participant reads; **unrelated user reads none; forged direct INSERT/UPDATE/DELETE; self request; duplicate pair both directions; long name; sender self-accept; stranger respond and delete; invalid status; double respond**; alias removal leaves the archive |
| Pings | create/idempotent retry/**id conflict**; **self, wrong receiver, forged connection (different pair, nonexistent), non-member asker, 9 items, 0 items, answered at birth, extra field, long name, non-string subject, bad date (old, far, impossible, wrong format), bad id, direct forged INSERT**; participant/stranger reads; server `created_at`; **asker/stranger answer, invalid answer, wrong count, changed name/subject/key/time/extra field, direct UPDATE, double answer, expired, ended connection**; boundary just inside life answers; legacy 12-class and no-`created_at` cannot be answered, answered legacy can be leased and finalized; **lease by non-asker/stranger, unanswered, bad device**; lease holder, second device, renewal, takeover after expiry; **client cannot backdate a lease**; **remove while answered, stranger remove, direct DELETE**; finalize, repeat, lease after processed, answer after processed, `processed_at` is server time |
| Push tokens | owner save/replace/list; **empty and oversize token, direct INSERT, other user sees none, other user's delete-all removes only their own, 21st device refused**; existing device can refresh |
| Migration tables | **authenticated and anon cannot read or write legacy_requests, connection_aliases, quarantined_records, shadow_mismatch; cannot read connections, syncs, push_tokens as anon** |

## Concurrency (`supabase/tests/concurrency.sh`)
pgTAP runs one transaction, so races are tested with real concurrent `psql` sessions against the local container, one holding a row lock with `pg_sleep`:

1. two identical `create_ping` calls at once: exactly one row, both callers succeed
2. two devices racing for the lease: exactly one wins, one is refused
3. two `finalize_ping` calls at once: one `processed`, one `already`
4. two `sync_put` with the same expected revision: one wins, one gets `revision conflict` (40001), final rev 2

The script creates and removes its own fixtures. It uses only the local container.

## Defects the suite caught while being written (all fixed before commit)
- Postgres grants `EXECUTE` to PUBLIC on every new function. `app_private.current_uid()`, `require_uid()` and the three Ping helpers were therefore executable by PUBLIC. The first design relied on a schema-scoped `ALTER DEFAULT PRIVILEGES ... FROM public`, which does **not** remove that implicit grant. Fixed with explicit `REVOKE ... FROM public` on each helper. (The 16 public functions were already revoked explicitly.)
- The Phase 2B assertion "anon and authenticated hold no grants" became outdated and was narrowed to "no write grants".
- `db lint` flagged an unused variable in `valid_answer`; removed.

## Assumptions about the future Firebase JWT (not tested, not claimed)
1. `sub` equals the Firebase uid exactly. Supabase's own `auth.uid()` is expected to fail on it and is not used anywhere.
2. The token carries `role = "authenticated"`. Otherwise PostgREST assigns `anon`, which has no grant here, so every call fails closed.
3. `request.jwt.claims` is how `auth.jwt()` is populated; the tests set it directly.
4. Realtime with RLS on a text uid, and behaviour across the hourly token refresh, are unproven (spike S8, S9).

## Unresolved issues
- **Phase 5 bridge is unproven.** Everything above holds only if the identity assumption does.
- **Anonymous accounts and syncs:** Firestore rules never restricted `syncs` to non-anonymous accounts (the client does). Neither does this schema. Whether to enforce it needs the real claim shape (`firebase.sign_in_provider`).
- **No rate limiting:** `get_profile_name` is an exact lookup (no directory), but a signed-in user can probe uids at will, as with Firestore `get`. The uid being a capability (shared by QR/link) is the existing model.
- **`now()` is the transaction start time**, so two statements in one transaction share a timestamp. Each RPC is its own transaction, so this matches the old per-request server time.
- **Realtime publication** (which tables, filters, RLS interaction) is not configured here.
- **The Phase 2B test file previously asserted** no grants for `authenticated`; it was updated, not weakened beyond the intended Phase 3 change (write grants are still asserted to be zero, in both files).
- The `vector` analytics container still crash-loops locally; unrelated and not touched.
- Decisions 2a and 2b stay PROVISIONAL (production census: 0 requests, 0 pings).
- The first run of `supabase test db` pulls a public `pg_prove` image from `public.ecr.aws`; no project is contacted.
