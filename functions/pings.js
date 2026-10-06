const functions = require('firebase-functions');
const admin = require('firebase-admin');

const region = functions.region('asia-south1');

async function tokenFor(uid) {
  const snap = await admin.firestore().collection('pushTokens').doc(uid).get();
  return snap.exists ? snap.data().token : null;
}

async function push(uid, title, body) {
  const token = await tokenFor(uid);
  if (!token) return;
  try {
    await admin.messaging().send({
      token,
      notification: { title, body },
      data: { url: '/', type: 'ping' },
      webpush: { fcm_options: { link: '/' }, notification: { icon: '/favicon-192.png', tag: 'ping' } },
    });
  } catch (e) {
    // A token that is no longer valid is dropped so we stop trying it
    if (e.code === 'messaging/registration-token-not-registered' || e.code === 'messaging/invalid-registration-token') {
      await admin.firestore().collection('pushTokens').doc(uid).delete();
    } else {
      console.error(`Ping push to ${uid} failed`, e);
    }
  }
}

const list = (items) => items.map((i) => i.name).join(', ');

/** A mate asked "did you mark me present?" -> alert the person who was asked */
exports.onPingCreated = region.firestore.document('pings/{id}').onCreate((snap) => {
  const p = snap.data();
  return push(p.to, `${p.fromName} is asking`, `Did you mark them present in ${list(p.items)}?`);
});

/** The mate answered -> alert the person who asked */
exports.onPingAnswered = region.firestore.document('pings/{id}').onUpdate((change) => {
  const before = change.before.data();
  const after = change.after.data();
  if (before.status === 'answered' || after.status !== 'answered') return null;
  const yes = after.items.filter((i) => i.answer === 'yes').length;
  const body = yes === 0 ? 'said no' : yes === after.items.length ? 'covered you' : `covered you in ${yes} of ${after.items.length}`;
  return push(after.from, `${after.toName} replied`, body);
});

/** Pings older than the 30-day history window are removed for good (the sender's app also trims its own). Runs daily. */
exports.cleanUpPings = region.pubsub.schedule('every 24 hours').timeZone('Asia/Kolkata').onRun(async () => {
  const cutoff = new Date(Date.now() - 31 * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const old = await admin.firestore().collection('pings').where('date', '<', cutoff).limit(400).get();
  const batch = admin.firestore().batch();
  old.forEach((d) => batch.delete(d.ref));
  await batch.commit();
  console.log(`Removed ${old.size} pings older than ${cutoff}`);
});
