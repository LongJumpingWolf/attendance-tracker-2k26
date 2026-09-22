const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

exports.sendScheduledNotifications = functions.https.onRequest(async (req, res) => {
  console.log('Running sendScheduledNotifications via HTTP at', new Date().toISOString());

  const now = new Date();
  const kolkataTime = new Date(now.toLocaleString("en-US", {timeZone: "Asia/Kolkata"}));

  const currentDay = kolkataTime.toLocaleLowerCase('en-US', { weekday: 'long' });
  const currentTime = kolkataTime.toTimeString().slice(0, 5); // HH:MM

  console.log(`Current day: ${currentDay}, time: ${currentTime}`);

  const db = admin.firestore();
  const schedulesRef = db.collection('notificationSchedules');
  const snapshot = await schedulesRef.get();

  if (snapshot.empty) {
    console.log('No schedules found');
    res.status(200).send('No schedules to send');
    return;
  }

  const promises = [];
  snapshot.forEach((doc) => {
    const data = doc.data();

    if (data.enabled !== true) return;
    if (data.day !== currentDay) return;
    if (data.time !== currentTime) return;

    const lastSent = data.lastSent;

    // Check if lastSent is null or not today
    if (lastSent) {
      const lastSentDate = lastSent.toDate();
      const today = new Date(kolkataTime.getFullYear(), kolkataTime.getMonth(), kolkataTime.getDate());
      if (lastSentDate >= today) {
        console.log(`Already sent today for schedule ${doc.id}`);
        return;
      }
    }

    // Send notification
    const message = {
      token: data.fcmToken,
      notification: {
        title: data.title,
        body: data.body,
      },
      webpush: {
        fcm_options: {
          link: '/',
        },
        notification: {
          icon: '/favicon-192.png',
        },
      },
    };

    const sendPromise = admin.messaging().send(message)
      .then(() => {
        console.log(`Sent notification for schedule ${doc.id}`);
        return doc.ref.update({ lastSent: admin.firestore.FieldValue.serverTimestamp() });
      })
      .catch((error) => {
        console.error(`Error sending notification for schedule ${doc.id}:`, error);
      });

    promises.push(sendPromise);
  });

  await Promise.all(promises);
  console.log('Finished sending scheduled notifications');
  res.status(200).send('Scheduled notifications sent');
});