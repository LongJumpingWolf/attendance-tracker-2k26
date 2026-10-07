/**
 * The Ping Cloud Functions. What it takes to run them for real:
 *
 *  - The Firebase project must be on the Blaze (pay-as-you-go) plan: Cloud Functions, and the scheduled clean-up, need it.
 *    Ping volumes are tiny, so the free monthly allowance covers them, but the plan has to be switched on.
 *  - Deploy:  firebase deploy --only functions,firestore:rules   (Node 20; region asia-south1)
 *  - Push uses Firebase Cloud Messaging with the project's Web Push key pair, which the app needs as
 *    NEXT_PUBLIC_FIREBASE_VAPID_KEY. Each person's browser token is stored in pushTokens/{uid} when they allow notifications.
 *  - The app's own service worker (public/sw.js) shows the notification from the message's `data`, and opens
 *    /?ping=<id> when it is tapped. Nothing else runs inside the worker.
 *
 * None of this can run from a laptop without the real project. tests/ping-push.test.ts tests the logic with fakes.
 */
const functions = require('firebase-functions');
const admin = require('firebase-admin');
const { makeHandlers } = require('./ping-handlers');

const region = functions.region('asia-south1');

const handlers = makeHandlers({
  getToken: async (uid) => {
    const snap = await admin.firestore().collection('pushTokens').doc(uid).get();
    return snap.exists ? snap.data().token : null;
  },
  deleteToken: (uid) => admin.firestore().collection('pushTokens').doc(uid).delete(),
  send: (message) => admin.messaging().send(message),
});

/** A mate asked "did you mark me present?" -> tell the person who was asked (the message names no class) */
exports.onPingCreated = region.firestore.document('pings/{id}').onCreate((snap, context) => handlers.onCreated(snap.data(), context.params.id));

/** The mate answered -> tell the person who asked */
exports.onPingAnswered = region.firestore
  .document('pings/{id}')
  .onUpdate((change, context) => handlers.onUpdated(change.before.data(), change.after.data(), context.params.id));

/**
 * Pings older than the 30-day history window are removed for good, answered or not (the rules stop people deleting an
 * unapplied answer; this runs with admin rights). Runs daily.
 */
exports.cleanUpPings = region.pubsub.schedule('every 24 hours').timeZone('Asia/Kolkata').onRun(async () => {
  const cutoff = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const old = await admin.firestore().collection('pings').where('date', '<', cutoff).limit(400).get();
  const batch = admin.firestore().batch();
  old.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  console.log(`Removed ${old.size} pings older than ${cutoff}`);
});
