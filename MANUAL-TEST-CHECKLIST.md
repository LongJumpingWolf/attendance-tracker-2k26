# Attendance Tracker — Continuous manual release checklist

Run this on a separate preview/staging deployment first, not the active live app. Use a test account for destructive/conflict tests. Check items in sequence, recording the device/browser and screenshot for each failure.

## Protect existing data and open the preview

- [ ] 1. Confirm the current live website still loads the familiar Firebase-backed version.
- [ ] 2. On the live version, each tester exports **Settings → Backup & restore → Save a full backup**; keep the JSON outside the browser.
- [ ] 3. Note subjects, attendance totals, historical marks, timetable slots, tasks, Mates, reminders and sync status before testing.
- [ ] 4. Extract this archive to a separate folder/repo; do not overwrite the live or current VS Code repo.
- [ ] 5. Build/run the preview with the already-approved project dependencies and environment variables; do not deploy to production for this test.
- [ ] 6. Confirm the preview opens on desktop, iPhone Safari and Android Chrome without a blank page or an obvious runtime error.

## Consent, privacy and Settings

- [ ] 7. In a fresh browser profile, open the app and confirm the full-screen notice blocks the rest of the UI.
- [ ] 8. Try to agree before scrolling to the end; confirm the checkbox/button is disabled.
- [ ] 9. Scroll to the end, check the acknowledgement and agree; confirm the app becomes interactive.
- [ ] 10. Refresh and confirm the same notice version does not repeat after agreement.
- [ ] 11. Open Settings and confirm the info button is beside Close; open Tips/Terms and check the copy wraps properly on a phone.
- [ ] 12. In development controls, replay the notice and verify agreement is required again.
- [ ] 13. Confirm dev-only tools are not visible in a normal production build unless the explicit dev-tools flag is intentionally enabled.

## Home subject carousel

- [ ] 14. Set up at least three classes today, with one ongoing or the earliest upcoming; confirm that class is focused on initial load.
- [ ] 15. On iPhone Safari, swipe left/right deliberately and confirm the carousel moves freely with smooth native scrolling.
- [ ] 16. On Android Chrome, repeat with several fast swipes; confirm no jagged jump, sticky pointer behavior or fighting with vertical scroll.
- [ ] 17. Manually select another card, wait, mark another class or cause a UI update; confirm focus logic does not pull the carousel back from your manual choice.
- [ ] 18. On desktop, drag the carousel with the mouse and confirm action buttons are still tappable/clickable.
- [ ] 19. Confirm each tile has a three-dot menu containing Replace lecture, Cancel lecture and sleep controls.
- [ ] 20. Open Replace from a tile and verify it opens the styled class-change sheet with date selection, subject cards, search and tags.
- [ ] 21. Mark Present/Absent and Undo (where available); check marks, percentages and counts update exactly once.
- [ ] 22. Mark every class for the day and confirm widgets stay visible below the carousel/finished state without refresh.
- [ ] 23. Open Today on a day with no classes and confirm the empty state still shows widgets and its Add Subject action.

## Subject detail and sleep

- [ ] 24. Open a subject that has no class today; confirm Add Present and Add Absent are still shown.
- [ ] 25. Use both controls for a no-class day; verify the day's untimed attendance mark and totals update.
- [ ] 26. Open a subject with a scheduled class today; verify the correct class time is shown and per-class buttons mark that slot, not an unrelated slot.
- [ ] 27. Open the subject's three-dot menu and choose Put subject to sleep; read the explanation and choose a short duration.
- [ ] 28. Confirm sleep only after the explanation; verify a toast explains that timetable/attendance are preserved.
- [ ] 29. Confirm sleeping hides this subject's recurring classes from Today, Calendar and timetable-generated reminders for the sleep period, while its detail/history still exists.
- [ ] 30. Confirm old attendance marks, attended/missed counts, tags and weekly slots were not deleted.
- [ ] 31. Test 1 week, 2 weeks, 1 month, custom end date and Forever; finite sleep should include its end date and wake the next day.
- [ ] 32. Wake the subject early from its menu; confirm its timetable returns without duplicate slots or lost marks.
- [ ] 33. Test a timed sleep while checking forecasts: classes after the chosen wake date should appear in the future projection again.

## Calendar class changes

- [ ] 34. Open Calendar; verify every class row has its three-dot menu for Replace/Cancel and subject sleep where applicable.
- [ ] 35. Pick a future class and choose Cancel lecture; verify the styled confirmation describes a date-specific change and requires confirmation.
- [ ] 36. Confirm cancellation; the class should appear cancelled in Calendar but not in Today or QR/scan selection for that date.
- [ ] 37. Use the same menu to restore the cancelled class; verify the class returns for that date only.
- [ ] 38. Open Replace lecture; verify subject options are styled cards, not a generic HTML select box.
- [ ] 39. Filter subjects by one tag, another tag, All tags and text search; confirm the available subject cards change correctly.
- [ ] 40. Substitute another active subject; confirm the replacement uses the old slot's exact start/end time and the original subject isn't also shown in that slot.
- [ ] 41. Verify the next recurring week remains unchanged; substitution must affect only the selected occurrence.
- [ ] 42. Change the substitute and undo/restore; confirm the underlying original class returns.
- [ ] 43. Try selecting the same subject or an inactive/sleeping replacement; ensure invalid substitution is blocked.
- [ ] 44. Refresh/reopen the date and confirm cancel/substitute survives.
- [ ] 45. Confirm the hamburger actions are available from both the Calendar and Today carousel, not only from a dedicated detail screen.

## Holidays

- [ ] 46. Navigate month by month through 2026; confirm all 25 supplied dates appear on the calendar.
- [ ] 47. Confirm both Maharashtra Day and Buddha Purnima show on 1 May 2026.
- [ ] 48. Confirm both Independence Day and Parsi New Year show on 15 August 2026.
- [ ] 49. Add a custom single-day holiday; verify it shows in the calendar and day details.
- [ ] 50. Add a holiday range with a start and end date; confirm both endpoints and every day between them show it.
- [ ] 51. Confirm the day after a holiday range no longer shows the holiday.
- [ ] 52. Refresh and confirm user-added holiday dates persist; delete the custom holiday and confirm it disappears.
- [ ] 53. Confirm default holidays are not deletable and two observances on the same date are not collapsed into one.

## Data, backups and cloud sync

- [ ] 54. Create a new holiday and schedule override, then export a full backup; confirm JSON includes `holidays` and `scheduleOverrides`.
- [ ] 55. Restore that backup into an empty separate test profile; verify data appears and no unrelated account data is included.
- [ ] 56. Import an older backup that lacks the new fields; ensure the old file parses and old local holiday/override state isn't silently erased where the restore logic identifies it as unrecorded.
- [ ] 57. Add the same custom holiday independently on two test devices and sync; confirm duplicates are collapsed.
- [ ] 58. Add the same cancellation/substitution independently on two devices and sync; confirm there is one override per source/date/time slot.
- [ ] 59. Create opposing changes to the same slot on two devices; confirm a conflict is surfaced/restore point saved instead of showing two conflicting rows.
- [ ] 60. Sign out and sign into a second test account; confirm subjects, marks, holidays and overrides do not leak across users.
- [ ] 61. Change attendance on device A, wait for Up to date, verify device B receives it, change on B and verify A gets the update.
- [ ] 62. Repeat with local/offline edits and reconnect; ensure no attendance marks are lost or added twice.
- [ ] 63. In a fresh profile with existing data but no cloud account, wait/test the 2-day reminder via dev tools; confirm it appears and dismissal persists for the configured interval.
- [ ] 64. Click Set up Google sync from that reminder; Settings must open straight to Sync rather than the Settings home screen.
- [ ] 65. After cloud sync is active, confirm the reminder hides.

## Mates and connected in-app Ping

- [ ] 66. Add two Mates with the same display name but separate IDs; verify they remain separate rows.
- [ ] 67. Connect two real test accounts; verify account UIDs, not names, determine the connection and recipient of actions.
- [ ] 68. Send/accept a Mates connection request and refresh; confirm only the correct account appears connected.
- [ ] 69. Send a direct in-app Ping for selected classes; answer it from the other account and verify the sender receives the reply.
- [ ] 70. Confirm a Yes response is applied only to the selected class(es), once; No does not change attendance.
- [ ] 71. Confirm connected Mates use UID-safe waiting/removal/cancel behaviour even when two display names match.
- [ ] 72. Confirm Ping UI explains that a Yes response can change the sender's attendance record without repeating judgmental language.

## WhatsApp share-link Ping (no Mates connection needed)

- [ ] 73. From the Quick WhatsApp Ping card, select one or more classes and create a link with the sender signed in to the cloud backend.
- [ ] 74. Confirm the prefilled message is generic when no recipient/Mate is selected, includes class name/time and today/yesterday, contains the unique link, expires in 24 hours, and has no repeated honesty warning.
- [ ] 75. Open the URL in a private browser or a second device without signing into the app; confirm it shows a full-screen styled Yes/No form and does not ask to create a Mate account.
- [ ] 76. Submit Yes for one class and No for another; confirm it reports success exactly once.
- [ ] 77. Keep the sender's app open and verify the Ping response is received and processed; Yes sets the selected subject/class Present and No leaves it unchanged.
- [ ] 78. Close/reopen sender app after answering offline; confirm the waiting answer is received and applied after connection returns.
- [ ] 79. Reopen the link and try submitting a different answer; it must refuse a second response and show Already answered.
- [ ] 80. Try editing the URL ID, changing the subject name, adding fields or listing `sharePings`; the security rules must reject unauthorized access/mutations.
- [ ] 81. Test a new link after expiry; it must refuse the answer and tell the recipient to request a new link.
- [ ] 82. Verify share-link responses don't create a new Mate or a favour/reciprocity ledger entry.
- [ ] 83. If secure-link creation is unavailable, verify the UI still offers a plain WhatsApp message, and clearly warns that it won't update attendance automatically.
- [ ] 84. Do not release the WhatsApp flow until the updated `firestore.rules` passes emulator tests and has been approved/deployed to the correct Firebase project. No SQL is needed.

## Notifications and existing app regression

- [ ] 85. Use Settings → Notifications to allow notifications; test a local notification and record whether it appears.
- [ ] 86. Use the FCM test; token success must not be treated as proof of server-side delivery.
- [ ] 87. Test scheduled reminders with the app visible, backgrounded, suspended, and closed on each real device; browsers may throttle/stop local page timers.
- [ ] 88. Test actual FCM Ping notification delivery to a second test account in foreground/background/closed states only when existing Firebase sender setup is available.
- [ ] 89. Re-test subject add/edit/delete; attendance marks; tags; deadlines; timetable import; theme; offline launch; local persistence; Mates; QR scan; sign-out isolation; backup and restore.
- [ ] 90. Run the actual repo's documented typecheck, Vitest, lint, production build, Firestore rules tests and emulator suites with approved dependencies installed; record exit codes.
- [ ] 91. Check browser console and logs for React/runtime errors, IndexedDB write errors, failed sync, or rejected Firestore writes.
- [ ] 92. Compare the current working tree to this copy before merging; keep the original repo and a full data backup available for rollback.
- [ ] 93. Have the project owner explicitly approve the Firebase rules update and release only after the critical tests pass. No hosted deployment is included in this archive.

## K. Monthly subject attendance image report

- [ ] 77. Open a subject and use the monthly report download/share icon; verify the system share sheet receives a PNG image, not an HTML file (on unsupported browsers the fallback is a PNG download).
- [ ] 78. Verify subject title and tag are shown in the banner and the banner geometry changes on a new generation without a network call.
- [ ] 79. Confirm the report uses the app-style sans-serif typography and the whole footer is visible on the final image.
- [ ] 80. Check one green present date, one red absent date, one gray scheduled-but-unmarked date, one dashed cancelled date, and one purple-outlined replaced date.
- [ ] 81. Test months with 4, 5 and 6 calendar rows; make sure last dates, legend and footer do not clip.
- [ ] 82. Test a subject with multiple class sessions on one day; the calendar summarizes consistent marks as green/red and keeps partially-marked or mixed dates neutral.
- [ ] 83. Test a long subject name and multiple tags; confirm the heading/tag stay readable and do not run outside the banner.

## Monthly report share concurrency regression (added Oct 21, 2026)

- [ ] 77. Tap the subject's monthly report/share button once; confirm the icon enters a busy state and cannot be tapped again until complete.
- [ ] 78. Rapidly double-tap the button; confirm only one share sheet or one PNG download occurs.
- [ ] 79. While a platform share sheet is open, trigger no second share; confirm there is no `InvalidStateError` console error.
- [ ] 80. If a platform/older browser rejects file sharing with `InvalidStateError` or `NotAllowedError`, confirm the app saves the PNG instead and displays a quiet status message.
- [ ] 81. Cancel the native share sheet; confirm the app does not start an unsolicited file download and does not log an unhandled rejection.
- [ ] 82. Test on iOS Safari and Android Chrome with share destinations available; confirm the native share sheet receives a PNG image rather than HTML.


## Localhost Mates sign-in smoke test (added Oct 21, 2026)

- [ ] 94. Extract the complete archive into a separate working folder and copy the existing `.env.local` into that folder locally; never add it to the ZIP or share it.
- [ ] 95. Confirm `NEXT_PUBLIC_FIREBASE_PROJECT_ID` is the same Firebase project where Anonymous sign-in is enabled.
- [ ] 96. Confirm both `NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST` and `NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST` are unset unless both local emulators are running.
- [ ] 97. Stop the dev server, remove only the generated `.next` cache, restart `npm run dev`, and hard-refresh localhost.
- [ ] 98. Open Mates and wait 10–12 seconds. Expect either a unique account code or an actionable `Couldn't connect` error; the generic old setup spinner must not persist.
- [ ] 99. If it fails, inspect DevTools Network for the Firebase Auth request status and share only the error code/status, never `.env.local` or full URLs/credentials.
- [ ] 100. Verify two separate browser profiles against the same Firebase project can exchange unique account codes, send a connection request and accept it.
- [ ] 101. Confirm `NEXT_PUBLIC_APP_URL` is only for cross-device links: use account codes for localhost connection tests and a public HTTPS preview for QR/magic/WhatsApp links.


## Addendum — Firebase push registration on localhost (2026-10-21)

- [ ] Open `brave://settings/privacy`, enable **Use Google services for push messaging**, then fully relaunch Brave.
- [ ] In Firebase Console → Project settings → Cloud Messaging → Web Push certificates, copy the **public VAPID key** into `.env.local` as `NEXT_PUBLIC_FIREBASE_VAPID_KEY`. Do not put the private key in a `NEXT_PUBLIC_*` variable.
- [ ] Restart `npm run dev` after editing `.env.local`; Next.js inlines public environment values at startup/build time.
- [ ] In Settings → developer tools → Test FCM token, confirm the app either gets a token or reports a useful configuration/browser error without a red uncaught AbortError. Never post the full FCM token in a screenshot or chat.
- [ ] Confirm attendance and Mates still work when remote push is unavailable; class reminders can remain app-open/local only.
- [ ] Test the deployed HTTPS domain separately. A successful token registration does not prove server-side notification delivery.

## Direct in-app Pings and one-day WhatsApp links

- [ ] Verify an anonymous account sees in-app Ping disabled and can still create a WhatsApp Ping link.
- [ ] Verify a Google-signed-in account with no accepted connections sees in-app Ping unavailable with instructions to connect a friend.
- [ ] Connect two Google-signed-in test accounts and accept the request on the receiving account; verify the sender now sees the In-app Ping option.
- [ ] Send an in-app Ping and confirm it appears only in the receiving account's Mates inbox.
- [ ] Switch the same connected Ping sheet to WhatsApp link mode and verify the generated URL uses the public HTTPS origin, not localhost.
- [ ] Open the share link on a second device, verify it can be answered once, then attempt a second answer and confirm it is rejected.
- [ ] Verify the share link expires after 24 hours and the Firestore rules reject attempts to create a sharePings record lasting more than 24 hours.
- [ ] From localhost, set NEXT_PUBLIC_APP_URL to the deployed HTTPS site using the same Firebase project, restart the server, and verify an interactive link is generated.


## Localhost official Ping link setup

- [ ] In `.env.local`, set `NEXT_PUBLIC_APP_URL` to a deployed public HTTPS preview that already contains the `/ping/[id]` route and uses the same Firebase project as this localhost app.
- [ ] Restart `npm run dev` after changing the variable; Next.js inlines public environment values at server startup.
- [ ] From the general WhatsApp Ping form, select classes and press `Create official 24-hour link`. Confirm a real `/ping/<64 hex characters>` URL appears before sharing.
- [ ] If creation fails, verify the red error state reports the exact reason and does not auto-share a misleading plain message. Use the explicit plain-message option only if you accept that the reply must be recorded manually.
- [ ] Open the link on another browser/device while still within 24 hours; submit Yes/No once; verify the sender sees and applies the answer. Try a second answer and an expired link; both should be rejected.
- [ ] In-app Pings: use Google sign-in and complete/accept a connection first. Anonymous sessions and unconnected proxy-mates must not send direct in-app Pings. The general Ping form may offer a button to choose a connected friend when eligible.
- [ ] Confirm direct in-app Ping still uses the accepted connection and does not create a public response link.
