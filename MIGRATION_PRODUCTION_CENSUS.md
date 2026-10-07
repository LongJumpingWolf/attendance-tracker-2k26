# MIGRATION_PRODUCTION_CENSUS.md

**READ-ONLY PRODUCTION CENSUS**  
**PROJECT: attendance-tracker-2k26**  
**WRITES/DELETES: 0**

Census time (UTC): `2026-10-07T06:24:32.835Z`. Produced by `scripts/migration-firestore-census.mjs` (GET-only; see the header of that script). Branch `migration/supabase`.

User ids are capabilities in this app (`/?add=<uid>`), so they appear here only as a short one-way hash (`u:xxxxxx`). Full detail is in a private file outside the repository.

## Safety report

| Item | Value |
|---|---|
| Firebase project id | attendance-tracker-2k26 |
| Documents read: requests | 0 |
| Documents read: pings | 0 |
| Documents read: users (profile existence only; names never recorded) | 1 |
| Total documents read | 1 |
| HTTP GET calls | 4 |
| Write operations performed | 0 |
| Delete operations performed | 0 |
| Errors | none |
| Any data modified | NO |

## Census A: friend requests / connections

| Measure | Count |
|---|---|
| Total request documents | 0 |
| Unique unordered user pairs | 0 |
| Pairs with more than one request record (any status) | 0 |
| Pairs with 2+ non-declined records (decision 2a duplicate pair) | 0 |
| Pairs with 2+ accepted records | 0 |
| Opposite-direction pairs (A to B and B to A both exist) | 0 |
| Malformed records (any problem) | 0 |

### Malformed requests

None.

### Requests pointing at an apparently missing user

Detectable only as 'no `users/{uid}` profile'. An anonymous user who never saved a profile also has none, so this is a hint, not proof.

None.

### Duplicate pairs

Provisional canonical rule: accepted first, then earliest `createdAt` (missing last), then smallest id. Nothing was merged or deleted.

**No duplicate pairs found.**

## Census B: pings

| Measure | Count |
|---|---|
| Total pings | 0 |
| Processed | 0 |
| Answered but unprocessed | 0 |
| Asking and past the 3 day expiry | 0 |
| More than 8 items | 0 |

Status distribution

| Status | Count |
|---|---|

Age distribution (by `createdAt`)

| Age | Count |
|---|---|

Item-count distribution

| Items | Count |
|---|---|

### Would be quarantined (the four documented criteria only)

**None.**

### Legacy (breaks a new constraint, valid when written)

**None.**

### Attention flags (conform to the new schema, owner should know)

**None.**

### Informational

None.

## Census C: data conservation

Precedence for a record in more than one category: quarantined, then legacy-compatible, then flagged, then live. Every record is counted exactly once.

| Collection | Exported | Valid/live | Legacy-compatible | Flagged | Quarantined | Sum equals exported | Deleted |
|---|---|---|---|---|---|---|---|
| requests | 0 | 0 | 0 | 0 | 0 | OK | 0 |
| pings | 0 | 0 | 0 | 0 | 0 | OK | 0 |

Requests legacy-compatible = non-canonical duplicates preserved in `legacy_requests` with an alias (0). Requests "flagged" = malformed or referencing a user with no profile, imported verbatim; no quarantine rule is documented for requests, so none are quarantined.

Quarantined Pings that were answered-but-unprocessed (would hold an unapplied favour): **0**.


## Census D: legacy compatibility recommendations

No legacy category exists in production today, so there is nothing to recommend per category. The standing recommendations from `MIGRATION_DECISIONS.md` (2a, 2b) are unchanged and remain as the design for the schema: keep normal rows normal; keep legacy-shaped rows verbatim with a legacy flag; archive non-canonical duplicate requests with an alias; quarantine only the four documented criteria; never delete or archive-only an answered-but-unprocessed Ping. Those mechanisms stay in the Phase 2 schema as small, empty tables (cheap insurance, see ambiguities).

## Unresolved ambiguities

1. **The census is a snapshot of an almost empty database** (0 requests, 0 pings, 1 user profile at the census time). It proves no legacy data exists *today*; it says nothing about data that appears before cutover. The census must be re-run read-only immediately before any import (a later phase), and the Phase 2 schema should still carry the legacy and quarantine tables, because real users may create duplicates or legacy-shaped data in the interim.
2. **Whether this is the full production population.** The count comes from the `(default)` Firestore database of `attendance-tracker-2k26` via the signed-in Firebase CLI account. If real users write to a different database or project, this census does not see them. Worth confirming the deployed Vercel app points at this project (plan section 27 already lists Vercel env as unverified).
3. **Decisions 2a and 2b are not finalised by this census.** The evidence is unambiguous only in the narrow sense that today's production contains no duplicates, legacy Pings or quarantine candidates. It does not show whether the machinery is needed later, so no decision is changed.
4. Collections not read (`syncs`, `invites`, `pushTokens`) were out of scope; their counts are not part of this report.
5. Quarantine criteria for `requests` are not documented anywhere, so none are applied; the script reports malformed requests as "flagged" only.
