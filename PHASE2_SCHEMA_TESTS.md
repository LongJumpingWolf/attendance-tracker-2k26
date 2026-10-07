# PHASE2_SCHEMA_TESTS.md

Record of the Phase 2B local schema validation. Everything ran against the **local Docker database only**. No `supabase link`, no `--linked`, no `db push`.

## Migrations created

```
supabase/migrations/20261007120100_social_core.sql
supabase/migrations/20261007120200_pings.sql
supabase/migrations/20261007120300_push_tokens_syncs.sql
supabase/migrations/20261007120400_quarantine_and_migration.sql
supabase/migrations/20261007120500_revoke_api_grants.sql
supabase/tests/database/legacy_representability.test.sql      (pgTAP, 39 assertions)
```

## Commands run

```
npx supabase db reset          # local: drops and recreates the local database, applies all migrations
npx supabase test db           # local: runs supabase/tests/database/*.test.sql with pgTAP, rolled back
npx supabase db lint           # local
docker exec supabase_db_Attendance_tracker psql ...   # read-only inspection of the local schema
npm test ; npm run typecheck
```

## Results

| Check | Result |
|---|---|
| `db reset` from an empty local database | all 5 migrations applied in order, no error. "no files matched pattern: supabase/seed.sql" is expected (no seed) |
| Tables in `public` | exactly 10: connection_aliases, connections, invites, legacy_requests, pings, profiles, push_tokens, quarantined_records, shadow_mismatch, syncs (asserted by a test) |
| Foreign keys | exactly one: `connection_aliases.legacy_id -> legacy_requests.id`. **None on pings** (asserted) |
| RLS enabled tables / triggers | 0 / 0 (RLS and triggers are out of scope) |
| Indexes | 19 (10 primary keys, 1 unique `quarantined_records(collection,doc_id)`, 1 unique partial `connections_active_pair_uq`, 7 plain lookup indexes) |
| `db lint` | "No schema errors found" (schemas `extensions` and `public`) |
| Rows left after the tests | 0 (the test transaction rolls back) |
| `anon` / `authenticated` grants on application tables | 0 (asserted) |

## Legacy representability (`supabase test db`: 39 of 39 pass)

| Case | Proved by |
|---|---|
| A. normal current connection | accepted row inserts |
| (new duplicates) | a new A to B and a new B to A while an accepted pair exists are both rejected (`23505`); a declined row may coexist |
| B. historical duplicate friend pair | second accepted document kept verbatim in `legacy_requests` with alias reason `D-4`; raw status and canonical id read back |
| C. historical request with a deleted counterpart | alias whose `canonical_id` matches no connection is accepted |
| (legacy connection) | null names, null `created_at` and `responded_at` preserved (explicit NULL beats the default) |
| D. normal current Ping | inserts; gets a database timestamp by default |
| E. legacy Ping with more than 8 items | 12 items stored and counted |
| F. legacy Ping with an odd date | `9/5/2026 (Sat)`, empty items and null `created_at` stored verbatim |
| G. answered-but-unprocessed Ping | answers, `responded_at` kept, `processed_at` null |
| H. Ping whose request no longer exists | `request_id` matching nothing is accepted |
| I. normal push token | inserts |
| J. several tokens for one uid | 3 rows for one uid (`legacy` plus two devices) |
| K. sync blob byte-for-byte | leading and trailing spaces, CRLF, tab, base64 `+/=`, accented, CJK and emoji text read back identical; SHA-256 of the stored bytes equals the source; a known vector (`abc`) matches the published hash |
| quarantine | original payload stored; the same `(collection, doc_id)` twice is rejected |
| structural guards that must still hold | `items` must be an array; a Ping to oneself is rejected; `legacy_flags` on a non-legacy Ping is rejected |

These tests prove **representability only**. They say nothing about who may read or write (Phase 3).

## Judgement calls to confirm

1. **`from_uid <> to_uid` is a CHECK on `pings` but not on `connections`.** Every Ping rule generation forbade it. For requests the older rule history was not examined and decision 2a forbids CHECKs old rows may violate, so it is left to the create RPC.
2. **`connection_aliases.canonical_id` has no foreign key**, so alias traces survive a removed connection and a legacy Ping can still be traced. The cost is that dangling ids are caught by migration validation, not the database.
3. **`participants` is dropped** from `pings` and `connections` (derived, per plan). The import must still check `participants == [from, to]` as a quarantine criterion before dropping it.
4. **`shadow_mismatch` is created now** because plan section 12.2 lists it. It is migration-only and isolated in its own migration file so it can be dropped cleanly.
5. **Grants were revoked from `anon` and `authenticated`.** Supabase grants new `public` tables to them by default, which would expose the tables through the Data API with no policy in place. This is a grant change, not RLS.
6. **`syncs.data` has no size CHECK.** The old rule was `size() < 900000`; that, and the compare-and-set on `rev`, belong to the later `sync_put` RPC.
7. **`pings.class_date`, `pings.items` and `connections` names stay unvalidated** by design; the strict limits (8 items, name lengths, date window) belong to the Phase 9 create and answer RPCs.

## Unresolved issues

- The `vector` analytics container still crash-loops locally. Not diagnosed, as instructed. It does not affect the database, and `db reset`, `test db` and `db lint` all succeeded.
- The decisions 2a and 2b remain PROVISIONAL (production had 0 requests and 0 pings at the 2026-10-07 census). The legacy tables are built, small and expected to stay empty.
- Real Firebase tokens, Realtime and RLS behaviour are untested (decision 1 spike, Phases 3 and 5).
- Line endings: git warns that LF will become CRLF for new files on this Windows checkout. Harmless for SQL.
