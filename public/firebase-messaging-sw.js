// Import Firebase scripts for FCM
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-messaging-compat.js');

// Initialize Firebase with your project config
firebase.initializeApp({
  apiKey: "AIzaSyBluLV5tPfhnyVIsTBYTWvqw-4SednixSI",
  authDomain: "college-tracker-2024.firebaseapp.com",
  projectId: "college-tracker-2024",
  storageBucket: "college-tracker-2024.firebasestorage.app",
  messagingSenderId: "798618910788",
  appId: "1:798618910788:web:8437756701cffc76743c11"
});

// Retrieve an instance of Firebase Messaging
const messaging = firebase.messaging();

// Optional: Handle background messages
messaging.onBackgroundMessage(function(payload) {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);

  const notificationTitle = payload.notification?.title || 'College Tracker';
  const notificationOptions = {
    body: payload.notification?.body || 'You have a new notification',
    icon: '/favicon-192.png', // Adjust icon if needed
    badge: '/favicon-192.png', // optional
    tag: payload.notification?.tag || 'notification'
  };

  self.registration.showNotification(notificationTitle, notificationOptions);
});
