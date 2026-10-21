# WhatsApp Ping links: backend setup

- **SQL required:** No.
- **New Cloud Function required:** No.
- **Firestore rules update required:** Yes. The `sharePings` block in `firestore.rules` now caps response links at 24 hours. Deploy the rules to enforce the cap for all clients.
- **Live change performed:** No. The updated rules are only in this source copy.

## Local development and recipient URLs

The feature ZIP intentionally does not include `.env.local`. Copy the original local Firebase environment values into the working folder and restart the Next.js server. Those values only enable the local Firebase client; they do **not** make `http://localhost:3000` shareable. A recipient's phone treats localhost as its own device.

To create a working one-day link from localhost, set `NEXT_PUBLIC_APP_URL` in `.env.local` to a deployed HTTPS preview that already contains the `/ping/[id]` route and uses the **same Firebase project** as the local sender. If the public site doesn't yet include that route, deploy the reviewed app code to a preview first. The override is optional: when the user opens the deployed public site normally, the app uses that site's HTTPS origin.

Before launch, run the Ping rules tests against the Firestore emulator using the repository's existing documented test command. The tests should cover a link holder's unauthenticated read and single answer, denial of listing/tampering/repeated answers, expiry, cancellation, and the sender's `answered → claimed → processed` path. Review the diff against the latest actual repository before applying or deploying anything.

When explicitly approved, update only the Firestore rules in the correct Firebase project using the existing project workflow. Do not run a SQL migration or deploy Cloud Functions for this feature. Test with a new test link first. A production share link is a bearer capability: anyone holding it can read that one Ping and submit its one response until the 24-hour expiry or until the sender cancels it. The share-link lifetime is separate from direct in-app Pings, which keep their existing three-day lifetime.
