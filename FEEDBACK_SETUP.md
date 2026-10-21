# Feedback collection and developer dashboard

This build adds a user feedback prompt after approximately 36 hours of use, a permanent Settings entry, client-side image compression, a reply/resolve dashboard at `/developer-feedback`, and a small animated acknowledgement. Feedback is stored in Firestore collection `feedback`.

## Before enabling this on the public deployment

1. Confirm the developer Google account email in `firestore.rules` and `components/developer-feedback.tsx` is the intended account. The current default is `adityavw2006@gmail.com`; update both in the same release if that changes. `NEXT_PUBLIC_DEVELOPER_EMAIL` can change the UI gate but **does not replace the Firestore rule check**.
2. Review `firestore.rules`, then deploy the rules to the same Firebase project as the app using your normal reviewed deployment workflow. No rules or hosted services have been deployed by this change.
3. Sign into `/developer-feedback` with the verified developer Google account. Other accounts should see “No access”; Firestore rules enforce this, not only the page.
4. Submit a test rating, a bug with a screenshot, and a reply. Verify the user sees the acknowledgement on the same account. The screenshot is downscaled to at most 1280 px on its longest edge and re-encoded to JPEG under roughly 280 KB before upload.

## Data/security behaviour

- Feedback entries are create-only for the public. Only the entry's signed-in owner or the verified developer can read; only the developer can reply/resolve. Users may mark their own reply as seen. Deletion is denied.
- Signed-out feedback can be submitted, but replies are only surfaced in-app when the reporter had a non-anonymous Google account at submission time.
- Images are embedded in the feedback document, not Firebase Storage, and are capped to keep the Firestore document below its limit. This is appropriate for occasional screenshots; move images to Storage with dedicated rules if feedback volume grows.
- Public create-only Firestore rules do not provide strong abuse-rate limiting. Before a broad public launch, enable Firebase App Check and consider a server-side rate limit.
