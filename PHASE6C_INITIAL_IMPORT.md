# PHASE6C_INITIAL_IMPORT.md

Phase 6C is **operational tooling only**: a safe, repeatable, idempotent pipeline for the initial copy of Firebase data into a **non-authoritative** Supabase project. It was built and tested against local systems only. **The real production import has not been run.**

```
STATE AT THE END OF PHASE 6C
  Firebase                  authoritative; read only by this tooling; never written, modified or deleted
  Supabase (production)     not touched; no schema check, no import, no write has been run against it
  Application               unchanged; NEXT_PUBLIC_BACKEND unset (Firebase)
  Flags                     NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE and all three SHADOW flags are OFF
  Production shadow traffic none
  Production credentials    none added, none committed, none printed
```

## 1. Architecture (scripts/, plain Node, no new dependency)

| Stage | File | Network | Notes |
|---|---|---|---|
| A. Export | `scripts/migration/export.mjs` | Firestore, **GET only** | streams the six collections to NDJSON; writes `manifest.json` |
| B. Transform | `scripts/migration/transform.mjs` | none (pure) | Firestore records -> rows for the Phase 2B tables |
| C. Validate | `scripts/migration/validate.mjs` | none (pure) | conservation, no invented ids, byte-exact syncs, referential diagnostics |
| D. Import | `scripts/migration/supabase-import.mjs` | Supabase PostgREST | idempotent upserts; no DELETE, no SQL |
| E. Verify / report | `supabase-import.mjs` (`runVerify`), `report.mjs`, `io.mjs` | Supabase (read) | PASS / FAIL / EXPLAINED-REJECT; human report + JSON summary |
| CLI | `scripts/migration-import.mjs` | | `npm run migration:import -- <mode>` |
| Local end-to-end test | `scripts/migration-import-selftest.mjs` | local only | Firestore emulator -> local Supabase |

Nothing in `app/`, `components/`, `hooks/` or `lib/` imports any of it (a test asserts this).

Collections: `users` -> `profiles`; `invites` -> `invites`; `requests` -> `connections` (+ `legacy_requests`, `connection_aliases`); `pings` -> `pings`; `pushTokens` -> `push_tokens`; `syncs` -> `syncs`; rejects -> `quarantined_records`.

## 2. Commands

```
# 1. DRY RUN (needs a READ-ONLY Firebase key; never contacts Supabase)
npm run migration:import -- --dry-run --project attendance-tracker-2k26
#    or offline, from an earlier export:   --dry-run --from migration-output/<dir>

# 2. SCHEMA CHECK (read-only; the target must hold exactly the intended schema)
npm run migration:import -- --check-schema --confirm-project-ref <supabase-project-ref>

# 3. THE REAL IMPORT (writes to Supabase; NOT run in Phase 6C)
npm run migration:import -- --import --from migration-output/<dir> --confirm-project-ref <supabase-project-ref> --yes-supabase-is-a-copy

# 4. VERIFY (read-only)
npm run migration:import -- --verify --from migration-output/<dir> --confirm-project-ref <supabase-project-ref>

# local end-to-end test (Firestore emulator + LOCAL Supabase only)
SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=<local key from `npx supabase status -o env`> npm run migration:import:selftest
```

Choosing no mode, or two, does nothing (exit 2). `--import` and `--verify` refuse to run without an export directory, so what is imported is exactly what a dry run validated; the export is re-checked against its manifest digests on every load. `--import` also needs the project ref typed out (it must equal the target URL's ref) and the explicit acknowledgement flag, validation must pass, and the schema must match, all **before the first write**.

## 3. Environment variables (never in source, never printed, never committed)

| Variable | Used by | Purpose |
|---|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | export only | path to a **read-only** Firebase service-account key (role: Cloud Datastore Viewer). Refused if its project differs from `--project` |
| `SUPABASE_URL` | import, verify, schema check | the target project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | import, verify, schema check | the target's service-role key, **only** for these steps |
| `FIRESTORE_EMULATOR_HOST` | tests | only with a `demo-*` project id |

Every message the tooling prints passes through a redactor that removes the service key, JWTs, Supabase keys and private-key blocks (tested, including a server that echoes the key back). `.gitignore` now covers `/migration-output/`, `*.ndjson`, `*service-account*.json` and `*-firebase-adminsdk-*.json`. **Exports contain real user data (uids, sync blobs, push tokens): keep `migration-output/` private and delete it when finished.**

## 4. Dry-run behaviour

Exports (or loads) -> transforms -> validates -> writes, into the export directory: `report.md` (human), `summary.json` (machine), `rejects.ndjson` (every quarantined record with reasons and its complete original). It issues no request to Supabase at all. Exit code is 0 only if validation passed. The report shows counts, conservation per collection, rejects by reason, legacy Ping flags, duplicate pairs, quarantined answered Pings, referential diagnostics and the sync byte-preservation result. It contains no names, tokens, sync data or full uids (accounts appear as `abcd***`).

## 5. Validation (blocks the import on any error)

- the export equals its manifest (counts, per-collection digests); no repeated source id;
- **conservation, per collection: `source = accepted + archived + rejected`**, and every source record is placed **exactly once**;
- **no generated id**: every output key is a source id;
- no duplicate primary key; every alias resolves to an archived request and an imported canonical connection; at most one active row per friend pair;
- **syncs**: the row's text, revision and SHA-256 equal the source's;
- NUL characters (which PostgreSQL text/jsonb cannot hold) are an error, never silently altered.
Warnings (read them): quarantined answered Pings (**LOUD**), legacy Pings, duplicate pairs, cleared leases, accounts without a profile, Pings whose request is not in the export.

## 6. Transformation and legacy handling (MIGRATION_DECISIONS.md rules, implemented)

- **Ids are preserved**; the tooling never creates one.
- **profiles**: uid and name copied; a name the table CHECK would refuse (empty, over 40) is quarantined, not edited.
- **invites**: token, owner, expiry copied as stored; an already-expired invite is imported, not dropped; no expiry -> quarantined (expires_at is NOT NULL; no value is invented).
- **requests (decision 2a)**: pairs with at most one live (pending/accepted) record, plus any declined ones, import as they are. Pairs with two or more live records: canonical = accepted first, then earliest `createdAt` (missing last), then smallest id; every other record is stored whole in `legacy_requests` with an alias `D-1` (same direction, both pending), `D-2` (opposite directions), `D-3` (pending superseded by accepted) or `D-4` (two accepted). `D-5`/`D-6` are never produced (declined rows do not make a duplicate; carry-over duplicates look like D-1). Nothing is merged or deleted.
- **pings (decision 2b)**: imported verbatim into the same table. Flags (`legacy = true`, `legacy_flags`): `items>8`, `item-shape`, `date-format`, `no-created-at`, `request-missing`, `name-length`. `class_date` stays text, `items` stays exactly as exported, `request_id` has no foreign key. **Quarantined (never live)** only for: participants not exactly `[from, to]` or from = to, an invalid status, `createdAt` after the export finished, an invalid answer on an answered/processed item; plus three schema-forced reasons (id pattern, non-array items, non-string date). An answered Ping's short lease (`claimed_by/at`) is cleared (plan section 14.8); status, answers and `responded_at` are kept so it stays finalizable.
- **push tokens**: one row per account, `device_id = 'legacy'`; accounts are never merged, even with an identical token string; a token outside 1..4095 characters is quarantined. Token values are never printed.
- **syncs**: see section 7.

## 7. Sync byte preservation

`data` is the exact string Firestore returned: never decompressed, parsed, recompressed, trimmed, normalized or re-encoded (tests cover whitespace, trailing newlines, CRLF, quotes, backslashes, non-ASCII, line separators, emoji and a `gz1:` prefix). `rev` is copied exactly. `updated_at` is the client millisecond number as stored. The SHA-256 of the UTF-8 bytes is computed on the source and the transformed row (and again on the target during verification); any difference is an error.

## 8. Idempotency

Every table is upserted on its primary key from deterministic rows (`on_conflict`), so repeating the import changes nothing (tested against an in-memory PostgREST and against local Supabase: the table dumps are identical before and after a second run). Quarantine rows are inserted once and never changed. **Sync documents never move backwards**: a missing row is inserted; a lower target revision is updated with a guarded `PATCH ... rev=lt.N`; an equal revision is left alone; a target that is **ahead** is left alone and reported. The importer has no DELETE, runs no SQL, and can only reach the migration tables.

## 9. Verification

`--verify` reads the target (service role) and compares it with the export: per table the row count, the key set and every field; for syncs the uid set, exact `rev` and exact SHA-256 (and byte equality) of `data`. Statuses: **PASS**, **FAIL**, **EXPLAINED-REJECT** (a source record that was rejected and is recorded in `quarantined_records` with its reasons). Extra rows in the target that are not from this export are a FAIL (investigate before relying on the copy).

## 10. Production schema check (part 7): NOT YET DONE

No production credentials exist in this repository or session, so the production Supabase schema was **not** inspected. The tooling's `--check-schema` compares the target's API description with the intended ten tables and the columns the import needs, and stops on any difference or any unexpected exposed relation. The owner should also run, from this repository on the migration branch:

```
npx supabase link --project-ref <production-ref>        # prompts for the database password; never commit it
npx supabase migration list --linked                    # all 10 migrations must show as applied remotely and match local
npx supabase db push --dry-run --linked                 # review what WOULD be applied; do not apply anything unreviewed
# only if the dry run lists exactly the 10 already-reviewed migrations and nothing else:
npx supabase db push --linked
```
If anything differs from the ten reviewed migrations, **stop** and report it. Remember to remove the link afterwards (`supabase/.temp/project-ref`); a repository test requires that no remote link is left behind.

## 11. Fresh Firebase census (part 8): NOT YET DONE

`MIGRATION_PRODUCTION_CENSUS.md` (2026-10-07: 0 requests, 0 pings, 1 profile) is only a baseline. The dry run **is** the fresh census: its manifest records the export time, per-collection counts and digests, and the report lists duplicates and legacy findings. Run it immediately before the import and compare it with the baseline; treat any difference as news, not as an error. It has not been run because no read-only production credential was available to this session.

## 12. Exact manual steps for the owner (in order)

1. In the Firebase console (project `attendance-tracker-2k26`), create a service account with **only** the *Cloud Datastore Viewer* role and download its key to a folder **outside the repository**. Set `GOOGLE_APPLICATION_CREDENTIALS` to that path in your shell only.
2. Confirm the production Supabase project (URL and ref) exists on the Free plan and is a copy-only target. Make a note of its project ref.
3. Run the schema commands in section 10. Stop on any mismatch.
4. Run the dry run (section 2). Read `report.md` and `summary.json`: validation must pass; read every warning, especially any **LOUD** one.
5. Take the pre-import safety copies named in `MIGRATION_PLAN.md` (a Firebase export for the owner's own archive; the local `migration-output/` folder is itself a full copy).
6. Set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` in your shell only, then run `--check-schema`, then `--import` (section 2), then `--verify`. All three must pass.
7. Run `--import` a second time and `--verify` again to see that nothing changes.
8. Delete the service-account key and `migration-output/` when finished; rotate the service-role key if it was ever pasted anywhere.
Nothing in this list enables a flag. The shadow flags stay off until a later, separately approved step.

## 13. Rollback

The import only ever adds or updates rows in the Supabase copy and never touches Firebase, so rolling back means ignoring or emptying the copy: truncate the migration tables on Supabase (a manual SQL step, deliberately not offered by the tool) and re-import later. Firebase is untouched and authoritative throughout.

## 14. What was tested

- `tests/migration-import.test.ts` (46 tests): profile and invite transformation; duplicate requests (every alias reason, the canonical order, declined rows); legacy Pings over 8 items, old date formats, answered-but-unprocessed, quarantine of forged Pings, missing request references, item/name flags; multiple push tokens; byte-perfect syncs and SHA-256 equality, with mutation checks; idempotent transformation; reject reporting; conservation and the loud failure when a record vanishes; no invented ids; secret redaction (key, JWT, private key, server echo, report and summary contents); the exporter (GET only, pagination, ordering, digests, tamper detection, wrong-project refusal); the importer (schema check, idempotency, behind/ahead copies, verification failures, legacy rows, no DELETE); the CLI (mode and confirmation refusals before any network call, offline dry run); isolation from the application and from secrets.
- `npm run migration:import:selftest`: Firestore emulator seeded with duplicate requests, a 12-item Ping, an old-format Ping, an answered Ping, a forged Ping, a shared push token and byte-awkward sync blobs -> exported read-only -> imported into **local** Supabase -> verified -> imported again (no change) -> verified; a copy that is ahead is left alone.
- Not tested, by design: any production system.
