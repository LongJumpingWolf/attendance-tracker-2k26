# Latest Mates / Ping / NFC patch

## Changes
- The Mates account setup now has a 12-second watchdog and a retry that rebuilds the auth-state listener after a timeout, so the UI does not spin indefinitely on “Setting up your account…”.
- New accounts get a generated display label. The real identifier is the full Firebase UID, shown as a copyable unique account code; QR/permanent links continue to encode that UID. Names are labels, never identity keys.
- The Add Mate sheet now accepts a unique account code, permanent add link, or short-lived invite link instead of asking for a display name. A connection request must still be accepted before a Mate is connected.
- Direct in-app Pings are blocked for anonymous identities in the client UI and handler; answering/automatic processing of direct Pings is also gated. WhatsApp/share-link Pings remain available to anonymous users. Firestore rules require a non-anonymous provider for direct Ping create/answer/lease/finalize operations.
- When an anonymous Firebase account is linked to Google with the same UID, the UI is notified of the provider change without detaching or clearing its existing listeners/data.
- NFC tags use the same `/scan` URL as the QR code, so they share the exact `pickScanTarget` timing rules: in-progress first, then ended within 20 minutes, then starting within 15 minutes; ambiguous matches require a choice.

## Verification
- TypeScript/TSX syntax transpile scan: 173 files, zero syntax diagnostics.
- Dependency-backed TypeScript typecheck, Vitest suite, Next.js build, and Firestore emulator rules suite were not run because `node_modules` and the Firebase emulator are not present.
- No hosted services or production data were changed. `firestore.rules` changes are local only and require review/test/deployment approval before production use.

## Localhost Mates setup diagnostic fix (Oct 21, 2026)

The latest reported localhost screen still displayed the older generic `Setting up your account…` message. Code inspection found that this archived version depended on the separate Auth observer to update the UI; in Next.js development Strict Mode, its listener cleanup could run during setup, and the first `null` auth callback could clear the timeout/status before anonymous sign-in completed. This made the UI capable of remaining on the loading branch without an actionable error.

The current copy now:
- updates the React UID/status directly from the successful `ensureSignedIn()` promise;
- treats the first null auth callback as a normal initialization state, without clearing a successful identity;
- correctly detaches and resets the observer latch during Strict Mode cleanup;
- shows a `Connecting to Firebase` state, a retry button, and then a diagnostic/error state instead of an unbounded generic spinner;
- maps common Firebase Auth failures (anonymous provider disabled, invalid/mismatched API key, unauthorized localhost domain, network failure, throttling, emulator/config timeout) to actionable, non-secret-bearing help text;
- catches storage access failures and adds four focused diagnostic unit tests.

### Localhost test procedure

1. Preserve the existing `.env.local` locally; it is intentionally excluded from the ZIP. Verify `NEXT_PUBLIC_FIREBASE_PROJECT_ID` belongs to the same Firebase project whose Auth console has Anonymous enabled.
2. For real-project testing, make sure `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST` and `NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST` are unset. Only set them if both corresponding local emulators are running.
3. Stop the dev server, delete the generated `.next` cache, restart `npm run dev`, and hard-refresh the browser.
4. The Mates card should either show a generated account code after authentication or show `Couldn't connect` with an actionable error within about 10–12 seconds. If the old text `Setting up your account…` remains, the browser/server is not using the updated source copy.
5. Use DevTools Network to inspect the Firebase Auth request status without sharing the full request URL or `.env.local`. Then verify two separate browser profiles can connect using the account code and accept the request.
6. Remember: `NEXT_PUBLIC_APP_URL` affects links opened by another device, not local Firebase Auth. A localhost URL is not reachable from another phone; use account codes for local tests and a public HTTPS preview for share-link tests.

### Latest checks in this environment

- TypeScript typecheck (`tsc --noEmit`): **passed** with zero diagnostics after fixing the undefined `attendanceSubject` reference in the marked-today list and replacing unsafe direct Firestore type assertions with the existing `asDb` helper.
- TypeScript/TSX syntax transpile scan: **177 files, zero syntax errors**.
- JavaScript/MJS syntax scan: **31 files, zero syntax errors**.
- Full ESLint: **0 errors, 103 warnings**. The remaining warnings are existing hooks/ref/`img` advisories; they are not automatically fixed here because broad changes could alter behavior.
- Push config runtime smoke checks: **7/7 passed** for VAPID variable compatibility, missing-key handling, Brave push-service AbortError diagnosis, and non-push failure classification.
- Full Vitest startup is blocked because the supplied Windows-oriented `node_modules` is missing the platform-specific Rolldown native binding. Next.js build is blocked because the matching Linux SWC binary is not present and network access to the package registry is unavailable. Firebase emulator/browser end-to-end tests were not run.
- No hosted services or production data were changed. The user's `.env.local` is excluded from the ZIP.


## 2026-10-21 — Firebase push-service AbortError repair

- Root diagnosis from the uploaded config: neither `NEXT_PUBLIC_FIREBASE_VAPID_KEY` nor the legacy `NEXT_PUBLIC_VAPID_PUBLIC_KEY` had a non-empty value. The client code was only reading the first name, so it did not clearly catch the missing configuration before asking the browser to subscribe.
- Added `lib/push-config.ts`, which supports the canonical and legacy public-key variable names, classifies `AbortError: Registration failed - push service error`, and reports a recoverable browser-configuration message.
- `requestFCMToken` now checks that browser push APIs and the public VAPID key exist, waits for an active service worker, and returns `null` on a push-service failure without treating optional remote push as a fatal app error.
- The Settings developer test checks configuration before calling FCM, uses the active service-worker registration, no longer logs/displays the FCM token, and gives a targeted error message.
- The uploaded current folder was from Brave on localhost. Brave has a browser privacy setting called “Use Google services for push messaging”; it must be enabled and Brave relaunched for FCM push subscriptions to work in this browser.
- Local checks: TypeScript typecheck passed after also fixing an unrelated undefined `attendanceSubject` reference in the marked-today list and replacing direct compat/modular Firestore test casts with the existing `asDb` helper. Full Vitest and Next build remain blocked by the uploaded Windows-oriented `node_modules` lacking the Linux Rolldown/SWC optional binaries; dependency installation was not performed.


## 2026-10-22 — Direct Ping visibility and one-day share-link UX

- Direct in-app Ping UI is shown only for configured, ready, non-anonymous Google-linked sessions and accepted Mate connections. Anonymous sessions show a disabled/clear explanation; direct send and answer handlers plus Firestore rules also deny anonymous direct-Ping operations.
- The generic WhatsApp Ping modal now offers “Choose a connected friend” when direct Ping is eligible and there is an accepted connection. If not eligible, it explains the Google sign-in and accepted-connection requirements while leaving official share-link creation available.
- Share-link creation has an explicit “Create official 24-hour link” action and a 24-hour TTL in the client and Firestore rule. It now creates the link first and shows it with Copy, native Share (on supported browsers), and Open WhatsApp actions. Native sharing is not called after the asynchronous Firestore write, avoiding expired user activation and share-sheet errors. If Firestore/link-origin setup fails, the app presents an error state and concrete reason instead of immediately opening a misleading plain-message share sheet. Plain message is an explicit fallback only, with a clear note that replies must be recorded manually. A retry button returns to class selection.
- Removed the remaining user-facing “Only say yes if you really did” / honesty phrasing. The answer screen describes the attendance effect neutrally.
- Localhost links require `NEXT_PUBLIC_APP_URL` to point to a deployed public HTTPS version which includes `/ping/[id]` and uses the same Firebase project; a `localhost` link itself cannot be opened by another person. Firestore rules must be reviewed and deployed separately to enforce the 24-hour cap in production.
- Latest verification: `npm run typecheck` passed; targeted ESLint had zero errors (existing React-hooks/ref/image warnings remain); direct runtime/static smoke checks passed 10/10. Vitest could not start because the mounted Windows `node_modules` is missing its Linux Rolldown binding; the Linux Next.js build is also blocked by missing native SWC/network package retrieval. No hosted services or live user data were changed.

### Final verification pass for the 24-hour Ping UX

- `npm run typecheck`: PASS (no diagnostics).
- Focused ESLint on the changed Ping components/modules/tests: exit 0, **0 errors and 18 warnings**. The warnings are existing React Hook/ref purity and `img` advisory warnings in these larger components; no new lint errors.
- TypeScript/TSX syntax/transpile scan: **179 files, 0 syntax errors**.
- Focused Ping/origin/rules/UI smoke checks: **17/17 passed**, covering anonymous account gating, Google+connection gating, explicit link expiry at 24 hours, public origin handling for localhost, rules TTL, failure behavior, and deferred native share after the Firestore operation.
- Full Vitest suite did not start: the mounted Windows `node_modules` is missing the Linux Rolldown optional binding (`@rolldown/binding-wasm32-wasi`). No dependency installation was performed.
- `migration:health` remains **UNHEALTHY** in this container: unit tests are blocked by the missing Rolldown binding, Firestore rules suite is blocked because the Firebase CLI is unavailable on PATH, browser E2E is blocked because the configured Windows Chrome path is unavailable here, and Next.js build is blocked by the absent Linux SWC package plus unavailable registry DNS. ESLint reports 103 warnings against a historical threshold of 75 (zero errors); that threshold was deliberately not raised just to make health appear green.
- The updated `firestore.rules` file is local and not deployed. The server-enforced one-day limit only applies once reviewed rules are deployed to the Firebase project. No hosted access, deployment, or live data modifications occurred.
