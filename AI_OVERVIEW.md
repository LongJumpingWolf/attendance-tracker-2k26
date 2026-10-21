# AI App Overview: Attendance Tracker (College Tracker)

## Purpose
A mobile-friendly, offline-capable college attendance and deadline tracker. This package captures the repository's current working-tree state, including local uncommitted edits. It is intended as context for an AI assistant; verify behavior against source and tests rather than treating historical notes as current truth.

## Stack and entry points
- Next.js 16 App Router, React 19, TypeScript (strict mode), Tailwind CSS 4.
- The main experience is the client-rendered home app in `app/page.tsx`; shared document metadata and the PWA shell live in `app/layout.tsx`.
- Most screens are composed from `components/`; domain logic, storage, synchronization and integrations live in `lib/` and `hooks/`.
- `public/manifest.json` and `public/sw.js` support installability/offline behavior. `/scan` redirects to `/?scan=1`.

## User-facing capabilities
- Track subjects, attendance marks and attendance requirements; weekly timetable slots, future attend/skip plans, attendance history and undo.
- Today, subjects, calendar and proxy-mates views; subject details and attendance summaries.
- Add/manage deadlines (exams, assignments, submissions), reminders and completion state.
- Import timetable data, scan QR/NFC check-in links, onboarding/demo tour, themes, notifications and periodic recap (?Wrapped?).
- Social connections, friend requests and Pings: ask a connected mate to confirm attendance; accepted answers are applied with exactly-once safeguards and tracked as favors.
- Local-first data, cloud sync, restore points and backup/restore flows.

## Core domain model
See `lib/types.ts` for canonical TypeScript types. The main records are `Subject` (attendance counters, requirement, tags, weekly `Slot`s, `LogEntry` history and planned classes), `Task` (deadline), `Mate` (private favor ledger), `FriendRequest` and `Ping`. Attendance dates are represented as `YYYY-MM-DD`; class times use `HH:MM`.

## Data and service architecture
1. The browser's working copy is stored in IndexedDB by `lib/db.ts` (database `college-tracker`), with localStorage fallback for environments where IndexedDB is unavailable. Small preferences remain in localStorage.
2. `app/page.tsx` loads and persists subjects, tasks, tags and mates; domain operations are kept in `lib/attendance.ts`, `lib/timetable-import.ts`, `lib/backup*.ts`, `lib/restore-points.ts` and related helpers.
3. `lib/account.ts`, `lib/cloud-sync.ts`, `lib/social.ts` and ping modules coordinate auth, sync, connections, push and ping processing. `hooks/use-cloud-sync.ts` and `hooks/use-social.ts` expose this to React.
4. `lib/backend/` is the backend-selection boundary for sync/social/ping/push. Firebase is the documented default. Backend selection is build-time, with per-domain overrides; invalid configuration fails rather than silently switching backends.
5. Supabase migration code, SQL migrations, Edge Function bootstrap, realtime transport, and shadow read/write support are present. Auth bridge, shadow operations and realtime require explicit `NEXT_PUBLIC_*` build flags/configuration; defaults are OFF. Firebase remains authoritative when shadowing is used. Do not infer that a Supabase production cutover has occurred just because the code exists.
6. Firebase Cloud Functions in `functions/` and Firestore rules at `firestore.rules` implement/server-guard social and ping behavior. The optional local dev sync route is under `app/api/dev-sync/`.

## Important repository areas
- `app/`: app entry, styles and dev-only API route.
- `components/`: view components, sheets, onboarding, scan and settings UI.
- `lib/`: domain models/logic, local persistence, Firebase and backend adapters, sync, social, reminders, import/export.
- `hooks/`: React integration for sync, social and notifications.
- `functions/`: Firebase Cloud Functions.
- `supabase/migrations/`, `supabase/functions/`, `supabase/tests/`: database evolution, auth bootstrap and database checks.
- `tests/`: unit/integration/rules/migration test suites and test helpers.
- Included design/migration notes: `SUPABASE_SCHEMA.md`, `PHASE3_SECURITY_MATRIX.md`, `PHASE4A_REPOSITORY_ARCHITECTURE.md`, `PHASE8_REALTIME.md` and `SIGNIN_RECONCILIATION.md`. Some notes record historical state; source, migrations and tests are authoritative for current behavior.

## Local development and checks
Requires Node.js (Firebase Functions target Node 20). Install with `npm ci`; run `npm run dev` for the web app. Useful checks: `npm run typecheck`, `npm test`, `npm run lint`, `npm run build`. Specialized scripts include `npm run test:local-supabase`, `npm run test:rules`, and `npm run test:shadow-integration` (some need local services/emulators). See `package.json` for exact commands.

## Configuration and safety
- Runtime/build configuration is supplied by environment variables; see references to `process.env` and feature-flag parsing in `lib/backend/flags.ts` and `lib/backend/index.ts`. No `.env*` files or secret values are included in this ZIP.
- Local Supabase state, emulator logs, migration exports/user data, dependency folders, build output, Git metadata and TypeScript caches are deliberately omitted.
- Rules and migrations are included to explain authorization and schema, but they are not deployment instructions. Review the relevant docs before operating against a hosted project.

## Suggested AI reading order
1. This file and `package.json`.
2. `app/page.tsx`, `app/layout.tsx`, `lib/types.ts`, `lib/db.ts`.
3. `lib/attendance.ts`, `hooks/use-cloud-sync.ts`, `lib/cloud-sync.ts`, `lib/account.ts`.
4. Relevant `lib/backend/`, social/ping modules and their matching tests.
5. `firestore.rules`, `functions/`, then Supabase migrations/tests if the question concerns backend migration.
