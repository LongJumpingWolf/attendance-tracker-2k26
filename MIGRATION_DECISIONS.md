# MIGRATION_DECISIONS.md

Decision lock for the Firebase to Supabase migration. Resolves the six owner decisions listed in `MIGRATION_PLAN.md` section 25, using the real code, the real Firestore rule history, and the vendor documentation. Written 2026-10-07 on branch `migration/supabase` (base `3644948`, Phase 1 harness `c76eac0`).

**Nothing is implemented by this document.** No Supabase project, table or migration exists; no application code, Firebase configuration, package or deployment was touched.

> **Production census (2026-10-07):** see `MIGRATION_PRODUCTION_CENSUS.md`. A read-only census found 0 `requests`, 0 `pings` and 1 `users` document, so no duplicate pairs, legacy Pings or quarantine candidates exist today. Decisions 2a and 2b are not changed by it.

## Status legend

| Status | Meaning |
|---|---|
| **APPROVED FOR IMPLEMENTATION** | The evidence is sufficient and the recommendation is ready to build. It is still **not built until the owner signs off** in section 9. |
| **PROVISIONAL** | A recommendation exists, but it depends on facts we do not have yet (production data, usage, owner input). It must be re-confirmed. |
| **REQUIRES SPIKE** | A technical assumption is unproven. It must be proven by an experiment with a written pass/fail criterion before anything depends on it. |

How evidence is labelled in this document: **[CODE]** read from this repository at HEAD; **[RULES-HISTORY]** read from `git show` of `firestore.rules` at earlier commits; **[DOCS]** read from the vendor documentation pages fetched on 2026-10-07; **[UNVERIFIED]** not established by any of those, so it must not be relied on.

## Summary

| # | Decision | Recommendation | Status | Blocks |
|---|---|---|---|---|
| 1 | Identity: keep Firebase Auth, bridge to Supabase | Option A, behind a hard spike gate | **REQUIRES SPIKE** | Phase 5 onward (not Phases 2 to 4) |
| 2a | Legacy duplicate friend pairs | Keep every row; one canonical connection plus a verbatim legacy archive and alias table; nothing merged or deleted silently | **PROVISIONAL** (needs a read-only census of production) | Shape of the Phase 2 tables |
| 2b | Legacy Pings that break the new limits | Import verbatim into the same table with a legacy flag; gate mutations by the new rules; quarantine only provably inconsistent records; delete nothing | **PROVISIONAL** (needs the same census) | Shape of the Phase 2 tables |
| 3 | Push token per account or per device | Schema keyed by (uid, device); client stays one-token-per-account at cutover | **APPROVED FOR IMPLEMENTATION** | Nothing |
| 4 | Write-freeze at cutover | Yes for social and Ping writes (minutes to hours), no freeze for attendance or sync | **PROVISIONAL** | Phase 12 only |
| 5 | Free-project keep-alive | Yes, external scheduled request from day one, plus an alarm | **PROVISIONAL** (effectiveness unproven) | Nothing, but start early |
| 6 | Who provisions Supabase and the Firebase service account | Owner creates accounts and keys; least-privilege service accounts; Claude never handles raw secrets | **APPROVED FOR IMPLEMENTATION** | Phase 2 (project must exist) |

**Blockers.** Decision 1 blocks Phase 5 and everything after it, but not Phases 2 to 4. Decisions 2a and 2b do not block starting Phase 2 provided the schema is built to the lenient, legacy-tolerant shape in section 8 (they only block *finalising* the import treatment, which needs the census). Decision 6 blocks Phase 2 only in the sense that the owner must create the Supabase project.
**Can safely proceed.** Decisions 3, 5 and 6. Decision 4 can wait until Phase 12.

## Principle that governs decisions 1, 2a and 2b

We are migrating **existing data**, not designing a fresh app. Every record is placed in exactly one of three classes, and the classes are never blurred:

1. **New-data invariants.** What the new system lets *future* writes do. They are strict and must not be weakened to fit old data. They are enforced where new writes enter (the RPC functions) plus a defence-in-depth trigger, **not** by table `CHECK` constraints that old rows would violate.
2. **Legacy-data compatibility.** Records that were *valid under the rules actually in force when they were written* but violate a new invariant. They are preserved verbatim, flagged, and allowed only the transitions that are safe for them (the same transitions the currently deployed rules allow).
3. **Invalid or forged data.** Records that were never valid under any rules that existed, or that are internally inconsistent. They are never made live. They are **preserved verbatim in quarantine** for owner review. They are not deleted and not "repaired".

**Conservation law for the migration (testable):** for every collection, `records exported = imported live + imported flagged-legacy + archived-and-aliased + quarantined`, and `records deleted = 0`. Any difference fails the import.

---

## Decision 1: Identity strategy (keep Firebase Auth) and the Phase 5 spike gate

**Status: REQUIRES SPIKE**

### 1. DECISION
Which identity system does the Supabase backend trust, and do we accept a hard gate: stop at Phase 5 if the bridge cannot be made to work on the free plans?

### 2. OPTIONS
- **A. Keep Firebase Auth; make Supabase accept Firebase ID tokens** (third-party auth). Firebase uids stay the user ids.
- **B. Move to Supabase Auth together with the data.** Every uid changes.
- **C. Edge-Function-only API.** Supabase never authorises by JWT role; every request goes through an Edge Function that verifies the Firebase ID token itself and uses the service role. A degraded fallback for A.
- **D. Mint our own Supabase-compatible JWTs** from an Edge Function after verifying the Firebase token. A second fallback for A.
- **E. Upgrade Firebase to Identity Platform / Blaze** to use the documented blocking-function route. Excluded by the owner's no-billing constraint.

### 3. RECOMMENDED OPTION
**A**, with the spike in section 4c as a hard gate. If the gate fails, the fallbacks are tried in the order **C, then D**, and *every* fallback is reported to the owner before anything is built. B and E are never adopted silently.

### 4. WHY
- The Firebase uid is stored **inside user-owned data** that we cannot reach: `mates[].uid` in every cloud backup, in each device's IndexedDB, in every restore point, in ping ids and `identityCarry` [CODE, plan section 6.4]. Changing uids (B) means rewriting data on every device, including devices that are offline for weeks.
- Anonymous accounts have no email or portable credential. They cannot be migrated across providers at all, so B would silently destroy those users' friendships.
- A keeps identity, storage, realtime, Ping and notifications from all changing at once, which is the standing rule for this migration.
- Firebase Auth anonymous and Google sign-in stay on the free Spark plan [no change from today].
- Supabase documents Firebase Auth as a supported third-party provider and includes **50,000 third-party monthly active users on the Free plan**, with anonymous sign-ins included [DOCS: supabase.com/pricing].

### 4a. The exact technical assumption that blocks Phase 5
> *Supabase can authorise requests carrying a Firebase ID token, using only components available on the free Firebase Spark plan and the free Supabase plan.*

Broken down (what is known and what is not):

| # | Fact or assumption | Evidence |
|---|---|---|
| a | Supabase can accept Firebase ID tokens if the Firebase project id is registered in the dashboard (Authentication, Third-Party Auth). Tokens from unregistered projects are rejected before reaching the database. | **[DOCS]** supabase.com/docs/guides/auth/third-party/firebase-auth |
| b | **Every token must carry the custom claim `role: "authenticated"`.** Without it Supabase assigns the `anon` role, so RLS policies written for signed-in users would not apply. "By default, Firebase JWTs do not contain a role claim." | **[DOCS]** same page |
| c | The documented ways to add that claim are (1) Firebase **blocking functions**, "only available if your project uses Firebase Authentication with Identity Platform", and (2) the Admin SDK `setCustomUserClaims` called from an `onCreate` Cloud Function, plus an Admin SDK **backfill script** for existing users. Existing users get no claim until it is set. | **[DOCS]** same page |
| d | **Both documented routes depend on Firebase components that, to our knowledge, need the Blaze plan** (Identity Platform upgrade; Cloud Functions deployment). The page does not state plan requirements. This is *exactly* why the Cloud Functions in this repo were never deployed. | The page states only the Identity Platform requirement. That it implies Blaze is **[UNVERIFIED]**; our own Spark/Blaze experience with Functions is **[CODE/history]**. |
| e | The **Admin SDK call itself** (`setCustomUserClaims`, i.e. an authenticated REST call to the Identity Toolkit API using a service account) is not documented to need Blaze, and can run anywhere that holds a service account, including a Supabase Edge Function or a terminal script. | **[UNVERIFIED]**. This is the assumption the whole plan rests on. |
| f | A new sign-in (every new anonymous user) has no claim, so a replacement for the `onCreate` trigger is required: a "claim bootstrap" that the client calls once, after which it force-refreshes its token (`getIdToken(true)`). | Design inference from **[DOCS]** (the docs show the forced refresh after `onCreate`). The bootstrap itself is **[UNVERIFIED]**. |
| g | RLS and RPC functions must read the user id with `auth.jwt()->>'sub'`. The docs page does **not** show this. Supabase's `auth.uid()` returns a `uuid`, and a Firebase uid is a 28-character non-UUID string, so `auth.uid()` is expected to fail. | The `sub` pattern is **not stated** in the docs we fetched. The `uuid` behaviour of `auth.uid()` is from general knowledge: **[UNVERIFIED]**. |
| h | Realtime authorisation uses the same `role` claim ("...Data API, Storage or Realtime authorization"). Whether Postgres Changes with RLS works for a text user id, and keeps working across Firebase's hourly token refresh, is not documented. | Claim from **[DOCS]**; behaviour **[UNVERIFIED]**. |
| i | Firebase signs with one key set shared by all Firebase projects, so for safety the policy examples add a restrictive check on `iss` and `aud`. On the hosted platform the project-id registration already rejects other projects, and the docs call the extra policy optional. | **[DOCS]** |
| j | Key rotation of the provider's signing keys can take up to 30 minutes to be picked up. | **[DOCS]** (overview page) |
| k | It is not possible to disable Supabase Auth, so the project always contains an (unused) Auth service. | **[DOCS]** (overview page) |

**The claim we cannot make:** that the bridge works. Nothing in section 4a is verified by an experiment. Items d to h in section 4a are the open questions.

### 4b. What can be tested without Blaze
Everything the recommended design uses. It needs **a throwaway Firebase project on the Spark plan** (not production) and **a throwaway Supabase Free project** (Free allows 2 active projects, so the spike uses the second slot and is deleted afterwards):

- anonymous and Google-style sign-in through Firebase Auth, obtaining real ID tokens;
- an Edge Function that verifies the token and sets the custom claim through the Identity Toolkit REST API with a service account;
- the Supabase side: third-party auth registration, RLS, RPC and Realtime with real Firebase tokens;
- token refresh, expiry, anonymous-to-Google linking, and a backfill of existing users by a terminal script using the Admin SDK.

**Cannot be tested, and deliberately is not used:** blocking functions (Identity Platform) and any Cloud Function trigger (both Blaze). If the spike shows the bridge *requires* one of them, that is a NO-GO, not something to engineer around quietly.

### 4c. Spike specification (Phase 5, must be run before any bridge code)
Environment: throwaway Firebase project (Spark) and throwaway Supabase project. No production data, no production keys. Results recorded in the repository as numbered pass/fail lines.

**MUST-pass tests (any failure is NO-GO):**

| # | Test | Pass criterion |
|---|---|---|
| S1 | Register the throwaway Firebase project id in Supabase third-party auth. Sign in anonymously and send the ID token to PostgREST. | Request is accepted as a valid JWT (no `anon` rejection for a malformed token). Role observed is `anon` (proves the claim is the gap). |
| S2 | **Set `role: authenticated` for that uid from outside Google's infrastructure on the Spark plan**, using only a service account and the Admin SDK (script) and then the same call from an **Edge Function** (Deno). Force-refresh the token. | The refreshed ID token decodes with `role == "authenticated"`; both the script and the Edge Function succeed with **no Blaze, no Identity Platform, and no Cloud Function**. |
| S3 | With that token, call an RLS-protected table and an RPC. Read the id via `auth.jwt()->>'sub'`. Also try `auth.uid()`. | Rows are visible only to their owner; a second user sees none; `sub` equals the Firebase uid exactly. Record whether `auth.uid()` errors (expected) so no code uses it. |
| S4 | A token from a **different Firebase project**, a token with the right project but **no role claim**, an **expired** token, and a **tampered** token. | All are rejected or limited to `anon`; none reads or writes protected data. |
| S5 | The **claim-bootstrap Edge Function** must verify the incoming Firebase ID token (signature, `iss`, `aud`, expiry) before setting a claim for **that token's own uid only**. | A forged or other-project token cannot cause a claim to be set for any uid; a valid token sets it only for itself. |
| S6 | **Anonymous user links to Google** (`linkWithCredential`) in the same browser. | Same uid, claim preserved, Supabase access continues with no re-bootstrap. |
| S7 | **Account switch** (`credential-already-in-use`): the device becomes a different, pre-existing uid. | The new uid works (it was backfilled or bootstraps); the old uid's rows are not visible to the new identity. |
| S8 | **Realtime:** subscribe with a bridged token to a table with RLS (Postgres Changes) for a text uid, filtered by `from_uid` / `to_uid`. | Owner receives INSERT/UPDATE; a stranger receives nothing. |
| S9 | **Token refresh during a live Realtime subscription** across at least one natural Firebase token refresh (about 1 hour). | The subscription keeps delivering after the refresh, or the documented recovery (re-auth the channel) restores it automatically with no event loss. |
| S10 | **Offline-first behaviour:** device offline at first launch; bootstrap and Supabase calls fail. | The app remains fully usable and no write is lost; the bootstrap is retried later without user action. |
| S11 | **Backfill:** a terminal script using the Admin SDK sets the claim for N existing users (including anonymous ones). | All N users get the claim; running it twice is harmless. |
| S12 | **Cost and quota:** count Edge Function invocations and third-party MAU the spike would imply per 1,000 users. | Projected usage is far inside the Free limits (Edge Functions 500,000 per month; third-party MAU 50,000 [DOCS]). |

**SHOULD-pass (informational, not a gate):** how long the first-ever sign-in takes end to end; behaviour on key rotation; whether a stale cached token causes any security-relevant window.

### GO / NO-GO criterion
- **GO** if and only if **S1 to S12 all pass** on the Spark and Free plans with no component that needs Blaze or Identity Platform. The result is recorded and the owner signs it off before Phase 5 builds anything real.
- **NO-GO** if **S2 fails** (the claim cannot be set without Blaze), or S3, S4, S5 or S7 fail (a security or identity-leak defect), or S9 cannot be made reliable. S10 failing means the design breaks offline-first, which is also NO-GO.
- On NO-GO: **stop**, write up why, and present the owner with the remaining options (C, then D, then the paid options), including the cost of each. Do **not** fall back to Option B.

### 5. MIGRATION CONSEQUENCE
- Phases 2 to 4 are unaffected: the schema and RLS can be written and tested with locally-minted JWTs that carry `sub` and `role`, which does not prove the Firebase bridge.
- Schema consequence **whatever the outcome of the spike**: user ids are `text`, and every policy and RPC reads `auth.jwt()->>'sub'`. Nothing uses `auth.uid()`.
- Firebase stays a runtime dependency (Auth only) indefinitely. Phase 13 retires Firestore, Functions and rules, **not** Firebase Auth.
- A new component appears: the claim-bootstrap Edge Function holding a Firebase service-account key (section 6, decision 6 covers least privilege).
- Option C fallback would move all authorisation into Edge Functions and weaken realtime to pull or Broadcast-only; Option D depends on the project's JWT secret model. Both are costs the owner must see before choosing them.

### 6. RISK IF WE CHOOSE WRONG
- **Choosing A and being wrong about the bridge** after building on it: wasted phases, or worse, a bridge that accepts a token it should not (identity leak, wrong user receiving data). The spike exists to make this failure cheap and early.
- **Choosing B:** identity split, silent loss of anonymous users' friendships, offline devices holding stale uids, irreversible once uids change.
- **Choosing E:** violates the billing constraint.

### 7. ROLLBACK IMPLICATION
- Before the spike passes nothing depends on it, so rollback is "do not proceed".
- After adoption, the bridge is reversible by flag: Firebase remains the data backend until Phase 12, and Firebase Auth is unchanged, so turning the bridge off returns every client to Firebase with the same uids. Option B has **no** equivalent rollback (uids change), which is the strongest argument against it.

---

## Decision 2a: Legacy duplicate friend pairs

**Status: PROVISIONAL** (the treatment is deterministic and testable; the *amount* of data is unknown until a read-only census of production is run)

### 1. DECISION
What happens, during migration, to friend connections that exist more than once for the same two people?

### 2a.0 What "duplicate friend pairs" means in the current data model [CODE]
A friendship is one `requests` document whose `participants` are two uids; an accepted one *is* the connection. **Nothing ever enforced one document per pair**: the rules (at every version) have no uniqueness check, and the client decides "already connected / already waiting" from its **local snapshot** (`use-social.ts connect`, plan section 7). `requests` ids are random auto-ids (`addDoc`), so a repeated write makes a second document.

A **duplicate pair** is: two or more `requests` documents whose unordered `{from, to}` is the same pair, where at least two have status `pending` or `accepted`. Ways they arise in the code:

| Kind | How it arises |
|---|---|
| **D-1** same direction, both pending (A to B twice) | a double tap or a retry: `sendRequest` is a non-idempotent `addDoc` |
| **D-2** opposite directions, both pending (A to B and B to A) | two people scan each other's QR at about the same time; each client's snapshot still shows nothing |
| **D-3** accepted plus another non-declined | a request is sent in one direction after a connection already exists on another device's snapshot |
| **D-4** **two accepted** | from D-2: each person sees and accepts the request *addressed to them*, producing two accepted documents for one pair |
| **D-5** declined plus a newer pending or accepted | the client deletes a declined request before re-sending; if that delete failed it stays |
| **D-6** carry-over duplicates | `completeCarry` after an account switch stops at the first failure and is retried; a write that succeeded but looked failed is sent again |

Also noted (not duplicates, but present in the same data): **ghost requests** that reference an abandoned anonymous uid after an account switch (their other participant never accepts or deletes them); pending requests never expire; no `to` user-existence check.

Why it matters: `Ping.requestId` points at one specific `requests` document, and `sendPing` uses "the first accepted request found" in its local snapshot, so **different pings of the same pair can point at different duplicate documents**. Deleting or merging a duplicate carelessly would break pings and would change what the Mates screen shows ("connected" is derived from the set of accepted partners, plan section 7).

Existing behaviour worth recording: with two accepted documents for a pair, the app's "remove mate" deletes only one, so the person stays connected. A migration that collapses duplicates would make removal complete. That is a *behaviour change in a safe direction*, but it must be an explicit, owner-visible choice, not a side effect.

### 2. OPTIONS
- **a. Import verbatim, no uniqueness.** Keeps everything but gives the new system the same race forever.
- **b. Auto-merge or delete duplicates.** Rejected: silent data change, breaks pings that point at the deleted id.
- **c. Import every document; designate one canonical `connections` row per pair by a fixed rule; keep the rest verbatim in a legacy archive with an alias table; enforce uniqueness for new rows only.**
- **d. Refuse to import until duplicates are cleaned by hand.** Rejected: blocks the migration and moves risk to a manual step.

### 3. RECOMMENDED OPTION
**c.**

**Deterministic treatment (the rule is the specification; the census only supplies the counts):**
1. Group all `requests` by the unordered pair. Pairs with exactly one non-declined document, plus any number of declined ones, are **not** duplicates: import as-is (declined rows are allowed to coexist; the new uniqueness index ignores them).
2. For a pair with two or more non-declined documents choose the **canonical** row by this fixed order: (i) status `accepted` over `pending`; (ii) the earliest `createdAt` (missing sorts last); (iii) the smallest document id (byte order). The choice depends only on the data, never on run order.
3. The canonical row becomes the pair's single live row in `connections`, **keeping its original document id**.
4. Every other document of the pair is copied **verbatim and complete** into `legacy_requests` (raw JSON plus the original id) and given an **alias** row `(legacy_id, canonical_id, reason)` where `reason` is one of `D-1 … D-6`. The legacy document is never deleted and its bytes are never altered.
5. If a duplicate has a *different* meaning than the canonical (for example one `pending` and one `accepted`), the canonical is the accepted one; the pending is recorded as superseded in the alias reason, nothing is "completed" automatically.
6. Pings and clients that name a non-canonical id resolve through the alias table (see decision 2b: the connected check becomes pair-based, with the stored `request_id` kept for audit). `remove_request(id)` resolves aliases and removes the canonical row; the legacy archive row stays.
7. A **migration report** lists every pair, which row was canonical, and every alias created. It contains user ids, so it is stored privately by the owner and **not** committed; only summary counts go in the repository.

### 4. WHY
- It satisfies "do not silently merge or delete": nothing is deleted, every decision is recorded, and the rule is deterministic and unit-testable.
- It preserves the user's relationships: the accepted connection stays accepted; the set of connected people the UI shows is unchanged.
- It fixes the race for *new* data without weakening anything (the partial unique index on `(least(from,to), greatest(from,to)) WHERE status IN ('pending','accepted')` applies to live rows only).

### 5. MIGRATION CONSEQUENCE
- Phase 2 schema gains `legacy_requests` (verbatim archive) and `connection_aliases`; `connections` keeps the legacy ids.
- Requires a **read-only census** (Phase 6 deliverable, run by the owner in a terminal with a read-only service account): count of pairs per kind D-1 to D-6, count of pings per non-canonical request id, count of ghost requests. If the census finds **zero** duplicates, the machinery is still built (it is small) but stays empty.
- Table columns that legacy rows can violate (names missing or over 40 characters, `createdAt`/`respondedAt` missing) get **no table-level `CHECK`**; the limits are enforced by the create RPC only (new-data invariant).
- Acceptance tests: each pair kind D-1 to D-6 imports to the expected canonical and alias rows; the import is idempotent; the conservation law holds; the Mates screen shows the same set of connected people before and after.

### 6. RISK IF WE CHOOSE WRONG
- **Auto-merge (b):** a user loses a friendship or a Ping becomes unanswerable. Hard to detect, hard to undo.
- **Verbatim with no rule (a):** ambiguity about which connection a Ping belongs to, possible double-processing.
- **Wrong canonical rule:** a pending row wins over an accepted one and a friendship appears "unconnected". The fixed order above prevents this; tests must pin it.
- **Unknown data volume:** if production has far more duplicates than expected the alias path is exercised heavily. That is why the census comes before the import design is frozen.

### 7. ROLLBACK IMPLICATION
Fully reversible: the legacy archive holds the original documents byte-for-byte, and Firebase is untouched until Phase 12. Rolling back is just using Firebase; nothing in Firestore was changed.

---

## Decision 2b: Legacy Pings that violate the new constraints

**Status: PROVISIONAL** (the violation list below is derived from the actual rule history; which of them exist in production is unknown until the census)

### 1. DECISION
What happens to Ping records written under older, weaker rules that cannot satisfy the new constraints?

### 2b.0 Exactly what legacy Pings can violate [RULES-HISTORY and CODE]
Three rule generations touched `pings`:

| Generation | Commit | What it checked on create | What it checked on answer |
|---|---|---|---|
| **R1** | `a4467fe` | `from == auth`, `to != from`, `participants == [from,to]`, `requestId` is a string, request accepted and both uids in it, `status == 'asking'`, `date is string`, `items is list`, **1 to 12 items** | only: `to == auth`, status asking, answered, **item count unchanged**, only `items/status/respondedAt` may change |
| **R2** | `92c2919` | adds `fromName`/`toName` string and at most 40 characters, `date` matches `YYYY-MM-DD`; adds `answered -> processed` by the asker | same answer rule as R1 |
| **R3** (deployed now) | `3644948` | server-time `createdAt`, recent date, item shape, **at most 8 items**, lease and finalize rules, and (last fix) the receiver-answer rule requires `createdAt <= request.time` and `items.size() <= 8` | answer only changes `items[i].answer` to yes or no |

Which of these generations actually ran in production, and for how long, is **[UNVERIFIED]**: the owner reports that rules were deployed recently, and earlier deployments are not recorded in this repository. The census must therefore assume **any** of R1 to R3 produced records.

**What an R1 or R2 record can contain that violates the new model** (and why it was *valid when written*):

| # | Violation of new invariants | Possible under | Notes |
|---|---|---|---|
| V1 | **9 to 12 items** | R1, R2 (limit was 12) | The case already handled by the deployed answer rule: such a Ping cannot be answered now. |
| V2 | Item **shape**: missing or non-string `key`/`subjectId`, extra fields, `name` over 60 characters, `t` not `HH:MM`, answers other than yes/no/null | R1, R2 (items were never shape-checked) | |
| V3 | **Answers rewritten by the receiver:** the old answer rule only froze the item *count*, so a receiver could change any field of any item (subject, name, time), not just `answer` | R1, R2 | The original asked values cannot be recovered, so tampering is **undetectable** after the fact. This is the reason the cap and shape rules exist. |
| V4 | `date` **not** `YYYY-MM-DD` (any string) | R1 only (R2 added the format) | |
| V5 | `date` older than 3 days (normal for history) | all | Legitimate: "recent" only ever applied at creation. Must not be rejected on import. |
| V6 | `createdAt` **missing, unpinned, or in the future** | R1, R2, and any R3 ping created before the last fix | R1 to R2 never pinned it to `request.time`; a forged future `createdAt` defeats expiry. |
| V7 | `fromName`/`toName` missing or over 40 characters | R1 only | |
| V8 | `requestId` points at a request that **no longer exists, was declined, or is a non-canonical duplicate** | all | The friendship may have been removed after the Ping, because the remove flow deletes the accepted `requests` document but keeps answered and processed Pings as history. A foreign key to `connections` would reject these. |
| V9 | `participants` includes an **abandoned uid** (an anonymous account the person left behind) | all | Valid; just unreachable. |
| V10 | Auto-generated ids from older `addDoc` writes rather than the client-chosen deterministic id | before Phase 2 | Normal; Firestore auto ids are 20 alphanumeric characters and satisfy the new id pattern, but the import must still verify it. |
| V11 | `answered` and never processed (stuck), including legacy answered Pings that the asker has not applied yet | all | **Must remain finalizable**: these are real, unapplied favours. |
| V12 | `asking` and long expired | all | History only. |

Statuses: R1 could only produce `asking` and `answered`; `processed` exists from R2.

**Which of these are forged or inconsistent rather than merely old?** Evidence-based tests that make a record *invalid* regardless of when it was written:
- `participants` is not exactly `[from, to]`, or `from == to` (never permitted by any rule generation);
- `status` is not one of `asking`, `answered`, `processed`;
- `createdAt` is later than the export time (it cannot have existed yet);
- an `answered` or `processed` item with an answer that is not `yes`/`no`/`null`.
Everything else on the list above is **legacy**, not invalid, **even though it cannot be verified**; in particular V3 tampering cannot be told apart from an honest answer, so it is **never** a quarantine reason by itself.

### 2. OPTIONS
- **a. Reject or expire legacy Pings** that fail the new constraints (the plan's earlier wording). Rejected as a policy: it deletes or hides valid history and, for V11, can drop real unapplied favours.
- **b. Coerce them** to fit (truncate to 8, rewrite dates, clamp timestamps). Rejected: silent data change, and it would hide possible tampering.
- **c. Separate read-only archive table for all legacy Pings.** Simple, but **breaks the live path**: an `answered` legacy Ping must still reach the asker's listener, be leased, applied and finalized.
- **d. Same `pings` table, legacy rows imported verbatim with a `legacy` marker and flags; mutations are gated by the new invariants; provably-inconsistent records go to a separate quarantine table.**

### 3. RECOMMENDED OPTION
**d**, with these rules:

1. **Import verbatim.** `items` stays `jsonb` exactly as exported. `class_date` is stored as **text** (not cast to `date`), timestamps are nullable for legacy rows, and `request_id` is a **plain text column with no foreign key**. Table `CHECK` constraints are limited to what *all* rows satisfy (the id pattern, the status set); the strict limits live in the RPCs.
2. **Mark them.** `legacy boolean` plus `legacy_flags text[]` listing which of `V1 to V12` apply (`items>8`, `item-shape`, `date-format`, `no-created-at`, `request-missing`, `name-length`, and so on). New rows are `legacy = false` and cannot be created with the flag.
3. **Gate mutations by the new invariants, exactly as the deployed rules do today** (this is the *behaviour-parity* target; the existing rules tests are the spec):
   - **answer:** allowed only if the row also satisfies the new invariants (at most 8 items, valid shape, `created_at` present and in the past, not expired). A legacy Ping that does not simply cannot be answered and expires, as it does now.
   - **lease, finalize:** allowed for **any** `answered` Ping including legacy ones, because they touch only claim and status fields. This keeps real, unapplied favours recoverable. (This is the existing `legacy-compat` test "an answered legacy Ping can still be finished".)
   - **delete:** by a participant unless `answered`, unchanged.
4. **Quarantine, never delete.** Records that fail the *invalid or forged* tests above go to `quarantined_records(collection, doc_id, raw jsonb, reasons text[], exported_at)`. They are invisible to every client, kept verbatim, listed in the private report, and the owner decides later. Quarantining an `answered` unprocessed Ping is reported **separately and loudly** because it holds an unapplied favour.
5. **Do not weaken the new security model.** The strict rules still apply to everything created after cutover; no legacy path exists for *creating* a legacy-shaped Ping. The `legacy` flag can only be set by the import, which runs with the service role.
6. **The "connected" check on answer becomes pair-based:** an accepted connection exists between exactly `from_uid` and `to_uid` (through the canonical row or an alias). This is at least as strict as today's by-id check for new Pings, and it removes V8 and the duplicate-pair problem as obstacles. It needs its own tests; it is a deliberate, documented difference, not a silent one. The stored `request_id` is kept for audit.

### 4. WHY
- It follows the three-class principle: new data stays strict; valid-but-old data is preserved and made safe; forged data never becomes live.
- It reproduces exactly the protections that were just proven with the rules tests (legacy 9 to 12 classes cannot be answered or rewritten; a future `createdAt` cannot dodge expiry), so the migration does not reopen what was closed.
- It does not drop real favours (V11), which a "reject legacy" policy would.
- A separate archive (option c) would force the client to read two places and complicate the one flow that must not break (answer, lease, apply, finalize).

### 5. MIGRATION CONSEQUENCE
- Phase 2 schema: `pings` with `legacy`, `legacy_flags`, nullable `created_at`, text `class_date`, plain `request_id`, `items jsonb` (strict item and count validation in the RPC and a defence-in-depth trigger that **skips rows flagged legacy only for the transitions listed above**); `quarantined_records`.
- This **amends** `MIGRATION_PLAN.md` section 12.2 (which had `class_date date`, a foreign key from the Ping to the connection, and a table-level item-count `CHECK`). Those three are changed here for the reasons in V4, V8, V1. The plan carries a cross-reference.
- Census (read-only, same script as decision 2a): counts per V1 to V12, count of `answered` and unprocessed legacy Pings, count of records that would be quarantined and why.
- Acceptance tests (to be written in Phase 3): a legacy Ping with 9 to 12 items imports intact and cannot be answered; one with a future `createdAt` is quarantined or flagged exactly per the rules above and cannot be answered; an `answered` legacy Ping can be leased and finalized; the conservation law holds; importing twice changes nothing; a new Ping with 9 items or a future `createdAt` is rejected by the RPC.

### 6. RISK IF WE CHOOSE WRONG
- **Reject or coerce (a, b):** user-visible loss of history or of unapplied favours; tampering hidden.
- **Archive-only (c):** an in-flight answered Ping becomes un-finalizable at cutover: a lost favour.
- **Keeping a foreign key on `request_id`:** the import fails or silently drops every Ping whose friendship was later removed (V8).
- **Quarantining too eagerly:** real records disappear from users' view. The quarantine criteria above are deliberately narrow and evidence-based.
- **Quarantining too little:** a forged future `createdAt` imported as live would reopen the expiry bypass; hence it is quarantined.

### 7. ROLLBACK IMPLICATION
Same as 2a: the import never deletes or alters Firebase, quarantine and archive hold the raw documents, and `legacy` rows can be dropped and re-imported (the import is idempotent). Rolling back is "stay on Firebase".

---

## Decision 3: Push tokens, one per account or one per device

**Status: APPROVED FOR IMPLEMENTATION** (ready to build; not built until sign-off)

### 1. DECISION
Does the Supabase `push_tokens` table hold one token per account (today) or one per device?

### 2. OPTIONS
- **a.** One row per `uid`: exact parity; the last device to register wins and other devices are never alerted.
- **b.** One row per `(uid, device_id)` and a client that sends its device id.
- **c.** Schema per device now; the client keeps its current one-token behaviour at cutover; per-device behaviour is switched on later as a separate, tested product change.

### 3. RECOMMENDED OPTION
**c.**

### 4. WHY
- Today no push is ever delivered: the Cloud Functions that send it were never deployed [CODE], so there is **no production behaviour to preserve** and nothing can regress.
- The table shape is the part that is expensive to change later; the client behaviour is cheap to change later.
- A device id already exists (`lib/device.ts`, a random id used as the lease holder) [CODE].
- Per-device matters in practice: a student with a phone and a laptop on the same Google account currently only gets alerts on whichever registered last [CODE: `pushTokens/{uid}` is a single document].

### 5. MIGRATION CONSEQUENCE
- Schema: `push_tokens(uid text, device_id text, token text, updated_at timestamptz, PRIMARY KEY (uid, device_id))`, with the token length bounds as in the current rules.
- Import: each existing `pushTokens/{uid}` becomes one row with `device_id = 'legacy'`. The sender sends to every row of the recipient, deletes a row when FCM reports the token as dead (`registration-token-not-registered`, `invalid-registration-token`), and uses the existing `tag ping-<id>` so one device never shows a duplicate.
- Client at cutover: unchanged behaviour (it registers one token per account), writing `device_id = 'legacy'` or its device id; the switch to per-device is a later, separate change with its own tests, including duplicate-notification checks.

### 6. RISK IF WE CHOOSE WRONG
Choosing (a) and later wanting per-device means a table migration plus a client change at the same time. Choosing (b) now couples a user-visible notification change to the backend migration. A mistake in (c) is limited to a harmless extra column.

### 7. ROLLBACK IMPLICATION
Trivial: the table is new and empty of behaviour. If per-device delivery misbehaves, the sender can be pointed at a single row per account without any schema change.

---

## Decision 4: Is a short write-freeze at final cutover acceptable?

**Status: PROVISIONAL** (the recommendation is sound but the owner must confirm acceptability, and actual usage patterns are unknown)

### 1. DECISION
At the moment authority moves from Firebase to Supabase, may we pause *some* writes for a short window?

### 2. OPTIONS
- **a. No freeze, ever.** Run both backends writable and reconcile continuously.
- **b. Freeze only the social and Ping writes** (minutes to hours), keep attendance and sync fully working.
- **c. Freeze everything.**

### 3. RECOMMENDED OPTION
**b.**

### 4. WHY
- **Attendance never needs a freeze.** It is local-first: marks are written to IndexedDB and the sync push is already designed to fail softly and retry with a compare-and-set on `rev` [CODE: `use-cloud-sync.ts`]. With shadow writes running through the soak (Phase 6) Supabase already holds every sync write, and the existing three-way merge absorbs any rev difference.
- **Social and Ping state cannot be dual-authoritative.** They are a state machine with leases and exactly-once processing, and `create` and `answer` need the network [CODE: `attempt()` returns at once when offline, nothing is queued].
- **Mixed-version clients make "no freeze" unsafe.** The app is a PWA with an offline shell, and the service worker keeps serving the cached app until a networked navigation replaces it [CODE: `public/sw.js`]. An old build never reads our feature flags and keeps writing to Firebase. If Supabase became authoritative while an old client could still write Pings to Firestore, a Ping created by a new client would never reach an old client's listener: a **split brain**.
- The only reliable way to stop old clients is on the **server side**: switch the Firestore rules for the social collections to read-only at cutover. Old clients then get `permission-denied`, which the app already handles (`attempt()` reports "not confirmed"), until they update. That *is* a freeze, so it should be planned and announced.

### 5. MIGRATION CONSEQUENCE
- Phase 12 gains an explicit freeze runbook: announce (in-app banner shipped in a release before cutover), deploy read-only rules for `requests`, `pings`, `invites`, `pushTokens` (a rules edit in git, deployable and revertible), take the final delta export, import, reconcile, flip the flags, un-freeze. Attendance sync is not part of the freeze.
- A client release must precede cutover so that most users are on a build that understands the flag; stragglers update on their next online navigation.
- Reverse mirroring (Supabase to Firebase) stays on for the soak so a rollback has current data (plan section 15). Firestore stays writable through the Admin SDK for that purpose.
- Duration depends on the volume found by the census; target minutes, budget hours.

### 6. RISK IF WE CHOOSE WRONG
- **No freeze (a):** split brain, lost or unseen Pings, possible double application of favours. This is the worst outcome and is silent.
- **Freeze everything (c):** needlessly blocks marking for users whose data syncs fine; contradicts local-first.
- **Freezing too late or announcing nothing:** users see "not confirmed" errors and think the app is broken.

### 7. ROLLBACK IMPLICATION
Before the flags flip, aborting is just redeploying the previous rules from git (Firebase is still authoritative and complete). After the flip, rolling back means flipping the flags back and relying on the reverse mirror; the freeze must be re-applied to Supabase writes while the reverse sync catches up. The runbook must have both directions rehearsed before Phase 12.

---

## Decision 5: Free-project keep-alive

**Status: PROVISIONAL** (the facts about pausing are documented, but what counts as "inactivity" and whether a keep-alive prevents pausing are not)

### 1. DECISION
Should we schedule regular activity so the free Supabase project is not paused for inactivity?

### 2. OPTIONS
- **a. Do nothing.**
- **b. External scheduled request** (for example a scheduled job hitting a harmless database call on a fixed cadence), with an alarm if it fails.
- **c. Upgrade to a paid plan** (never pauses).

### 3. RECOMMENDED OPTION
**b**, starting the day the Supabase project exists, plus a documented manual restore procedure. **c** is excluded by the billing constraint but should be recorded as the only guaranteed fix.

### 4. WHY
- The pricing page states: "Free projects are paused after 1 week of inactivity", with a limit of 2 active projects, and that paid plans are never paused [DOCS: supabase.com/pricing].
- A student attendance app is naturally quiet during semester breaks and exam leave, easily longer than a week. A paused project means **no sync and no friends or Pings** until someone restores it. The app keeps working offline, and no attendance is lost (local-first), but social features silently stop.
- What the docs do **not** say [UNVERIFIED]: what counts as activity (API requests, dashboard use, database connections), how long a paused project can be restored, and whether a scheduled ping counts. A keep-alive is therefore a *mitigation*, not a guarantee.

### 5. MIGRATION CONSEQUENCE
- A small scheduled job and an RPC such as `health()` that does a trivial query, called on a fixed cadence well inside a week.
- A failure alarm (so the owner is told, not surprised), and a runbook for "project paused: restore it".
- To learn whether it really works we must observe it over time; the plan therefore starts it in Phase 2, long before any user depends on Supabase. Note that a throwaway spike project for decision 1 occupies the second of the two free slots.

### 6. RISK IF WE CHOOSE WRONG
- **No keep-alive:** social and sync stop quietly after a quiet week.
- **A keep-alive that does not actually count as activity:** false confidence; the alarm and the manual restore runbook limit the damage.
- **Treating a keep-alive as permitted:** whether it is acceptable under the provider's terms is **[UNVERIFIED]**; check before relying on it.

### 7. ROLLBACK IMPLICATION
Disabling the job is instant. If the project is paused regardless, the fallback is to stay on (or flag back to) Firebase, which is why Firebase must stay deployed until after a long clean soak.

---

## Decision 6: Who provisions Supabase and the Firebase service account

**Status: APPROVED FOR IMPLEMENTATION** (procedural; the "can the keys be created" checks are part of the decision 1 spike)

### 1. DECISION
Who creates the Supabase project, Firebase service accounts and secrets, and how are those secrets protected?

### 2. OPTIONS
- **a.** The owner creates and holds everything; Claude writes code and scripts that read secrets from the environment only.
- **b.** The owner pastes keys to Claude so it can run steps itself.
- **c.** Shared tooling accounts.

### 3. RECOMMENDED OPTION
**a**, with least-privilege service accounts. Option b is declined: the Firebase Admin key can read and write all of Firestore and Auth, and it must never appear in chat, a commit, or a log.

### 4. WHY
- It keeps billing, account recovery and key custody with the owner.
- The permission system already blocks production deploys and pushes by Claude in this environment; the plan must work with that, not around it.
- Different jobs need different power:

| Job | Credential | Least privilege |
|---|---|---|
| Census and export of Firestore (read-only) | service account used by a local script | read access to Firestore only |
| Claim bootstrap and backfill (set custom claims) | service account | Firebase Authentication admin only |
| Push sending via FCM | service account or key | Firebase Cloud Messaging send only |
| Import into Supabase | service-role key | held only by the owner's terminal for the import, never shipped to the client |

### 5. MIGRATION CONSEQUENCE
- **Owner, Supabase dashboard:** create the project (region near the users; the Cloud Functions were set to `asia-south1`, which suggests Mumbai, availability **[UNVERIFIED]**), register the Firebase project id under third-party auth for the spike, enable extensions, create Edge Function secrets.
- **Owner, Firebase/Google Cloud console:** create the separate least-privilege service accounts, download keys, **store them outside the repository**; delete or rotate them after the migration.
- **Owner, terminal:** run export, census, backfill and import scripts, passing keys through environment variables or file paths outside the repo.
- **Claude can automate:** scripts, migrations, RPC and RLS code, tests, the reconciliation tooling, documentation.
- Repository hygiene to add when scripts arrive (not done here): ignore patterns for `*service-account*.json` and `.env*.local`; secret-scanning in the health check.
- Whether this account type allows creating service-account keys at all is **[UNVERIFIED]** and is checked in the spike.

### 6. RISK IF WE CHOOSE WRONG
A leaked Admin key is a full compromise of every user's data and identities. Putting an over-powerful key into Supabase Edge Function secrets enlarges the blast radius if that secret is exposed. Mixing the read-only export credential with the claim-setting credential would make a leak of either far worse.

### 7. ROLLBACK IMPLICATION
Keys are revocable at any time in the Google Cloud console, which ends the bridge or the sender immediately without touching user data. Revocation is the emergency stop and should be rehearsed.

---

## 8. Schema consequences of these decisions (for Phase 2; nothing is built yet)

Changes the decisions make to `MIGRATION_PLAN.md` section 12.2:
- user ids `text`; policies and RPCs read `auth.jwt()->>'sub'`, never `auth.uid()` (decision 1);
- `connections` keeps legacy ids; add `legacy_requests` (verbatim archive) and `connection_aliases` (decision 2a); no `CHECK` on columns old rows can violate;
- `pings`: text `class_date`, nullable `created_at`, plain `request_id` (**no foreign key**), `legacy` and `legacy_flags`, `items jsonb`; strict validation in the RPCs; pair-based connected check (decision 2b);
- `quarantined_records` for provably invalid data (decision 2b);
- `push_tokens` keyed by `(uid, device_id)` (decision 3);
- a `health()` function for the keep-alive (decision 5).

## 9. Owner sign-off

Nothing above is built until each box is ticked by the owner.

| Decision | Recommendation | Status | Owner approves |
|---|---|---|---|
| 1 Identity | Option A, spike S1 to S12 is the gate | REQUIRES SPIKE | [ ] approve the spike plan and the NO-GO rule |
| 2a Duplicate friend pairs | Option c, deterministic canonical rule | PROVISIONAL | [ ] approve the rule; [ ] approve running the read-only census |
| 2b Legacy Pings | Option d, verbatim plus flags, gated mutations, narrow quarantine | PROVISIONAL | [ ] approve; [ ] approve the quarantine criteria |
| 3 Push tokens | Option c | APPROVED FOR IMPLEMENTATION | [ ] approve |
| 4 Write-freeze | Option b | PROVISIONAL | [ ] a social and Ping freeze is acceptable |
| 5 Keep-alive | Option b | PROVISIONAL | [ ] approve |
| 6 Provisioning | Option a | APPROVED FOR IMPLEMENTATION | [ ] approve; [ ] owner creates the Supabase project |

## 10. What still has to be learned (not guessed)

1. Whether the claim can be set on the Spark plan from outside Google (spike S2).
2. How many duplicate pairs and legacy Pings production actually has (the census).
3. Which rule generations ran in production and when.
4. What Supabase counts as inactivity, and how long a paused project stays restorable.
5. Whether `auth.uid()` fails for non-UUID ids, and how Realtime behaves across token refresh (spike S3, S9).
6. Which Supabase region to choose and its availability.

Sources for the **[DOCS]** statements (fetched 2026-10-07): [Supabase: Firebase Auth](https://supabase.com/docs/guides/auth/third-party/firebase-auth), [Supabase: third-party auth overview](https://supabase.com/docs/guides/auth/third-party/overview), [Supabase pricing](https://supabase.com/pricing).

CURRENT MIGRATION STATUS:
PHASE 1 COMPLETE — DECISION LOCK PROPOSED, AWAITING OWNER SIGN-OFF
APPLICATION BACKEND — STILL FIREBASE
SUPABASE — NOT CONNECTED
PRODUCTION DATA — UNCHANGED
FIREBASE — NOT RETIRED
ROLLBACK — FULLY AVAILABLE
