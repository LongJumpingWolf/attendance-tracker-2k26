// Service Worker for College Tracker
// Handles Firebase Cloud Messaging and push notifications

// SECURITY NOTE: These Firebase credentials are client-side configuration
// and are designed to be public. Security is enforced through:
// 1. Firestore Security Rules (see firestore.rules)
// 2. Firebase Console domain restrictions
// 3. Proper authentication (if implemented)

// Import Firebase scripts for FCM
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-messaging-compat.js');

// Fetch Firebase config from environment
// Note: Service workers can't access environment variables directly,
// so we fetch from an API endpoint
let firebaseConfig = null;

async function initializeFirebase() {
  try {
    // Try to fetch config from API endpoint
    const response = await fetch('/api/firebase-config');
    if (response.ok) {
      firebaseConfig = await response.json();
    } else {
      // Fallback to hardcoded config if API fails
      console.warn('Failed to fetch Firebase config from API, using fallback');
      firebaseConfig = {
        apiKey: "AIzaSyBluLV5tPfhnyVIsTBYTWvqw-4SednixSI",
        authDomain: "college-tracker-2024.firebaseapp.com",
        projectId: "college-tracker-2024",
        storageBucket: "college-tracker-2024.firebasestorage.app",
        messagingSenderId: "798618910788",
        appId: "1:798618910788:web:8437756701cffc76743c11"
      };
    }

    // Initialize Firebase with config
    firebase.initializeApp(firebaseConfig);

    // Retrieve an instance of Firebase Messaging
    const messaging = firebase.messaging();

    // Handle background messages from Firebase
    messaging.onBackgroundMessage(function(payload) {
      console.log('[sw.js] Received background message ', payload);

      const notificationTitle = payload.notification?.title || 'College Tracker';
      const notificationOptions = {
        body: payload.notification?.body || 'You have a new notification',
        icon: '/favicon-192.png',
        badge: '/favicon-192.png',
        tag: payload.notification?.tag || 'notification',
        data: payload.data || {}
      };

      self.registration.showNotification(notificationTitle, notificationOptions);
    });

    console.log('Firebase initialized successfully');
  } catch (error) {
    console.error('Failed to initialize Firebase:', error);
  }
}

// Handle push events (for non-Firebase push notifications)
self.addEventListener('push', event => {
  // Skip if this is handled by Firebase
  if (event.data) {
    try {
      const data = event.data.json();
      const title = data.title || 'College Tracker';
      const options = {
        body: data.body || 'You have a new notification',
        icon: '/favicon-192.png',
        badge: '/favicon-192.png',
        tag: data.tag || 'notification',
        data: data.data || {}
      };

      event.waitUntil(self.registration.showNotification(title, options));
    } catch (e) {
      console.log('Error parsing push data:', e);
    }
  }
});

// Handle notification clicks
self.addEventListener('notificationclick', event => {
  event.notification.close();

  if (event.action === 'open' || !event.action) {
    event.waitUntil(
      (async () => {
        const notificationData = event.notification?.data || {};

        // Construct target URL
        let targetUrl = '/';
        try {
          if (notificationData.url) {
            targetUrl = notificationData.url;
          } else if (notificationData.subject) {
            const params = new URLSearchParams({
              subject: notificationData.subject || '',
              time: notificationData.time || '',
              day: notificationData.day || '',
              type: notificationData.type || '',
              fromNotification: 'true',
            });
            targetUrl = `/attendance/mark?${params.toString()}`;
          }
        } catch (err) {
          console.error('Error constructing target URL:', err);
          targetUrl = '/';
        }

        // Try to focus existing window or open new one
        const windowClients = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        for (const client of windowClients) {
          if (client.url.includes(targetUrl) && 'focus' in client) {
            return client.focus();
          }
        }

        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      })()
    );
  }
});

// Handle notification close
self.addEventListener('notificationclose', event => {
  console.log('Notification closed:', event.notification?.tag);
});

// Service worker installation
self.addEventListener('install', event => {
  console.log('Service Worker installing...');
  self.skipWaiting();
});

// Service worker activation
self.addEventListener('activate', event => {
  console.log('Service Worker activating...');
  event.waitUntil(
    (async () => {
      // Initialize Firebase when service worker activates
      await initializeFirebase();
      // Claim all clients immediately
      await clients.claim();
      console.log('Service Worker activated and ready');
    })()
  );
});
