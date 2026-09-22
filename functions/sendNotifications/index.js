const functions = require('firebase-functions');
const admin = require('firebase-admin');

admin.initializeApp();

exports.sendScheduledNotifications = functions.pubsub.schedule('every 1 minutes').onRun(async (context) => {
  const db = admin.firestore();
  const messaging = admin.messaging();

  // Get all notification settings
  const settingsSnapshot = await db.collection('notificationSettings').get();

  const now = new Date();

  for (const doc of settingsSnapshot.docs) {
    const data = doc.data();
    const { fcmToken, notificationTimes, timezone } = data;

    if (!fcmToken || !notificationTimes || !timezone) continue;

    // Convert current time to user's timezone
    const userTime = new Date(now.toLocaleString('en-US', { timeZone: timezone }));
    const currentTime = userTime.toTimeString().slice(0, 5); // HH:MM

    // Check if current time matches any notification time
    if (notificationTimes.includes(currentTime)) {
      // Send notification
      const message = {
        token: fcmToken,
        notification: {
          title: 'College Tracker Reminder',
          body: 'Time for your scheduled check-in!',
        },
        data: {
          url: 'https://your-app-url.com', // Replace with your app URL
        },
      };

      try {
        await messaging.send(message);
        console.log('Notification sent to', fcmToken);
      } catch (error) {
        console.error('Error sending notification:', error);
      }
    }
  }

  return null;
});