# MIGRATION_PLAN.md — Firebase to Supabase

> **Decision lock:** the six owner decisions in section 25 are analysed in `MIGRATION_DECISIONS.md`, which also **amends section 12.2** (see the note there). Where the two documents differ, `MIGRATION_DECISIONS.md` wins.

Status: **Phase 0 audit.** Written from the repository at HEAD `3644948` ("Ping Phase 2: identity, server-side rules, exactly-once processing, rules tests"), working tree clean. Nothing was changed, installed, deployed or migrated to produce this document.

How this was produced: four read-only code audits (auth/identity/Firebase imports; Firestore model/rules/friends; Ping/notifications/functions; IndexedDB/sync/attendance), plus a baseline test run (section 11). File and line references are to HEAD. Where an audit could not verify something, it is marked **UNVERIFIED** and must be checked before it is relied on. Facts about Supabase itself (limits, third-party-auth behaviour) come from general knowledge, not from this repository, and are marked **VERIFY**: check the current Supabase documentation and pricing page before any phase depends on them.

---

## 0. Executive summary

- The app is **local-first**. Attendance state lives in IndexedDB and works with no network and no Firebase keys. Firebase is used for four things only: sign-in (anonymous + Google), a per-account cloud backup blob (`syncs/{uid}`), the friend/Ping social layer (`users`, `invites`, `requests`, `pings`), and push-token storage (`pushTokens`).
- The hard parts of the migration are **not** the attendance data. They are (1) identity (every `uid` is a Firebase uid, stored in cloud backups, mate rows and ping ids), (2) the Ping state machine, which is enforced entirely by Firestore rules and must be re-created as database logic, and (3) notifications, because the Cloud Functions that send push are written but **not deployed** (project is on Spark; functions need Blaze).
- Recommended strategy, in one paragraph: **move data and backend logic first, keep Firebase Auth as the identity provider until the very end (and possibly forever)**. Put a repository abstraction in front of every Firestore call, run Supabase in shadow behind Firebase, reconcile, then cut over one domain at a time (sync blob first, then friends, then Pings, then notifications). Firebase stays authoritative and usable for rollback until the final cutover is proven. All Ping state transitions become Postgres RPC functions; direct table writes are denied.
- One **open technical risk must be resolved by a spike before Phase 5**: how a Firebase ID token becomes a JWT that Supabase RLS accepts without the Firebase Blaze plan (section 13). Do not commit to the identity bridge until the spike passes.
- Billing constraint (from the owner): no Blaze upgrade, no payment method, Supabase **Free** as destination. The plan is designed to fit that. Limits that matter are listed in section 12.7.

---

## 1. CURRENT ARCHITECTURE (as the code actually is)

```
Browser (Next.js 16 app router, one page: app/page.tsx; React client components)
  │
  ├─ UI components/*            → call handlers in app/page.tsx
  ├─ Domain logic (pure, no I/O)
  │     lib/attendance.ts  lib/scan.ts  lib/merge.ts  lib/backup.ts  lib/backup-import.ts
  │     lib/pings.ts  lib/ping-apply.ts  lib/ping-processing.ts  lib/ping-id.ts  lib/reminders.ts
  │
  ├─ Local persistence (SOURCE OF TRUTH for attendance)
  │     IndexedDB  db "college-tracker" v1, store "kv"  (lib/db.ts)
  │     localStorage  (sync metadata, flags, reminders, ping bookkeeping)
  │     public/sw.js  offline app shell cache  ("shell-v1")
  │
  ├─ Cloud sync (only for a signed-in, NON-anonymous Google account)
  │     hooks/use-cloud-sync.ts  → lib/cloud-sync.ts  → Firestore  syncs/{uid}
  │
  ├─ Social layer (anonymous OR Google uid; created lazily)
  │     lib/use-social.ts  lib/social.ts  lib/social-session.ts  lib/identity.ts  lib/ping-server.ts
  │       → Firebase Auth  (signInAnonymously, linkWithPopup/Credential, signInWithPopup/Redirect)
  │       → Firestore  users, invites, requests, pings, pushTokens   (3 onSnapshot listeners total)
  │
  └─ Push (token registration only works from the client)
        lib/firebase.ts requestFCMToken → getToken(vapidKey, serviceWorkerRegistration='/sw.js')
        lib/social.ts savePushToken → Firestore pushTokens/{uid}

Server side
  Firestore security rules   (firestore.rules)   ← DEPLOYED to production
  Cloud Functions            (functions/*.js)    ← WRITTEN, NOT DEPLOYED (Spark plan)
  Hosting                    Vercel (no firebase hosting block in firebase.json)
```

### Where the real code differs from the usual picture

1. **There is no server of ours** apart from Firestore rules. No API routes in production: the only route, `app/api/dev-sync/[owner]/route.ts`, is a dev-only temp-file store, disabled when `NODE_ENV === "production"`.
2. **Two identity layers share one Firebase uid space.** The anonymous uid is the social identity; the Google account is the sync identity. When a user upgrades anonymous→Google in the same browser (`linkWithPopup`), the uid is **kept**, so mates, pings and sync all share one uid. When the Google account already exists from another device (`credential-already-in-use`), the device switches uid and the friend connections are re-requested (section 6).
3. **The service worker contains no Firebase code.** `public/sw.js` handles the offline shell, `push` and `notificationclick` using only the Web Push API. `getToken` merely registers `/sw.js`. There is no `firebase-messaging-sw.js` (an e2e check asserts it 404s).
4. **Realtime is optional everywhere.** Pull on open/visible/online is the source of truth; `onSnapshot` is an optimisation (`lib/realtime.ts` `resilient()` wraps all three listeners).
5. **Push for Pings does not currently work in production.** Client registration and the service worker handler exist; the senders (`onPingCreated`, `onPingAnswered`) are undeployed. Users see Pings only when they open the app.
6. **Class reminders are local-only and only fire while the app is open** (`hooks/use-notifications.ts`, 30 s interval). No server push exists for reminders or deadlines.
7. **Two "is Firebase configured" checks disagree** (`firebaseConfigured()` needs `MESSAGING_SENDER_ID`; `socialConfigured()` does not).

---

## 2. CURRENT FIREBASE DEPENDENCY MAP

Legend. *Offline?* = required for offline operation (answer is "no" everywhere). *Temp?* = can it remain temporarily during migration. *Delete?* = can it eventually be deleted.

| # | Firebase component | Exact files / functions | Actual purpose | Read / write / listener | Security implications | Supabase replacement | Risk | Temp? | Delete? |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **App init** | `lib/firebase.ts` (`initializeApp`, `getFirestore`; `firebaseConfigured`) | Eager init at import, even without keys | none | Public web config only | Supabase client factory | Low | Yes | Yes, last |
| 2 | **Auth: anonymous** | `lib/social.ts` `ensureSignedIn`, `signInAnonymously`; `social-session.ts` `followIdentity` (`onAuthStateChanged`) | Social identity; created lazily on Mates tab, on `?add=`/`?invite=`, when `socialOn=1`, and implicitly by cloud sync calls | Auth state listener | uid is a capability in QR/link (`?add=<uid>`). Anonymous accounts are per-browser | Supabase anonymous sign-in, **or** keep Firebase Auth (recommended, section 13) | **High** | Yes (recommended: indefinitely) | Only if auth moves |
| 3 | **Auth: Google** | `lib/account.ts` (`signInWithGoogle`, `watchAccount`, `planSwitch`, `confirmSwitch`, `signOutAccount`, `signInDev`); `lib/identity.ts` (`switchToExisting`, `completeCarry`, `signOutOfAccount`, `linkGoogle` (used only by tests)) | Sync identity and upgrade path; account-switch with mate carry-over | Popup/redirect/credential flows | `credential-already-in-use` path deletes old requests and re-requests (data-affecting) | Supabase Google OAuth with identity linking, or keep Firebase | **High** | Yes | Only if auth moves |
| 4 | **Firestore `syncs/{uid}`** | `lib/cloud-sync.ts` `cloudGet` (getDoc), `cloudPut` (runTransaction, CAS on `rev`), `watchCloud` (onSnapshot); orchestrated by `hooks/use-cloud-sync.ts` | Whole-app backup, one gzip+base64 string per Google account | get, transactional put, 1 listener | Highest-value user data; owner-only; no delete | `syncs` table + CAS RPC + Realtime row subscription | **High** | Yes (dual-run) | Yes |
| 5 | **Firestore `users/{uid}`** | `social.ts` `saveProfile` (setDoc), `getProfileName` (getDoc); `identity.ts` `announceProfile` | Display name resolvable by QR/link target | set, get | Readable by any signed-in user | `profiles` table; reads via RPC/view | Low | Yes | Yes |
| 6 | **Firestore `invites/{token}`** | `social.ts` `createInvite`, `readInvite`, `magicLink` | 15-minute magic link | set, get (list denied) | Expiry is **client-checked only**; invites never deleted | `invites` table, access only via RPC `get_invite(token)`, server-side expiry, pg_cron purge | Medium | Yes | Yes |
| 7 | **Firestore `requests/{id}`** | `social.ts` `sendRequest`/`respondToRequest`/`removeRequest`/`watchRequests`; `identity.ts` `allRequests`, `listConnections`, `switchToExisting`, `completeCarry`; `use-social.ts` `connect`, `respond`, `remove` | Friend request; accepted request **is** the friendship | add, update, delete, 1 listener (`participants array-contains uid`) | No uniqueness: duplicate A→B / B→A possible | `connections` table with pair uniqueness | **High** | Yes | Yes |
| 8 | **Firestore `pings/{id}`** | `lib/ping-server.ts` (`createPing`, `answerPing`, `leasePing`, `finalizePing`, `removePing`); `use-social.ts`; `watchPings` | Ping state machine | get, set, update, transaction, delete, 1 listener | All invariants live in rules | `pings` table + RPC state machine | **Critical** | Yes | Yes |
| 9 | **Firestore `pushTokens/{uid}`** | `social.ts` `savePushToken`/`deletePushToken`; `use-social.ts` `registerPingAlerts`; `identity.ts:116,144` delete | One FCM token per account | set, delete | Owner-only. Last device wins | `push_tokens` table (owner RLS; edge function reads with service role). Possibly one row per device | Medium | Yes | Yes |
| 10 | **Firestore rules** | `firestore.rules` (198 lines); tests `tests/rules/*` (64) | The security boundary | n/a | **Cannot be translated mechanically** (section 16) | RLS + constraints + triggers + RPC | **Critical** | Rules stay deployed until retirement | Yes |
| 11 | **Realtime listeners** | `watchRequests`, `watchPings` (`social.ts`), `watchCloud` (`cloud-sync.ts`), all via `lib/realtime.ts` | Live updates | 3 `onSnapshot` | `resilient()` stops retrying on `permission-denied`/`unauthenticated` | Supabase Realtime (Postgres Changes / private Broadcast) + refetch on (re)subscribe | **High** | Yes | Yes |
| 12 | **Cloud Functions** | `functions/index.js`, `pings.js`, `ping-handlers.js`, `ping-messages.js` | `onPingCreated`, `onPingAnswered` (FCM push), `cleanUpPings` (daily, >31 days) | Firestore triggers + scheduler | Admin credentials. **NOT DEPLOYED** (Blaze needed) | Postgres trigger → Edge Function; `pg_cron` for cleanup | Medium | **Never deployed**, so nothing to keep running | Yes |
| 13 | **FCM / push** | `lib/firebase.ts` `requestFCMToken`, `onMessageListener`, `getClientMessaging`; `lib/notifications.ts`; `hooks/use-notifications.ts` (`subscribeToPushNotifications`) | Browser push token; foreground listener | getToken, onMessage | Needs `NEXT_PUBLIC_FIREBASE_VAPID_KEY` (absent from `.env.local`: **UNVERIFIED value, name absent**) | Keep FCM *sending* via HTTP v1 from an Edge Function (no Blaze needed), later optionally standard Web Push | Medium | Yes | Optional |
| 14 | **Service worker** | `public/sw.js` | Offline shell + `push` + `notificationclick` | none (no Firebase) | Must keep payload contract | Unchanged | Low | n/a | n/a (stays) |
| 15 | **API routes** | `app/api/dev-sync/[owner]/route.ts` | Dev-only fake backend (temp file, CAS 404/409) | HTTP | Disabled in production | Reference implementation of the minimal sync contract; delete in cleanup | Low | Yes | Yes |
| 16 | **Firebase config / env** | `lib/firebase.ts` (`NEXT_PUBLIC_FIREBASE_{API_KEY,AUTH_DOMAIN,PROJECT_ID,STORAGE_BUCKET,MESSAGING_SENDER_ID,APP_ID,MEASUREMENT_ID,VAPID_KEY}`), `.env.local.example`, `firebase.json`, `.firebaserc` (`attendance-tracker-2k26`) | Config | n/a | `.env.local` is git-ignored; contains secrets (see 22) | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (publishable) | Low | Yes | Yes |
| 17 | **Firebase emulators / tests** | `firebase.json` emulators (firestore 8080, auth 9099); `npm run test:rules` | Security tests | n/a | These tests are the behavioural spec for the Postgres port | Port to pgTAP / vitest against local Supabase | Medium | Yes | Replace |

**Dead / legacy / vestigial in current code** (do not migrate; remove in Phase 11):
- Foreground FCM toast: `app/page.tsx:147-155` `onMessageListener` expects `payload.notification`; messages are data-only. Never fires; harmless.
- `hooks/use-notifications.ts:105-189` `subscribeToPushNotifications` fetches a token but does **not** save it to `pushTokens` (only the `registerPingAlerts` path saves).
- `lib/identity.ts` `linkGoogle`: no application caller (tests only); `account.ts` has its own link flow.
- `lib/use-social.ts:171` `const configured = true` (dead branch).
- `app/page.tsx` developer tools `testNotificationSetup`, `testFcmToken`.
- `.env.local` leftovers of a removed web-push backend (`NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`, `PUSH_ADMIN_KEY`, `VERCEL_OIDC_TOKEN`).

**Offline:** nothing in this table is required for offline operation. This is the property to protect.

---

## 3. ACTUAL DATA MODEL

`firestore.indexes.json` is empty. Every query is a single-field `array-contains`, so no composite indexes exist. Default rule denies everything else (`firestore.rules:194`). Only these five collections exist.

### 3.1 `users/{uid}`
- **ID:** Firebase uid. **Fields (written):** `name: string` (1..40 by rule), `updatedAt: serverTimestamp` (not validated, never read).
- **Read:** any signed-in user. **Create/update:** only `auth.uid == uid`. **Delete:** none (denied).
- **Authoritative for:** display name shown to others. Local copy is `localStorage.displayName`; profile pushed by `announceProfile` (errors swallowed).
- **Note:** names are copied (snapshotted) into requests/pings; a rename never updates them.

### 3.2 `invites/{token}`
- **ID:** client token, 18 chars from 12 random bytes (`social.ts:107-111`).
- **Fields:** `owner: uid`, `ownerName: string`, `expiresAt: Timestamp` (**client clock**, +15 min), `createdAt: serverTimestamp` (unvalidated).
- **Read:** `get` by any signed-in user; `list` denied. **Create:** `owner == auth.uid` and `expiresAt is timestamp`. **Update:** none. **Delete:** owner.
- **Gaps:** expiry not enforced by rules; invites never deleted by app, rules or any function.

### 3.3 `requests/{requestId}` (friend request; accepted = connection)
- **ID:** Firestore auto-id (20 chars).
- **Fields:** `from`, `to` (uids), `fromName`, `toName` (≤40), `participants: [from, to]` (ordered), `status: pending|accepted|declined`, `createdAt` (unvalidated), `respondedAt` (unvalidated). `FriendRequest` TS type omits both timestamps.
- **Read:** participants. **Create:** `from == auth.uid`, `to != from`, key whitelist, `status == 'pending'`. **Update:** only `to`, only while `pending`, only `status` (to accepted/declined) and `respondedAt`. **Delete:** either participant, any status.
- **Queries:** `participants array-contains uid` (listener, plus one `getDocs` in `identity.ts:43`).
- **Not enforced:** one request per pair; `to` being a real user; timestamps.
- **Lifecycle:** declined is deleted by `connect()` before re-sending. Pending never expires.

### 3.4 `pings/{pingId}`
- **ID:** client-chosen, `^[A-Za-z0-9_-]{8,64}$`, deterministic per (from, to, date, sorted item keys) via `lib/ping-id.ts` until the send is confirmed.
- **Fields:** `from`, `to`, `fromName`, `toName` (≤40), `participants`, `requestId` (an accepted `requests` id), `date` ("YYYY-MM-DD", recent), `items` (1..8) of `{key, subjectId, name(≤60), t?: "HH:MM", answer: null|'yes'|'no'}`, `status: asking|answered|processed`, `createdAt` (**server**, `== request.time`), later `respondedAt`, `claimedBy` (device id), `claimedAt`, `processedAt` (all `== request.time`).
- **Read:** participants. **Create:** asker only (full list in 8). **Update:** three disjoint rules (answer by receiver; lease by asker; finalize by asker). **Delete:** a participant, but not while `answered`.
- **Relationships:** `requestId → requests`. Re-checked (`connected()` via `get()`) on create **and on answer**, so removing a friendship blocks an unanswered Ping.
- **Server clock:** expiry (3 days), lease (2 minutes), `createdAt`, `respondedAt`, `claimedAt`, `processedAt`. Client `isExpired` is advisory.
- **Derived:** `participants` exists only to support the listener and read rule.
- **Not-read-by-audit (UNVERIFIED):** content of `lib/ping-presentation.ts`/`use-ping-events.ts` beyond what the Ping audit reported.

### 3.5 `pushTokens/{uid}`
- **ID:** uid (one per account; last device wins). **Fields:** `token: string` (1..4095), `updatedAt` (unvalidated).
- **Read/delete:** owner. **Create/update:** owner. Functions read/delete with admin credentials (never deployed).
- **Deleted by:** `identity.ts:116` (switch), `identity.ts:144` (sign-out), and the (undeployed) function on dead tokens. *The Ping audit reported "no caller"; that was wrong. Verified by grep.*

### 3.6 `syncs/{uid}`
- **ID:** uid of a **non-anonymous** account only.
- **Fields:** `data: string` (`"gz1:"+base64(gzip(JSON))`, or plain JSON when `CompressionStream` is missing), `rev: number`, `updatedAt: number` (client `Date.now()`, unvalidated).
- **`data` decodes to** `FullBackupData`: `{app:"college-tracker", version:1, exportedAt, data:{subjects, tasks, tags, mates, reminders}}`. **Mates, including `uid`, `coveredPings`, favour counts, are inside this blob, not relational.**
- **Read:** owner. **Create:** owner, `rev == 1`, `data` string `< 900000`. **Update:** owner, `rev == resource.rev + 1`, `< 900000`. **Delete:** denied.
- **Client:** `runTransaction` CAS; client cap `DOC_LIMIT_BYTES = 800_000` using Firestore's own byte accounting (`firestoreDocBytes`).
- **Authoritative:** cloud copy is canonical for sync; each device keeps a base (`syncBase`) for three-way merge. Attendance itself is authoritative **locally**.
- **Compressed size:** about 16 KB per year of marks vs ~470 KB uncompressed (comment in code).

### 3.7 What is NOT in Firestore
Restore points (IndexedDB `restorePoints` only), tasks/subjects outside the sync blob, reminders (localStorage + in blob), presentation state (`pingPresented`), device id.

---

## 4. INDEXEDDB / OFFLINE MODEL

### 4.1 IndexedDB (`lib/db.ts`)
Database `college-tracker`, version 1, one object store `kv`, out-of-line keys, structured-clone values. Falls back to localStorage if IndexedDB is unavailable.

| Key | Content | Written by |
|---|---|---|
| `subjects` | `Subject[]` | `app/page.tsx:159`, `applyDurably` |
| `tasks` | `Task[]` | page.tsx:162 |
| `tags` | `string[]` | page.tsx:165 |
| `mates` | `Mate[]` | page.tsx:168, `applyDurably` |
| `syncBase` | `FullBackupData`, the last **confirmed** cloud copy | `use-cloud-sync.ts:107-117` |
| `restorePoints` | `RestorePoint[]` newest first, **uncapped** | `restore-points.ts:300` |

- Working copy = four separate keys, each written by its own effect on every state change, no debounce, guarded by `loaded && !demoActive` (so empty state cannot overwrite saved data before load).
- `dbSet`: IndexedDB put, falling back to localStorage; if both throw the error is swallowed (no user-visible quota error). `protectStorage()` requests persistent storage.
- **Lazy per-key migration** from localStorage: read IDB, else read legacy localStorage, write to IDB, read back, delete the legacy key only if `JSON.stringify` matches.

### 4.2 Still in localStorage
Sync metadata `syncOwner`, `syncRev`, `syncAt`; reminders `notificationSchedule` (but included in the synced blob); `deviceId`; `displayName`; `socialOn`; `onboardingDone`; theme; `wrappedSeenWeek`; ping bookkeeping `pingSeenIds`, `appliedPings`, `pingPresented`, `pingSendKeys`; `identityCarry`; `demo-pings`, `mock-pings`, `mock-social-store`; `devAccount`.

### 4.3 Sync state machine (backend-agnostic orchestration in `use-cloud-sync.ts`)
- **Push:** debounced 1200 ms after the content fingerprint changes. Skips when no owner, busy, paused (demo), fingerprint equals `lastJson`, or offline. Sends `cloudPut(expectedRev)`. On success: updates `revRef`/`syncRev`, `lastJson`, and **only then** writes `syncBase`. Results: `ok | conflict | unavailable | too-large`.
  - `conflict` → `pull()` → `ingest` → three-way merge.
  - `unavailable` → status offline, retry timer 15 s doubling to 300 s (in memory only). Safe because the retry carries the same `expectedRev`.
  - `too-large` → local data untouched, toast once, retried when data changes.
- **Pull:** `cloudGet` with a 6 s timeout. Triggers: app open (if `syncOwner == account.id`), `visibilitychange`, `online`, realtime event, manual `syncNow`.
- **Pending work is derived, not queued:** `pending = fingerprint(local) !== lastJson`; after restart `lastJson` is rebuilt from `syncBase`. There is no outbox table.
- **First sign-in on a browser:** no cloud doc → put local; cloud doc and empty device → take cloud; both have data → baseless merge (`alignRemote` name matching) then put at `expectedRev = doc.rev`.
- **Sign-out:** clears `syncOwner/Rev/At` and `syncBase`; does not delete device or cloud data.
- **Reconcile:** if conflicts, or the merge would alter unsynced local changes, saves restore points first ("Before merging with your other browser", "Your other browser's copy", "Before a sync update"), then re-merges against current local data.

### 4.4 Three-way merge (`lib/merge.ts`, pure)
`mergeData(base|null, local, remote)`; `pick` (equal → take; one side unchanged → take the other; else conflict, **local wins**). Lists keyed by id; tags as sets; counters as `max(0, base + Δlocal + Δremote)`; `coveredLog/repaidLog` as multisets; subject `log` keyed by `d|t`; `attended`/`missed` re-derived as `effect(mergedLog) + nonLogLocal + nonLogRemote − nonLogBase`; `mergeMate` unions `coveredPings` and subtracts double-applied favours once. Idempotent (merging a merged copy changes nothing).

### 4.5 Restore points
`{id, at, reason, data: FullBackupData}`; skipped when data is empty or identical to the newest point; created before sync merges, before importing a backup, before reset. **No cap**, rewritten in full on every save (growth risk, independent of migration).

### 4.6 Demo-mode isolation
`startDemo` snapshots real state in memory and swaps in `demo-*` data. All four persistence effects, cloud sync (`paused`), and ping application (`applyDurably` returns false) are disabled while demo is active. Closing the tab mid-demo leaves real data untouched.

### 4.7 MUST remain unchanged during migration
`lib/db.ts`, `lib/merge.ts`, `lib/backup.ts`, `lib/backup-import.ts`, `lib/restore-points.ts`, `lib/attendance.ts`, `lib/scan.ts`, `lib/ping-apply.ts`, `lib/ping-processing.ts`, `lib/pings.ts` (constants), `pack`/`unpack`, the `use-cloud-sync.ts` orchestration (it needs only `cloudGet`, `cloudPut`, `watchCloud`, `cloudKind`), the demo-isolation guards, `public/sw.js` offline-shell logic. Only the **adapters** behind these seams change.

The minimal sync backend contract the client needs (from the sync audit, and implemented as the dev route): (1) GET one doc per account → `{data, rev, updatedAt}` or not found; (2) conditional PUT with `expectedRev` (null = create), atomic, returns new rev or conflict; (3) optional change stream (the client already works with polling/catch-up); (4) owner-only access; (5) payload cap mirrored server-side; (6) **no deletes** of the sync row.

---

## 5. ATTENDANCE INVARIANTS (must not change)

All in `lib/attendance.ts`, `lib/types.ts`, `lib/scan.ts`; pinned by `daily-value`, `today-classes`, `subjects-nav`, `scan`, `merge`, `sync-safety`, `backup`, `timetable-import` tests.

1. **Mark identity:** one class = one `(date, start time)` per subject. Untimed mark has `t = ""` and is stored without `t`. `markFor` returns the status of the **last** matching log entry.
2. **`withSet(s, date, status|null, meta?)`:** no-op if status unchanged (double tap changes nothing); otherwise removes the last matching entry, decrements the old counter (clamped at 0), increments the new one, appends `{d,s,t?,k?,by?}` unless clearing. P→A moves the count. Log trimmed with `slice(-400)` (array order, not date order). **Counters are adjusted incrementally and are authoritative; they are not recomputed from the log.**
3. **Exact undo:** `markWithUndo` captures the previous entry for that class; undo restores exactly that class (including `k` and `by`) or removes it. Other classes untouched.
4. **Percentage:** `total = attended + missed`; `pct = round(attended/total*100)`; `total == 0` → status `new`, no percentage shown. Risk is decided on the **rounded** pct vs `requirement`.
5. **Status/skips:** `risk` (pct < req): `canSkip = 0`, `needed = max(1, ceil((r*total − attended)/(1−r) − 1e-9))` (null when r ≥ 1). Otherwise `canSkip = floor((attended − r*total)/r + 1e-9)` (null when r ≤ 0); `canSkip == 0` → `edge`. Epsilons are part of the contract.
6. **Skip verdict:** `nodata` / `skip` / `attend`, labels `NO MARKS YET`, `SAFE TO SKIP`, `ATTEND TO REACH TARGET`, `MUST ATTEND`.
7. **Past-day correction:** any date can be marked/cleared; counts and verdict move accordingly.
8. **Timetable-aware marking:** `classesOn` lists `(subject, slot)` where `slot.day == date.getDay()`, deduped by `subject.id@start`, sorted by start. Today and Subject Detail write the same record via `slotMeta`. Legacy untimed marks are preserved and never removed by marking a real class.
9. **Scan:** tiers in progress → just ended (20 min) → starting soon (15 min); never marks twice; always marks Present; scan marks made this visit are re-applied if a synced copy arrives without them.
10. **Caps:** only the 400-entry log cap. No cap on subjects, tasks, mates, `coveredLog`, `repaidLog`, `coveredPings`, restore points.
11. **Dates** are local-time strings (`localDate`, `parseLocalDate`), never UTC-parsed.
12. **Favours:** `by` on a log entry stores the mate's **name** (display text only).

**The migration must not touch any of this.** Postgres never sees an attendance mark; it stores the opaque sync blob.

---

## 6. IDENTITY MODEL

### 6.1 Lifecycle (as implemented)
- **Anonymous uid** (`signInAnonymously`) created lazily: Mates tab opened; `?add=`/`?invite=` link; `localStorage.socialOn === "1"` at startup; or implicitly by `cloudGet/cloudPut/watchCloud` (`ensureSignedIn`). One in-flight promise (`signingIn`) prevents double sign-in.
- **Google sign-in** (`account.ts signInWithGoogle`): with an anonymous current user uses `linkWithPopup` (**uid preserved**); no user → `signInWithPopup`; popup blocked → redirect fallback.
- **Account collision (`auth/credential-already-in-use`):** `planSwitch` lists accepted connections of the old uid; if any, asks the user to confirm; `switchToExisting`:
  1. `saveCarry` → `localStorage.identityCarry = {from, mates:[{uid,name,requestId}]}`
  2. delete the old accepted requests
  3. delete the old push token
  4. `signInWithCredential` → the Google account's existing uid
  5. `announceProfile`
  6. `completeCarry` → new `pending` requests to each carried mate (stops at first failure, keeps the carry for retry)
  Mates must accept again. **Old pings are orphaned** (deleted at 30 days).
- **Redirect return:** `getRedirectResult` in `watchAccount`; on failure `finishExisting` switches **without asking**.
- **Sign-out** (`signOutOfAccount`): delete push token, `signOut`. `followIdentity` clears requests/pings. Next Mates visit creates a **new** anonymous uid.
- **Reset all data** (`handleResetAllData`): saves a "Before reset" restore point, clears state, `sync.signOut()`, removes listed localStorage keys, `dbDel` on `subjects/tasks/tags/mates/syncBase`. **Does not clear** `displayName`, `socialOn`, `syncOwner`, `syncRev`, `syncAt`, `identityCarry`, `deviceId`, the mock store, `restorePoints`, nor Firebase's own auth persistence.
- **Social session** (`followIdentity`): reacts to uid **changes** only (same uid → no-op); on change detaches listeners, clears state, `onIdentity`, re-attaches; `mine()` guard drops late callbacks.

### 6.2 Friend-facing name
`localStorage.displayName` (≤40) → `users/{uid}.name` → copied into `requests.fromName/toName` and `pings.fromName/toName`. Device-local: a second device must set it.

### 6.3 QR / link exchange
- Permanent: `/?add=<uid>`. **The uid is the capability**; anyone signed in who has the link can send a request.
- Magic: `/?invite=<token>` (15 min, client-enforced expiry).
- `app/page.tsx:172-211` parses, strips the param with `replaceState`, waits for sign-in and a display name, then `connectViaUid`/`connectViaInvite`.

### 6.4 EVERY place a uid is persisted or assumed
**localStorage:** `identityCarry`; `syncOwner`; `devAccount`; `mock-social-store` (uid `mock-<uuid>`); `mock-pings`, `demo-pings`; `pingSendKeys` (logical keys embed uids); `pingSeenIds`, `appliedPings`, `pingPresented` (ping ids).
**IndexedDB:** `mates[].uid`; `syncBase` (contains mates); every `restorePoints[].data` (contains mates).
**Inside the cloud blob:** `mates[].uid` in every backup. After an account switch, old backups can hold stale uids (repaired by `adoptConnections`).
**Firebase's own storage:** Auth session in IndexedDB (`firebaseLocalStorageDb`); no explicit `setPersistence`.
**Server:** `users/{uid}`, `requests.from/to/participants`, `pings.from/to/participants`, `pushTokens/{uid}`, `syncs/{uid}`.
**Assumed in code:** `uid.startsWith("mock-")` (`app/page.tsx:206`), `id.startsWith("demo-")`, ids `demo-me`/`demo-mate`; `syncOwner === account.id`; `watchCloud/cloudGet/cloudPut` call `ensureSignedIn()` but never check the signed-in uid equals `owner` (security relies on rules).

**Consequence for migration:** the Firebase uid is baked into user-owned data (cloud blobs, local mate rows, restore points). Changing user ids would require rewriting data on every device. This is the central reason for section 13's recommendation.

### 6.5 Multi-device
Same Google account ⇒ same uid on all devices ⇒ shared requests, pings, token row (one token: last device wins, so other devices get no alerts). Anonymous accounts are per browser. `deviceId` (random, `lib/device.ts`) is the lease identity, **not** a uid.

---

## 7. FRIEND SYSTEM

- **Model:** an accepted `requests` doc between two uids **is** the friendship. No separate edge collection. Local mirror: `Mate[]` (IndexedDB `mates`, also in the sync blob) with ledger fields `covered`, `repaid`, `coveredLog`, `repaidLog`, `coveredPings`. Mates can also exist **without** a uid (added by name, never connected).
- **Create:** QR/`?add=` → `connect(uid)`; invite → `connect(owner, ownerName)`. `connect` consults the **local** snapshot `reqs.current`: accepted → "already connected"; pending toward me → auto-accept; pending from me → "already waiting"; declined → delete and re-send; none → `getProfileName` must exist ("That code isn't valid.") then `addDoc`.
- **Accept/decline:** `respondToRequest` (receiver only, pending only).
- **Remove:** accepted request deleted; sent pending pings to that mate cancelled; local mate removed with a few-second undo. **Undo restores only the local row; the deleted request is not restored.**
- **Connection id:** random request doc id; pings carry it as `requestId`.
- **Listeners:** `watchRequests` (1). Created once per identity by `followIdentity`; torn down on identity change; **never torn down when leaving the Mates page**.
- **Stale/ghost state:** a mate whose connection disappeared shows "NOT CONNECTED" (derived in `mates-view.tsx:391-392`); not auto-removed. Declined/pending requests and invites accumulate. Possible duplicate requests (A→B and B→A) from a race; `sendPing` picks the first accepted request.
- **Multi-device:** shared uid ⇒ shared requests; ledger shared via sync blob.

### Anything keyed by display name instead of stable identity (migration hazards)
| Place | Behaviour |
|---|---|
| `identity.ts:156-169` `adoptConnections` | Re-points a mate row to a new uid by normalised name (`trim().toLowerCase()`). Two mates with the same name collide. |
| `ping-apply.ts:36-40,106` | Finds the mate by `uid`, else an unconnected row with the same `toName`, else creates one. |
| `merge.ts:240` `alignRemote` | Baseless merge matches mates by id, uid **or name**; the name clause has no uid guard. |
| `mates-view.tsx:308,614` | `pingStatus` / waiting list match `p.to === uid` **or** `p.toName === name`. |
| `app/page.tsx:845` | Remove flow cancels pings with `p.to === m.uid || p.toName === m.name`. |
| `LogEntry.by` | Stores the mate's **name** in subject logs (display only; fine). |

These must keep working with Supabase and must not be "fixed" during migration; fixing them is separate scope.

---

## 8. PING STATE MACHINE (actual implementation)

### 8.1 States and transitions
`asking → answered → processed`. Expiry is **derived** (3 days from server `createdAt`), never stored. An unanswered, expired Ping stays `asking` until deleted. `processed` is final (no rule leaves it).

| Transition | Actor | Where | Enforced by |
|---|---|---|---|
| create (`asking`) | asker (`from`) | `createPing` (ping-server.ts:40-64) | rules 107-126 |
| answer (`asking→answered`) | receiver (`to`) | `answerPing` (:67-68) | rules 129-140 |
| lease | asker, `answered` | `leasePing` (:75-92) transaction | rules 143-153 |
| finalize (`answered→processed`) | asker | `finalizePing` (:95-107) | rules 156-161 |
| delete | either participant, not while `answered` | `removePing` | rules 164-166 |

### 8.2 Document and item structure
See 3.4. Constants: `MAX_PING_ITEMS = 8` (`lib/pings.ts:38`; the cap exists only because of Firestore's 1000-expression rule limit), `LEASE_MS = 120000`, expiry 3 days, `PING_HISTORY_DAYS = 30` (asker-side client prune; the undeployed function prunes at 31).

### 8.3 Security invariants (rules, as deployed)
1. Only participants can read.
2. Only the asker creates; `from == auth.uid`; `to != from`; `participants == [from,to]`.
3. A Ping names an **accepted** request containing exactly these two people (`connected()` via `get()`); re-checked on answer.
4. `createdAt == request.time` (server clock); `date` within `[now−3d, now+1d]`; id matches `^[A-Za-z0-9_-]{8,64}$`; key whitelist; 1..8 items; each item whitelisted keys, `answer == null`, `name ≤ 60`, `key`/`subjectId` strings.
5. Only the receiver answers, only while `asking`, only before `createdAt + 3d`, only if `createdAt <= request.time` and `items.size() <= 8` (the two legacy-safety conditions added in the last rules change). Only `items[i].answer ∈ {yes,no}`, `status`, `respondedAt == request.time` may change; item count and everything else frozen.
6. Only the asker leases, only while `answered`; only `claimedBy`, `claimedAt == request.time`; allowed if no lease, same `claimedBy` (renew), or `claimedAt + 2 min <= request.time`; `claimedBy` matches `^[A-Za-z0-9_-]{8,64}$`.
7. Only the asker finalizes, only from `answered`; only `status`, `processedAt == request.time`.
8. An `answered` Ping cannot be deleted by any client (a result is never thrown away unapplied). Default deny elsewhere.

### 8.4 Exactly-once processing (client, `lib/ping-processing.ts`)
Order is the invariant: **(1) lease → (2) apply to IndexedDB and read back to verify (`resultIsSaved`) → (3) finalize.** A Ping is never `processed` before its result is durably applied locally. Outcomes `processed | not-leased | lease-failed | apply-failed | finalize-failed | busy`; in-memory `running` set prevents concurrent runs per id in one tab; retry on change, mount (crash recovery) and `online`; backoff 15 s → 5 min; `not-leased` retried after `LEASE_MS + 10 s`. Demo mode never processes.

### 8.5 Apply rules (`lib/ping-apply.ts`)
`yes` on Absent/unmarked → mark `P` with `by: toName`, one favour id `"${date}|${pingId}:${itemKey}"`; `yes` on already-Present → no change, no favour; subject deleted or slot (`item.t`) gone → skipped, no favour; favour id already in `Mate.coveredPings` → skipped; `no` → nothing. Mate located by `uid`, else same-name unconnected row (adopts uid), else new row. Favour: `covered += n`, `coveredLog` gets the date, `coveredPings` gets the id.

### 8.6 Idempotency and retry layers
Client-chosen deterministic id (`ping-id.ts`, `pingSendKeys` 24 h); concurrent-tap dedupe (`sending` map); `createPing` on `permission-denied` reads the existing doc and returns `"existing"` if same from/to/date/requestId/item keys; offline `attempt()` returns immediately (**nothing is queued; create and answer need the network**); 10 s timeout reports "not confirmed" (id retained, retry safe); `coveredPings` + `mergeMate` correction for two devices that both applied one Ping; `finalizePing` `permission-denied` → read → `"already"`.

### 8.7 Presentation state vs business state
Separate. Business = Firestore `status`. Presentation = `lib/ping-presentation.ts` + `lib/use-ping-events.ts`, stored in `localStorage.pingPresented` (60-day prune): one overlay at a time (incoming first, then results); notification `focusId` first; "Later" defers for this visit. A `processed` Ping can still have an unseen result. UI: `ping-event.tsx`, `ping-sheet.tsx` (max 8), `mates-view.tsx`.

### 8.8 Notification payload and deep link
`/?ping=<id>` handled by `use-ping-events.ts:52-73` (strips param, sets `focusId`, `social.enable()`, `resolveFocus` toasts for missing/answered/expired/seen with a 6 s grace). SW posts `{type:'open-ping', id}` to an open client. Push payload in 10.

### 8.9 Two-device behaviour
Only the asker's devices process; the lease serializes them; the second device gets `not-leased` and retries after lease expiry; a crashed device's lease expires after 2 min (same device renews immediately on reload). Receiver's second device cannot answer an already-answered Ping (first wins). Presentation is per device.

### 8.10 Crash windows
1. After lease, before apply: still `answered`; same device renews instantly, other after 2 min.
2. **Mid-apply: subjects and mates are two separate IndexedDB writes (`Promise.all`, not one transaction).** If subjects saved but mates not, a rerun sees the class already Present → `already-present` skip → **no favour and no `coveredPings` entry; the favour can be lost** (narrow window). Pre-existing defect; **do not fix during migration**, but record it and keep the behaviour test.
3. Saved but finalize failed: still `answered`; rerun skips via `coveredPings`, verifies, finalizes.
4. Finalize landed but app never heard: finalize returns `"already"`.
5. Cloud-sync merge during any of this: `mergeMate` dedupes.
6. Asker never reopens the app: Ping sits `answered` indefinitely (only the undeployed function or admin could remove it).

---

## 9. REALTIME MODEL

Exactly three `onSnapshot` call sites, all wrapped by `resilient()` (`lib/realtime.ts`): backoff 3 s doubling to 120 s cap, reset on `ok`; **hopeless** (`permission-denied`, `unauthenticated`) is never retried; `stop()` before every reschedule so one wrapper can't double-listen; disposer sets `dead`.

| Listener | Source / filter | Scope | Purpose | Lifecycle |
|---|---|---|---|---|
| `watchRequests(uid)` `social.ts:73-89` | `requests where participants array-contains uid` | all my requests, any status | request lists, "connected" state, favour-ledger sync (`page.tsx:214-228`), `requestId` for Pings | attached by `followIdentity` per uid; never torn down when leaving Mates |
| `watchPings(uid)` `social.ts:138-154` | `pings where participants array-contains uid` | all my pings sent/received (up to 30 days of history) | lists, processing pipeline, events/badges | same |
| `watchCloud(owner)` `cloud-sync.ts:122-152` | doc `syncs/{owner}` | one doc | other-device changes | effect deps `[ready, accountId, paused, ingest]`; torn down on account change, demo pause, unmount |

- **Auth transitions:** `followIdentity` ignores same-uid events (anonymous→Google link keeps listeners); uid change detaches all, clears state, re-attaches. Sign-out clears and does not re-attach.
- **Gap:** after a hopeless error the listener does not restart until the identity changes.
- **Duplicate prevention:** `started` ref per hook instance; `useSocial()` is instantiated **once** (`app/page.tsx:110`); `watchCloud` has `gone` flag and `ownerRef` check; `ingest` ignores `rev <= revRef` (own echoes) and defers while `busy` (`missedRef`).
- **Reconnect:** `online` → if realtime live, only push; else `syncNow`; `visibilitychange` → pull; reload → pull. Firestore snapshots deliver full state on (re)attach.
- **Dev:** `cloudKind()==="dev"` polls `/api/dev-sync` every 15 s.

**Supabase implication:** Postgres Changes does **not** replay missed events and has filtering limits (one filter per subscription; DELETE events cannot be filtered per row). Every Supabase listener must **refetch the full scoped set on every (re)subscribe** to match Firestore's snapshot semantics.

---

## 10. NOTIFICATION MODEL (what actually remains)

| System | Status | Trigger | Sender | Payload | Foreground | Background |
|---|---|---|---|---|---|---|
| **A. In-app Ping overlay + Mates badge** | **PRODUCTION** | Firestore listener delivers a Ping | the client itself | n/a | `PingEventView`, badge `app/page.tsx:857,929-937` | none (works only when app is open) |
| **B. Local class reminders** | **PRODUCTION, app-open only** | 30 s interval + visibilitychange; fires 0..10 min late (`GRACE_MIN`); dedupe `remindersFired {date,ids}` | `hooks/use-notifications.ts` via `registration.showNotification` (else `new Notification`) | title "Class Reminder", body "subject / time / Tap to open the app.", `data.url = origin` | yes | **No.** SW has no timers/periodic sync |
| **C. Ping push via Cloud Functions** | **WRITTEN, NOT DEPLOYED** | `onPingCreated` → to `ping.to`; `onPingAnswered` on `asking→answered` only → to `after.from` | `functions/pings.js` (admin, FCM) | data-only: `{type:'ping', event:'incoming'|'result', pingId, tag:'ping-<id>', title, body, url:'/?ping=<id>'}`, `webpush.headers {Urgency:'high', TTL:'259200'}` | suppressed by SW if a window is visible | SW `push` handler shows it |
| **D. Service worker push + click** | **SHIPPED, effective only if pushes arrive** | `push`, `notificationclick` | `public/sw.js:77-149` | reads `payload.data` (also `payload.notification`/top-level) | `type:'ping'` suppressed if any client `visible` | `showNotification`, `tag`, icon `/favicon-192.png`; click: same-origin `safeUrl`, focus + `postMessage open-ping`, else `openWindow(url)` |
| **E. Foreground FCM listener** | **DEAD** | `onMessage` | n/a | expects `payload.notification` | never fires | n/a |
| **F. Legacy `subscribeToPushNotifications` and dev tools** | **DEAD / dev-only** | n/a | n/a | n/a | n/a | n/a |
| **G. `cleanUpPings` scheduler** | **WRITTEN, NOT DEPLOYED** | daily, Asia/Kolkata | functions | deletes `date < now−31d`, ≤400/run | n/a | n/a |

Details:
- **Registration:** `registerPingAlerts(uid, ask)` (`use-social.ts:36-47`) → permission (asks only if `ask`) → `requestFCMToken()` (`getToken(vapidKey, serviceWorkerRegistration)`) → `savePushToken`. Triggered on identity change (silent unless already granted), after the first successful `sendPing`, and by the "Get an alert when mates Ping you" button. Failures swallowed. **One token per uid; last device wins.**
- **Expiry:** push TTL 3 days (= Ping lifetime). **Deduplication:** `tag ping-<id>` collapses on the device; no server dedupe.
- **Failure handling (functions):** no token → `'no-token'`; `registration-token-not-registered`/`invalid-registration-token` → delete the token; other errors logged, no retry.
- **Reality check on Spark:** A, B, D-offline-shell work. C, G do not. **UNVERIFIED:** the SW's parsing of a real FCM web-push envelope (`payload.data`) has never been exercised against real FCM (`tests/ping-push.test.ts` uses fakes). The planned two-device FCM test is the first real proof.
- **What breaks without Functions:** background alerts only. Correctness and exactly-once processing are entirely client-side and are **not** affected.

---

## 11. EXISTING TEST BASELINE (measured, unmodified tests)

Run at HEAD `3644948`, clean tree, on Windows, Node via repo tooling. Nothing was edited to obtain these.

| Suite | Command | Result |
|---|---|---|
| Unit | `npx vitest run` | **15 files, 177 tests, all pass** |
| Firestore rules (emulator) | `npm run test:rules` | **4 files, 64 tests, all pass** (identity 9, legacy-compat 15, pings 35, processing 5) |
| Typecheck | `npx tsc --noEmit` | **clean (exit 0)** |
| Lint | `npm run lint` | **0 errors, 75 warnings** (pre-existing; mostly `react-hooks/*`) |
| Build | `npm run build` (Firebase env blanked) | **passes**; routes `/`, `/_not-found`, `/api/dev-sync/[owner]` |
| E2E ping | `scripts/e2e-ping.mjs` | **40/40** |
| E2E ping-reliability | `scripts/e2e-ping-reliability.mjs` | **20/20** |
| E2E nav | `scripts/e2e-nav.mjs` | **35/35** |
| E2E value | `scripts/e2e-value.mjs` | **32/32** |
| E2E today | `scripts/e2e-today.mjs` | **38/38** |
| E2E cleanup | `scripts/e2e-cleanup.mjs` | **27/27** |
| E2E sync | `scripts/e2e-sync.mjs` | **11/11** |
| **E2E total** | | **203 checks, all pass** |

Ping-related unit files: `ping-apply`, `ping-events`, `ping-id`, `ping-processing`, `ping-push`, `wrapped-and-pings` (89 tests matching `ping`). Sync-related: `merge`, `sync-safety`, `realtime-and-pack`, `backup`.

Notes, reported honestly:
1. **Flaky test identified:** `tests/rules/identity.test.ts` › "keeps the same id, the same mates and the same listeners, and Pings still work both ways" failed **once** in one earlier run (listener timeout; a gRPC `RESOURCE_EXHAUSTED "Received message larger than max"` was logged by the Firestore client) and passed on every other run (5+ consecutive full runs green). Treat it as flaky around listener teardown in the emulator. It must **not** be weakened or deleted; fix its isolation in Phase 1.
2. **E2E gap:** the seven e2e scripts live in `scripts/` but **`puppeteer-core` is not in `package.json`** (no devDependency, no npm script). They were run from a separate scratch folder that has it installed. Chrome path is hard-coded (`C:/Program Files/Google/Chrome/Application/chrome.exe`, overridable by `CHROME`/`BASE`). They need a dev server on port 3458 with Firebase env keys blanked. This is **not yet reproducible from a clean checkout**: the first Phase 1 task.
3. The emulator tests need a Java runtime (the machine had none on PATH; a portable JRE was used from the session scratch area).
4. The e2e suites exercise **local/mock social mode only** (no Firebase keys). **Real Firestore delivery, real FCM, and real two-device sync are not covered by any automated test.**
5. Lint warnings are included in the baseline so Phase 1 can detect regression (75).
6. `identity.test.ts` and `legacy-compat.test.ts` were both authored in the last phase; the 64 count includes them.

---

## 12. SUPABASE TARGET ARCHITECTURE

### 12.1 Principles
1. IndexedDB stays the local-first source of truth. The backend remains a sync/social service, never required for marking attendance.
2. Do **not** copy Firestore shape. Re-model by access pattern, then keep client-visible contracts (types, ids, payloads) identical so the domain code does not change.
3. Authorization lives in the database (RLS + RPC), not in the client. **Clients get SELECT on their own rows only; every mutation of social state goes through a `SECURITY DEFINER` RPC** with a pinned `search_path`. This replaces Firestore's per-document rules, which cannot be expressed as RLS (section 16).
4. User ids are **`text`** (Firebase uids are 28-char strings, not UUIDs).
5. Time is the database clock (`now()`), never the client's.

### 12.2 Relational model

> **Amended by `MIGRATION_DECISIONS.md` (decisions 2a, 2b, 3):** `pings.class_date` is stored as text, not `date`; there is **no foreign key** from a Ping to `connections` (legacy Pings can reference removed or duplicate requests); legacy rows carry `legacy` and `legacy_flags` and nullable `created_at`; strict limits (8 items, name lengths, date window) are enforced by the create and answer RPCs rather than table `CHECK`s; add `legacy_requests`, `connection_aliases` and `quarantined_records`; `push_tokens` is keyed by `(uid, device_id)`. User ids are `text` and policies read `auth.jwt()->>'sub'`, never `auth.uid()`.

```
profiles        (uid text PK, name text CHECK(1..40), updated_at timestamptz)
invites         (token text PK, owner text, owner_name text, expires_at timestamptz, created_at timestamptz)
connections     (id text PK, from_uid text, to_uid text, from_name text, to_name text,
                 status text CHECK in (pending,accepted,declined), created_at, responded_at,
                 CHECK (from_uid <> to_uid),
                 UNIQUE INDEX on (least(from_uid,to_uid), greatest(from_uid,to_uid)) WHERE status in ('pending','accepted'))
pings           (id text PK CHECK ~ '^[A-Za-z0-9_-]{8,64}$',
                 from_uid text, to_uid text, from_name, to_name,
                 connection_id text REFERENCES connections(id),
                 class_date date, items jsonb CHECK (jsonb_typeof='array' AND length BETWEEN 1 AND 8),
                 status text, created_at timestamptz DEFAULT now(),
                 responded_at, claimed_by text, claimed_at, processed_at)
push_tokens     (uid text PK, token text CHECK(length 1..4095), updated_at)
syncs           (uid text PK, data text, rev integer, updated_at bigint)
shadow_mismatch (id bigserial, at, domain, key, detail jsonb)     -- migration-only, dropped at the end
```

Decisions, with reasons:
- **`connections` replaces `requests`** (same ids preserved on import so existing `Ping.requestId` values stay valid). The pair-uniqueness index closes the A→B / B→A duplicate race that the rules never prevented. *Behaviour note:* the client's declined-then-resend flow deletes the declined row first, so a partial unique index (pending/accepted only) preserves it.
- **`participants` is dropped** (derived). Membership is `from_uid = me OR to_uid = me`.
- **`items` stays `jsonb`** (not a child table): the client reads/writes the whole array and types (`PingItem`) are unchanged; a trigger validates shape and immutability. The cap of 8 is kept as a `CHECK` (it is a product constant now, not an engine limit; lifting it is a separate, later decision).
- **`class_date` as `date`**, validated in SQL with an explicit UTC window equivalent to `dayIsRecent` (`[now−3d, now+1d]`).
- **`syncs.data` stays an opaque text blob** in exactly the existing `gz1:`/plain format. Do not normalise attendance into tables: that would change merge semantics and is the highest data-loss risk in the project. ~16 KB/user/year keeps Free-tier storage trivial.
- **`profiles` readable only through an RPC** (`get_profile_name(uid)`), not `SELECT` for everyone, to avoid exposing a name directory.
- **No `restore_points` table.** They are local-only today and stay that way.

### 12.3 Operations by mechanism
- **Ordinary table reads (RLS `SELECT`):** `connections`, `pings` (participants), own `push_tokens`, own `syncs`.
- **RPC (`SECURITY DEFINER`):** `upsert_profile`, `get_profile_name`, `create_invite`, `get_invite`, `send_request`, `respond_request`, `remove_request`, `create_ping`, `answer_ping`, `lease_ping`, `finalize_ping`, `remove_ping`, `sync_get`, `sync_put(expected_rev, data)`, `save_push_token`, `delete_push_token`.
- **Constraints/triggers:** id pattern, status enum, item count, name lengths, immutability of `from_uid/to_uid/class_date/items[*].(key,subjectId,name,t)` after create, server-assigned timestamps, `BEFORE UPDATE` state-machine guard as defence in depth against any future direct-write grant.
- **Edge Functions:** push sending; invite/token bridge if needed (section 13); reconciliation endpoints.
- **`pg_cron` (free):** purge expired invites; purge pings older than 31 days; purge stale declined/pending requests (if product agrees). Replaces `cleanUpPings`.

### 12.4 Realtime
Prefer **Postgres Changes** on `connections` and `pings` and `syncs` with RLS, using **two subscriptions** where filters are limited (`from_uid=eq.<me>` and `to_uid=eq.<me>`), plus a **mandatory refetch on every (re)subscribe and every `online`/`visibilitychange`**. The existing `resilient()` wrapper and "realtime is a nicety" design already match this. If Postgres Changes proves unreliable on Free, fall back to **private Broadcast channels fed by a DB trigger** with per-user topics. Keep the existing 15 s polling as the guaranteed floor for the sync doc.

### 12.5 Local-first layer
Unchanged. The only new code is a `SyncStore`/`SocialStore`/`PingStore` interface (Phase 4) with a Firebase implementation (existing) and a Supabase implementation (new).

### 12.6 Hosting
App stays on Vercel. Supabase adds only network endpoints; `public/sw.js` does not intercept cross-origin requests, so the offline shell is unaffected. **Do not** place any Supabase-facing route under a path the service worker caches (`/_next/static/`, icons/manifest/`.json`), and keep it out of `/api/` unless intended (SW skips `/api/`).

### 12.7 Free-tier limits to check (VERIFY at the time; do not trust these numbers)
Database size (500 MB class), Realtime concurrent connections and message rate, Edge Function invocations and execution time, `pg_cron` / `pg_net` availability on Free, **inactivity pause of Free projects** (a project can be paused after a period of no activity; **this directly threatens the "app works for everyone, always" goal and must be mitigated, e.g. a scheduled keep-alive**), third-party-auth MAU limits, bandwidth, no point-in-time recovery on Free (so take your own exports before every risky step).

---

## 13. IDENTITY MIGRATION STRATEGY

### Options compared

**A. Keep Firebase Auth temporarily (recommended: possibly permanently) while moving data and backend.**
- Uids unchanged ⇒ every `mates[].uid` in cloud blobs, local rows and restore points stays valid; `syncs/{uid}` keys unchanged; ping ids, `identityCarry`, QR links all remain valid.
- Firebase Auth anonymous and Google sign-in are free on Spark. No Blaze needed.
- Supabase accepts Firebase as a third-party auth provider (JWT verified against Firebase's JWKS; the Firebase uid appears as the JWT `sub`) — **VERIFY**.
- **Open problem (must be spiked):** Supabase RLS needs the JWT to carry `role = authenticated`. Firebase ID tokens do not include it by default. Documented ways to add it are Firebase blocking functions (**requires Identity Platform upgrade, which means Blaze: not allowed**) or setting a custom claim via the Admin SDK (requires something trusted to call it). Two bridge candidates that avoid Blaze:
  1. **Claim bootstrap Edge Function:** client sends its Firebase ID token to an Edge Function; the function verifies it, calls the Firebase Auth Admin REST API (service account stored as a Supabase secret) to set `role: authenticated` as a custom claim, client force-refreshes its ID token. One-time per uid.
  2. **Token exchange Edge Function:** verifies the Firebase ID token and mints a short-lived Supabase-compatible JWT (`sub` = Firebase uid, `role` = authenticated) that the Supabase client uses as its access token. Depends on what signing-key options the project supports — **VERIFY**.
- Either way the app is not billed beyond Free and no identity is rewritten.
- Cost: Firebase remains a runtime dependency (Auth only), and a small bridge component must be maintained.

**B. Move Auth and database together.**
- Cleanest end state (single vendor), but changes account identity, storage, realtime, Ping and notifications **simultaneously**. Every user's uid changes, so all `mates[].uid` in every cloud blob, every device's local mates, restore points and in-flight pings need rewriting, device by device, including offline devices. Anonymous accounts (per-browser, no email) **cannot be migrated across vendors at all**; those users would silently lose their friend connections. High probability of identity split and silent data loss.

**C. Other safer bridge.** A hybrid of A where the bridge is purely a stateless token exchange (A.2) is the only variant supported by this codebase; there is no other persistent identity to bridge from.

### Recommendation: **Option A**
Keep Firebase Auth as the identity provider; make Supabase trust Firebase tokens via a small Edge Function bridge; migrate **data and logic first**. Reasons specific to this repo: the uid is stored inside user-owned data on devices we cannot reach; anonymous users have no portable credential; and the project rule is to avoid changing identity, storage, realtime, Ping and notifications at once. Decide in the **Phase 5 spike** between bridge 1 and 2. **If neither works on Free, stop and escalate** (the fallback is accept a Blaze billing account solely for Firebase Auth blocking functions, or delay the migration); do **not** silently fall back to Option B.

Re-evaluate moving Auth only after Supabase has been authoritative and stable for a long time. It is optional, and the bridge can remain indefinitely.

---

## 14. DATA MIGRATION STRATEGY

**Scope of data:** `users`, `invites`, `requests`, `pings`, `pushTokens`, `syncs`. Everything else is device-local and not migrated.

1. **Export (user runs in terminal):** a one-off Node script using the Firebase Admin SDK and a service-account key (kept out of git) streams each collection to NDJSON. Read-only against Firebase; the Spark read quota is ample for this app's size. Capture an export timestamp and per-collection doc counts.
2. **Transform (pure, unit-tested):** Firestore `Timestamp` → `timestamptz`; `participants` dropped; `date` → `date`; `requests` → `connections` keeping the same ids; `pings.requestId` → `connection_id`; names copied verbatim; `syncs.data/rev/updatedAt` copied **byte-for-byte** (never decompress and recompress); `pushTokens` copied. Rows failing validation go to a reject file, never dropped silently.
3. **Validate before import:** counts per collection; referential integrity (every `pings.requestId` exists); constraint checks; for `syncs`, decode `gz1:` and verify `parseFullBackup` accepts it, and compare a SHA-256 of `data` source vs target.
4. **Import (service role, idempotent):** `INSERT … ON CONFLICT (id) DO UPDATE` only while Supabase is non-authoritative. Safe to re-run. **Never import into an authoritative Supabase** (it would overwrite newer writes).
5. **Reconciliation:** a repeatable script compares per-key hashes Firebase↔Supabase for `syncs` (uid, rev, data hash), and field-by-field for the other collections; output is a report plus rows in `shadow_mismatch`.
6. **Duplicate prevention:** all ids are preserved (never regenerated); ping ids are the client-chosen deterministic ids; `INSERT … ON CONFLICT DO NOTHING` on create paths.
7. **Preserving existing users:** same uids (Option A), same request ids, same ping ids, same blob bytes, same `rev`. Because `rev` is preserved, a client's stored `syncRev` still matches; if it ever does not, the existing `conflict → pull → three-way merge` path handles it safely.
8. **In-flight state at cutover:** `asking` Pings migrate as-is; `answered` Pings migrate with `claimed_by/claimed_at` **cleared** (leases are short and a cleared lease only means the asker re-leases). Never migrate a half-finalized transition: freeze writes (maintenance window or ordered cutover per domain, section 19), take a final delta export, import, reconcile, flip.
9. **Rollback:** Supabase is a **copy** until cutover, so rolling back is "flip the flag back to Firebase". Keep the export files and a pre-cutover Firebase export.

---

## 15. DUAL-RUN / SHADOW STRATEGY

Firebase remains authoritative the whole time.

1. **Feature flags** (build-time env + a runtime remote/local override): `backend.sync`, `backend.social`, `backend.ping`, `backend.push` each in `{firebase, shadow, supabase}`. Default `firebase`. A single kill-switch forces everything back to `firebase`.
2. **Shadow writes (fire-and-forget, never blocking, never throwing into the app):**
   - `sync`: after a confirmed Firebase `cloudPut`, write the identical `(data, rev)` to Supabase `sync_put`. A failure logs to `shadow_mismatch` and does nothing else.
   - `social`: after a confirmed Firebase request/profile/invite write, mirror via the equivalent RPC with the same ids.
   - `ping`: **do not replay client calls against Supabase's state machine** (timing/clock differences cause false mismatches). Mirror by an **upsert-of-current-state** RPC (service-only, via Edge Function) after each confirmed Firebase transition, then compare.
3. **Shadow reads:** on pull, also read Supabase and compare `rev` and a hash of `data` (sync) or the normalised row (others); report mismatches, **always return Firebase's answer** to the app.
4. **Reconciliation:** the Phase-7 script runs on demand and nightly; goal is **zero unexplained mismatches** over a defined soak period.
5. **Mismatch reporting:** `shadow_mismatch` table + a hidden developer panel (extend the existing dev-tools area; production-hidden).
6. **Promotion order:** `sync` (lowest blast radius) → `social` (profiles/connections/invites) → `ping` → `push`. Each is flipped to `supabase` only after its own soak and go/no-go.
7. **Rollback:** flip the flag. Because Firebase stayed authoritative and writes were mirrored, nothing needs undoing. After a domain is flipped to `supabase`, keep **reverse mirroring** (Supabase → Firebase) for a defined window so rolling back still has fresh data.

---

## 16. SECURITY MIGRATION (Firestore rules → Supabase)

General: Postgres RLS has no per-field old/new comparison, no `request.time`, no cross-document `get()` in policy expressions with the same semantics, no multi-rule OR with distinct transitions. **Therefore mutations become RPCs and triggers; RLS is read-only access control plus defence in depth.**

| Domain | Firestore rule | Postgres translation | Mechanical? |
|---|---|---|---|
| **Attendance** | none (device-local) | none | n/a |
| **Sync (`syncs`)** | owner-only read; create `rev==1`; update `rev == old+1`; size `<900000`; no delete | RLS `SELECT` owner-only; **no direct INSERT/UPDATE/DELETE**; `sync_put(expected_rev, data)` does `UPDATE … WHERE uid=$me AND rev=$expected` (and `INSERT` when `expected is null`), returns the new rev or a conflict; `CHECK (length(data) < 900000)`; no DELETE grant or policy | **Redesign** (CAS as RPC) |
| **Restore points** | n/a | n/a (local only, never uploaded) | n/a |
| **Profiles** | read any signed-in; write own; name 1..40 | RLS own-row write via RPC; read via `get_profile_name` RPC (don't expose directory); `CHECK` on length | Partly |
| **Invites** | `get` any signed-in, `list` denied, create owner, delete owner; **expiry client-only** | table not directly readable; `get_invite(token)` returns only if `expires_at > now()`; `pg_cron` purge; *this closes an existing gap* | **Redesign** (improvement) |
| **Requests / friends** | create `from==me`, `to!=me`, pending only, name ≤40; accept/decline by `to` only while pending and only `status/respondedAt`; delete by participants; read by participants | `send_request` RPC (server sets `from_uid=auth uid`, `status='pending'`, timestamps); `respond_request` RPC (checks `to_uid`, `pending`); `remove_request` RPC; pair-unique partial index; RLS `SELECT` for participants | **Redesign** (field-level update → RPC) |
| **Pings** | see 8.3 | RPCs: `create_ping`, `answer_ping`, `lease_ping`, `finalize_ping`, `remove_ping` (section 17); RLS `SELECT` participants; no direct writes; `BEFORE UPDATE` guard trigger | **Redesign** |
| **Push tokens** | owner read/write/delete; token 1..4095 | `save_push_token`/`delete_push_token` RPC or owner-scoped RLS on `push_tokens`; Edge Function reads with service role; **consider one row per device** (current last-device-wins is a product limitation) | Mostly mechanical |

**Firestore rules that cannot be mechanically translated, and why:**
1. `get(/requests/$(d.requestId))` in `connected()` — becomes an FK plus a state check **inside the RPC transaction**, re-run on answer (to preserve "removing a friendship blocks an open Ping").
2. `createdAt == request.time` and the other `== request.time` fields — become `DEFAULT now()` / values set by the RPC; clients can never supply them. `now()` is transaction time; use `clock_timestamp()` only where wall-clock matters (lease).
3. `request.time < createdAt + 3d` and `claimedAt + 2m <= request.time` — evaluated inside the RPC with `now()`.
4. `diff().affectedKeys().hasOnly([...])` — no RLS equivalent. Use RPC (only specified columns are ever assigned) + `BEFORE UPDATE` trigger comparing `OLD`/`NEW`; `items[i].answer`-only changes validated in the trigger.
5. Three OR-ed `update` rules with different actors/transitions — one RPC per transition with explicit actor and state checks.
6. `keys().hasOnly([...])`, `is string`, `size()` — real column types and `CHECK`s.
7. The 1000-expression limit and unrolled `newItem(0..7)`/`answeredItem(0..7)` — disappear (a JSON validator in the RPC/trigger); the 8 cap is kept deliberately.
8. `list: false` with `get: true` on invites — no row-level equivalent; use an RPC.
9. `participants array-contains` — `from_uid = me OR to_uid = me`.
10. Absent today and worth adding: uniqueness per friend pair; server-enforced invite expiry; timestamps validated on `requests`.

**The rules tests are the behavioural spec.** Port all 64 (`tests/rules/*`) to run against a local Supabase (pgTAP or vitest + `supabase-js` with real JWTs) **before** any client code switches. Port `legacy-compat` semantics too: the "legacy Ping with 9–12 classes / future createdAt" cases become import-validation tests (an imported Ping must not violate the new constraints; define what happens to ones that do: expire/reject, never silently coerce).

---

## 17. PING MIGRATION

All Ping writes are `SECURITY DEFINER` RPCs run in one transaction with `search_path` pinned; `auth uid` is read from the verified JWT (`(select auth.jwt()->>'sub')`), never from an argument.

- **`create_ping(id, connection_id, class_date, items)`** — checks id pattern; `connections` row exists, `status='accepted'`, caller is one party, `to` is the other; `class_date` within `[today−3d, today+1d]` (UTC); `1 ≤ items ≤ 8`; each item `{key, subjectId, name(≤60), t?}` with `answer` forced `null` and unknown keys rejected; sets `from_uid=me`, `created_at=now()`, `status='asking'`. **Idempotent:** `INSERT … ON CONFLICT (id) DO NOTHING`; if the row exists and `(from,to,date,connection_id,item keys)` match → return `existing`; otherwise error. Preserves the client's `"created" | "existing"` contract.
- **`answer_ping(id, answers)`** — `SELECT … FOR UPDATE`; caller is `to_uid`; `status='asking'`; `now() < created_at + 3 days`; `created_at <= now()`; `jsonb_array_length(items) <= 8`; connection still `accepted`; answers cover exactly the same item keys; each `yes|no`; **only `items[i].answer`** changes; sets `status='answered'`, `responded_at=now()`. Second concurrent answer loses (status no longer `asking`).
- **`lease_ping(id, device_id)`** — caller is `from_uid`; `status='answered'`; `device_id ~ '^[A-Za-z0-9_-]{8,64}$'`; succeeds if `claimed_at is null OR claimed_by = device_id OR claimed_at + interval '2 minutes' <= clock_timestamp()`; sets `claimed_by`, `claimed_at`. Returns boolean (matches `leasePing` → `true/false`).
- **`finalize_ping(id)`** — caller is `from_uid`; `status='answered' → 'processed'`; sets `processed_at`; already processed → returns `"already"` (idempotent). **Server-side it cannot know the client applied the result**; the client invariant "apply, verify, then finalize" (`ping-processing.ts`) is **unchanged and is the real safety property**. Should finalize additionally require an active lease held by the calling `device_id`? That is the "optional lease requirement" the owner deferred (a mixed old/new client compatibility question). **Keep parity with today's rules (no lease requirement); revisit after cutover.**
- **`remove_ping(id)`** — participant; `status <> 'answered'`.
- **Immutable fields:** `from_uid, to_uid, connection_id, class_date, created_at`, all item fields except `answer` — enforced by the `BEFORE UPDATE` trigger even if a direct grant is ever added.
- **Max 8:** `CHECK`.
- **Expiry:** derived, as today; plus `pg_cron` purge at 31 days (matches `cleanUpPings`).
- **Edge Functions only for:** sending push (needs outbound HTTP and secrets). A DB trigger on `pings` insert/status change enqueues via `pg_net` or a Database Webhook to the push Edge Function.
- **Client changes:** only `lib/ping-server.ts` (the db-injected seam; it already takes a `db` argument) gets a Supabase adapter. `ping-processing.ts`, `ping-apply.ts`, `ping-id.ts`, presentation, and UI do not change.
- **Open questions to settle in Phase 9:** whether `requestId` should be validated as "belongs to caller" for **imported legacy** Pings; handling of legacy Pings that violate new constraints (reject/expire, never coerce).

---

## 18. NOTIFICATION MIGRATION

**Goal:** keep the browser notification UX (overlay, badge, SW push handler, deep link `/?ping=<id>`, tag `ping-<id>`, TTL 3 days, data-only payload) and replace only the *trigger and sender*.

Key finding: **sending FCM messages does not require the Blaze plan; only Cloud Functions do.** FCM HTTP v1 can be called from any server with a Google service-account credential, so a Supabase Edge Function can send exactly the same data-only messages. That keeps the client registration (`getToken`) and the service worker **unchanged**.

Stages (each independently reversible):
1. **Trigger:** DB trigger on `pings` (insert → "incoming" to `to_uid`; status `asking→answered` → "result" to `from_uid`; **not** lease/finalize) → `pg_net`/Database Webhook → Edge Function `send-ping-push`.
2. **Sender:** Edge Function reads `push_tokens` (service role), builds the payload using the existing contract (port `functions/ping-messages.js` verbatim; its logic is pure and already unit-tested), sends via FCM HTTP v1 using a service-account JWT stored as a Supabase secret, deletes dead tokens on `registration-token-not-registered`/`invalid-registration-token`, logs other errors. Dedupe by `tag`.
3. **Tokens:** switch `savePushToken`/`deletePushToken` to the Supabase adapter (flag `backend.push`). Optionally one row per device later.
4. **Cleanup job:** `pg_cron` (replaces `cleanUpPings`).
5. **Optional later:** replace FCM with standard Web Push (VAPID) using `PushSubscription` from `pushManager.subscribe`, removing Firebase Messaging entirely. `sw.js` already parses top-level/`data`/`notification` shapes. **Not recommended until after cutover**; it changes the registration path.

**What stays:** `public/sw.js`, in-app overlay/badge, local reminders, `registerPingAlerts` flow shape, VAPID env var name, the payload/URL contract.
**What changes:** the trigger/sender (Cloud Functions → Edge Function), the token store adapter, a service-account secret, and cleanup scheduling.
**Prerequisite regardless of migration:** the real two-device FCM test the owner planned; it is also the first validation of the SW against a real FCM envelope (UNVERIFIED today), and of `NEXT_PUBLIC_FIREBASE_VAPID_KEY` (absent from `.env.local` by name).

---

## 19. CUTOVER PLAN

For every phase: **Changes / Does NOT change / Tests required / Rollback point / Manual actions.**

**Phase 0 — Audit.** Changes: this document only. Does not change: any code, Firebase, env. Tests: baseline recorded (section 11). Rollback: delete the file. Manual: review the plan, resolve section 25 decisions.

**Phase 1 — Safety harness.** Changes: branch `migration/supabase`; `MIGRATION_CHECKPOINT.md`; add `puppeteer-core` and a single `npm run migration:health` command that runs unit, rules, typecheck, lint, build and the e2e set; baseline snapshot file of counts; fix reproducibility of e2e from a clean checkout; stabilise the flaky identity test **without weakening it**. Does not change: product behaviour, Firebase, deps beyond the dev dependency. Tests: health command green and equal to section 11. Rollback: revert the harness commit. Manual: Chrome present; Java for emulator tests.

**Phase 2 — Supabase schema.** Changes: `supabase/migrations/*` (tables, constraints, indexes, enums) in a **new** Supabase project; local Supabase for tests. Does not change: app code, Firebase. Tests: schema constraint tests (pgTAP). Rollback: drop project/schema. Manual: create the Supabase project (Dashboard); store keys in `.env.local` only.

**Phase 3 — Security / RLS / RPC.** Changes: RLS, RPC state machines, triggers, `pg_cron` purge; port all 64 rules tests plus the legacy-compat semantics. Does not change: client, Firebase. Tests: the ported suite green; a negative-test suite (every denied case denied). Rollback: drop migration. Manual: none beyond enabling extensions in Dashboard if needed.

**Phase 4 — Repository abstraction.** Changes: introduce `SyncStore`, `SocialStore`, `PingStore` interfaces; move existing Firebase code behind them with **zero behaviour change**; flags default `firebase`. Does not change: behaviour, ids, payloads. Tests: full health command unchanged (177/64/203 minimum). Rollback: revert (no backend change). Manual: none.

**Phase 5 — Identity bridge (SPIKE FIRST).** Changes: prove the Firebase-token → Supabase-JWT bridge end to end on Free (claim bootstrap or token exchange); add Edge Function; Supabase client factory that supplies the bridged token. Does not change: Firebase Auth, uids, user data. Tests: RLS enforced for a bridged anonymous uid and a bridged Google uid; token refresh; account-switch (`credential-already-in-use`) does not leak the old identity's rows. Rollback: remove the Edge Function; app unaffected (still Firebase). Manual: Firebase service account (Firebase Console), Supabase secrets (Dashboard), JWT settings (Dashboard). **Gate:** if the spike fails on Free, STOP and escalate.

**Phase 6 — Shadow / dual write.** Changes: shadow writes (sync first, then social), `shadow_mismatch` table. Does not change: reads, authoritative backend. Tests: shadow writes never throw into the app (fault injection: Supabase down, slow, 4xx/5xx); offline behaviour unchanged. Rollback: flag off. Manual: initial data import (terminal).

**Phase 7 — Reconciliation / shadow reads.** Changes: shadow reads, reconciliation script, nightly report. Does not change: authoritative reads. Tests: reconciliation detects an injected mismatch; zero unexplained mismatches over the soak. Rollback: flag off. Manual: run exports/imports; review reports.

**Phase 8 — Realtime.** Changes: Supabase realtime adapters with refetch-on-subscribe; `resilient()` retained. Does not change: polling floor, merge, `ingest` rev rules. Tests: reconnect/missed-event tests (kill the socket, mutate, restore, assert convergence); duplicate-listener tests; auth-transition tests. Rollback: flag back. Manual: enable Realtime on the tables (Dashboard).

**Phase 9 — Ping server logic (promotion).** Changes: `backend.ping = supabase` behind the flag, after the Phase 3 suite and a soak; reverse mirroring on. Does not change: `ping-processing`, `ping-apply`, `ping-id`, presentation, UI. Tests: full Ping unit + e2e + ported rules + two-client concurrency (two answerers, two leasers, lease takeover after expiry, duplicate create, finalize twice). Rollback: flag to firebase (reverse-mirrored data is current). Manual: window announcement; final delta import.

**Phase 10 — Notifications.** Changes: Edge Function sender, trigger, token adapter. Does not change: `sw.js`, payload contract, overlay. Tests: unit tests for ported message builder; real two-device push test; dead-token deletion; no duplicate notification on lease/finalize. Rollback: flag to firebase tokens; disable trigger. Manual: FCM service account secret; `NEXT_PUBLIC_FIREBASE_VAPID_KEY`; real devices.

**Phase 11 — Cleanup.** Changes: remove dead code listed in section 2 that is unrelated to the live path; drop `shadow_mismatch`. Does not change: anything still in use; **no Firebase deletion yet**. Tests: full health. Rollback: revert.

**Phase 12 — Controlled cutover.** Changes: production flags to `supabase` one domain at a time (sync → social → ping → push) with a soak between each; reverse mirroring on. Does not change: Firebase project (read-only fallback). Tests: go/no-go checklist (section 24) per domain. Rollback: per-domain flag flip. Manual: staged rollout; monitor.

**Phase 13 — Firebase retirement.** Changes: remove Firestore code, rules, functions, emulator config; keep Firebase **Auth** unless the owner separately decides to move it. Does not change: Auth (default). Tests: full health. Rollback: git revert + restore from final Firebase export. Manual: Firebase Console (disable Firestore after a long quiet period), delete service-account keys, final export archived.

---

## 20. ROLLBACK PLAN

| Stage | Failure | Rollback |
|---|---|---|
| Phases 1–4 | harness or refactor regressions | `git revert` / reset the branch; Firebase untouched |
| Phase 5 | bridge fails | remove Edge Function; no user impact |
| Phase 6–7 | shadow write errors, mismatches | set flags to `firebase`; Supabase discarded or truncated and re-imported |
| Phase 8 | realtime misses events | flag back to Firebase listeners; polling floor remains |
| Phase 9 | Ping defect found after promotion | flag back to Firebase; reverse-mirrored rows keep Firebase current; Pings in flight finish under whichever backend owns them (document the freeze order) |
| Phase 10 | duplicate or missing notifications | disable the DB trigger; revert token adapter flag |
| Phase 12 | any domain regression | per-domain flag flip; reverse mirror keeps Firebase fresh for the soak window |
| After Phase 13 | post-retirement defect | restore Firestore from the archived final export and redeploy rules (rules files are in git history); **this is slow, so Phase 13 must wait for a long clean soak** |

Rules for every stage: Firebase **stays deployed and usable** until Phase 13; take a full Firebase export and a Supabase `pg_dump` **before** each phase that moves authority (Free has no point-in-time recovery); never delete the Firebase project, rules or `firebase.json` until a go decision.

---

## 21. DATA-LOSS DANGERS

| Danger | Operation that can cause it | Mitigation |
|---|---|---|
| **Lost attendance** | anything that rewrites/normalises the sync blob; recompressing; wrong `rev`; blob overwritten by an empty/old copy; restore overwriting; truncating restore points | blob is opaque and byte-copied; CAS on `rev` only; keep three-way merge; never import into an authoritative backend; pre-cutover exports |
| **Duplicate attendance** | double-applying a Ping result; double merge; re-import over newer data | `coveredPings`, merge dedupe, log key `d|t`; idempotent imports; never "re-apply" server data to local |
| **Lost restore point** | reset/sign-out paths that touch `restorePoints`; IndexedDB quota swallow | do not touch `restorePoints`; no migration of them; keep the swallow behaviour visible in tests |
| **Duplicate Ping** | non-idempotent create; regenerated ids on import | preserve ids; `ON CONFLICT DO NOTHING`; keep `ping-id.ts` |
| **Wrong user receiving data** | missing RLS; `SECURITY DEFINER` with unpinned `search_path` or argument-supplied uid; bridge accepting a token for another uid; shadow reads returned to the app | uid only from JWT; RLS on every table; negative tests; shadow reads never returned |
| **Broken friendships** | importing `requests` without ids; unique index rejecting legacy duplicates; account-switch `identityCarry` interrupted | preserve ids; define dedupe policy for legacy duplicate pairs **before** import (keep the accepted one, preserve the other as a reject record); keep carry logic untouched |
| **Duplicate notifications** | trigger fires on lease/finalize; two senders (Firebase + Supabase) live at once; function retry | trigger only on insert and `asking→answered`; one sender live per domain; `tag ping-<id>` |
| **Identity split** | changing auth provider; new uids; anonymous users re-created | Option A; uids unchanged; no auth move in this migration |
| **Offline data loss** | a change that makes marking depend on the network; a backend error surfacing as blocking UI; dropping the "write local first, sync later" order; cutting off the debounce/retry design | shadow code must be fire-and-forget; offline e2e (`sync`, `nav`, `today`) must stay green; do not alter `applyDurably`, `use-cloud-sync` ordering |
| **Lost favour** | the existing mid-apply crash window (8.10 #2) | pre-existing; keep behaviour and tests; do not "fix" during migration |
| **Silent truncation** | importing blobs through a size-limited path; text column vs Free storage | copy bytes unchanged; verify hashes |
| **Free project paused** | inactivity pause | keep-alive job (12.7) |

---

## 22. DO-NOT-TOUCH LIST

Claude must not alter these without an explicit instruction naming them:
1. `lib/attendance.ts`, `lib/scan.ts`, `lib/types.ts` field semantics (attendance invariants, section 5).
2. `lib/merge.ts`, `lib/backup.ts`, `lib/backup-import.ts`, `pack`/`unpack`, the `gz1:` format, `DOC_LIMIT_BYTES`.
3. `lib/db.ts` (IndexedDB schema, key names, lazy migration) and any `dbSet`/`dbGet` call order in `app/page.tsx`.
4. `lib/restore-points.ts` and anything that deletes or rewrites `restorePoints`.
5. `lib/ping-processing.ts` ordering (lease → apply+verify → finalize), `lib/ping-apply.ts` rules, `lib/ping-id.ts`, `Mate.coveredPings` format `"YYYY-MM-DD|<pingId>:<classKey>"`.
6. `hooks/use-cloud-sync.ts` orchestration, retry timers, `syncBase` write-after-confirm.
7. `lib/identity.ts` carry logic (`identityCarry`, `switchToExisting`, `completeCarry`) until Phase 5 explicitly addresses it.
8. `public/sw.js` offline-shell logic and the `push`/`notificationclick` contract (`/?ping=<id>`, tag `ping-<id>`).
9. Demo-mode isolation guards (`demoActive`, `paused`).
10. The existing tests: **do not weaken, skip, delete, or loosen** any assertion in `tests/*.test.ts`, `tests/rules/*`, `scripts/e2e-*.mjs`.
11. `firestore.rules` and `firebase.json` until Phase 13 (rules are deployed in production).
12. `.firebaserc` project id.
13. Anything in `.env.local` (contains secrets: `VAPID_PRIVATE_KEY`, `VERCEL_OIDC_TOKEN`, `PUSH_ADMIN_KEY` by name); never print or commit it.
14. The name-keyed matching listed in section 7 (do not "improve" during migration).
15. The `MAX_PING_ITEMS = 8` constant.
16. Product copy, UI and navigation.

---

## 23. MANUAL ACTIONS

**I must do in the Supabase Dashboard:** create the project (region near users); note URL and anon/publishable key; enable extensions (`pg_cron`, `pg_net`) if not on; configure Auth/JWT settings required by the bridge (Phase 5 spike); enable Realtime on the tables; create Edge Function secrets (Firebase service account, FCM credentials); confirm Free-tier limits and the inactivity-pause policy; take backups/exports before each authority change.

**I must do in the Firebase Console:** nothing destructive. Download a service-account key (kept out of git) for export and for the push/bridge Edge Functions; confirm the Authorized domains for Google sign-in; (optional) confirm or create the web push certificate (VAPID) and add `NEXT_PUBLIC_FIREBASE_VAPID_KEY` locally and on Vercel; leave Firestore and rules deployed; at the very end, disable Firestore **only** after the owner's go decision.

**I must do in the terminal:** run the export and import scripts; run `supabase` CLI migrations; run `firebase deploy --only firestore:rules` only if rules need a change (not planned); set Vercel environment variables; install a Java runtime for emulator tests.

**Claude can automate safely:** write and test migrations, RPCs, RLS, triggers; port tests; the repository abstraction; the shadow/reconciliation code; the health-check command; documentation; unit/e2e tests. Claude **must not** deploy, push to production, change Firebase config, run exports against production, or handle service-account keys unless the owner explicitly asks and the permission system allows it.

---

## 24. FINAL GO / NO-GO CHECKLIST (per domain and for final cutover)

Each item is binary PASS/FAIL. Any FAIL = NO-GO.

**Baseline integrity**
- [ ] `migration:health` equals or exceeds the Phase 0 baseline: unit ≥177, rules-equivalent ≥64, e2e ≥203, typecheck clean, lint errors 0 (warnings not increased above 75), build passes.
- [ ] No test was deleted, skipped, or weakened (diff reviewed against HEAD `3644948`).
- [ ] The flaky identity test is stable (≥20 consecutive green runs).

**Data**
- [ ] Final export counts equal imported counts for every collection (0 unexplained rejects).
- [ ] `syncs`: for **every** uid, `rev` equal and SHA-256 of `data` equal; sampled blobs decode and `parseFullBackup` accepts them.
- [ ] Zero unexplained rows in `shadow_mismatch` over the agreed soak.
- [ ] Referential integrity: every `pings.connection_id` exists.

**Security**
- [ ] All ported rules tests pass against Supabase.
- [ ] Negative suite: a user cannot read/write another user's `syncs`, `push_tokens`, `connections`, `pings`.
- [ ] No table grants direct INSERT/UPDATE/DELETE to `authenticated` for social/ping/sync data.
- [ ] Every `SECURITY DEFINER` function pins `search_path` and derives uid from the JWT only.
- [ ] Invite expiry enforced server-side.

**Ping**
- [ ] Two answerers: exactly one wins. Two leasers: exactly one holds. Lease takeover after expiry works. Duplicate create returns `existing`. Finalize twice returns `already`.
- [ ] Expired Ping cannot be answered; Ping with >8 items cannot be created; forged/future timestamps impossible.
- [ ] Exactly-once local application verified by the existing processing tests and e2e.

**Identity**
- [ ] Anonymous and Google uids unchanged after migration; anonymous→Google link keeps the uid; `credential-already-in-use` carry flow works; old identity's rows invisible to the new one.
- [ ] Bridge token refresh works across sign-in/out and expiry.

**Realtime / offline**
- [ ] Missed-event recovery verified (kill socket, mutate, reconnect, converge).
- [ ] App fully usable with backend unreachable; marking, undo, scan, restore points work offline; offline e2e green.
- [ ] No duplicate listeners across identity changes.

**Notifications**
- [ ] Real two-device push test: incoming and result delivered once, deep link opens the correct Ping, suppressed when a window is visible, dead token removed.
- [ ] No notification on lease/finalize.

**Operations**
- [ ] Rollback flag flip rehearsed in production-like conditions and verified to restore full function.
- [ ] Free-tier headroom confirmed for DB size, Realtime connections, function invocations; inactivity keep-alive running.
- [ ] Fresh Firebase export and Supabase dump taken and stored off-machine immediately before cutover.
- [ ] Owner sign-off recorded.

---

## 25. DECISIONS NEEDED FROM THE OWNER (before Phase 2)

> **Analysed in `MIGRATION_DECISIONS.md`** (recommendation, evidence, risk and rollback for each, with status PROVISIONAL / REQUIRES SPIKE / APPROVED FOR IMPLEMENTATION and an owner sign-off table). Item 2 is split there into 2a (duplicate friend pairs) and 2b (legacy Pings). The list below is left as originally written.

1. Confirm Option A (keep Firebase Auth) as the identity strategy, and accept the **Phase 5 spike gate** (stop if the Free-plan bridge cannot be made to work).
2. Policy for legacy duplicate friend pairs and legacy Pings that violate the new constraints (reject/expire; never coerce).
3. One push token per account (current) or per device (recommended later).
4. Is a short write-freeze window acceptable at final cutover?
5. Whether to schedule a Free-project keep-alive.
6. Who provisions Supabase and the Firebase service account (owner, terminal/dashboard).

## 26. PRE-EXISTING DEFECTS FOUND DURING THE AUDIT (recorded, not fixed)

1. Mid-apply crash window can lose a favour (two non-transactional IndexedDB writes, 8.10 #2).
2. Invite expiry is client-only; invites never deleted.
3. No uniqueness on friend pairs; duplicate requests possible.
4. Name-keyed matching in several places (section 7).
5. One push token per account; last device wins.
6. Restore points are uncapped and rewritten in full on each save.
7. `createdAt`/`respondedAt` on `requests`, `expiresAt` on invites, `updatedAt` everywhere are unvalidated.
8. After a hopeless realtime error (`permission-denied`), the listener does not restart until identity changes.
9. Reset does not clear several keys (`displayName`, `socialOn`, `syncOwner`, `deviceId`, `identityCarry`, `restorePoints`).
10. `NEXT_PUBLIC_FIREBASE_VAPID_KEY` is documented in `.env.local.example` but not present in `.env.local` (by name); push cannot work until set and functions/sender exist.
11. e2e scripts not reproducible from a clean checkout (`puppeteer-core` missing from `package.json`).
12. Two inconsistent "configured" checks (`firebaseConfigured` vs `socialConfigured`).
13. Class reminders fire only while the app is open.
14. Lint: 75 warnings (`react-hooks/*`).

## 27. UNVERIFIED ITEMS

- Real FCM envelope parsing in `public/sw.js` (never tested against real FCM).
- Contents of `lib/ping-presentation.ts` / `use-ping-events.ts` beyond audit summaries; `app/api/dev-sync` route internals; QR component.
- `functions/node_modules` presence (directory has only source files; functions never deployed).
- All Supabase platform behaviours and limits (marked VERIFY).
- Whether the Vercel deployment has any env vars that differ from `.env.local`.

---

CURRENT MIGRATION STATUS:
PHASE 0 — AUDIT COMPLETE
APPLICATION BACKEND — STILL FIREBASE
SUPABASE — NOT CONNECTED
PRODUCTION DATA — UNCHANGED
FIREBASE — NOT RETIRED
ROLLBACK — FULLY AVAILABLE
