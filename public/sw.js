// Service Worker for College Tracker
// Handles Firebase Cloud Messaging and push notifications

// SECURITY NOTE: These Firebase credentials are client-side configuration
// and are designed to be public. Security is enforced through:
// 1. Firestore Security Rules (see firestore.rules)
// 2. Firebase Console domain restrictions
// 3. Proper authentication (if implemented)

// Import Firebase scripts for FCM
// If these can't load (offline, or blocked) the worker must still install: the offline app shell below matters more.
try {
  importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-app-compat.js');
  importScripts('https://www.gstatic.com/firebasejs/9.22.2/firebase-messaging-compat.js');
} catch (e) {
  console.warn('[sw.js] Firebase scripts unavailable, push is off for now', e);
}

// ---- Offline app shell ----
// The app keeps its data on the device (IndexedDB), so opening it must never need the internet. Pages and the files
// they use are kept here after the first visit and served when the network is down. Data and API calls are never cached.
const SHELL = 'shell-v1';
const PAGE_KEY = '/__shell';

const fromNetworkWithTimeout = (req, ms) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('slow network')), ms);
    fetch(req).then(
      (res) => {
        clearTimeout(t);
        resolve(res);
      },
      (err) => {
        clearTimeout(t);
        reject(err);
      },
    );
  });

/** Page loads: fresh from the network when it answers quickly, otherwise the saved copy */
async function page(req) {
  const cache = await caches.open(SHELL);
  try {
    const res = await fromNetworkWithTimeout(req, 4000);
    if (res.ok) cache.put(PAGE_KEY, res.clone());
    return res;
  } catch (e) {
    const saved = await cache.match(PAGE_KEY);
    if (saved) return saved;
    throw e;
  }
}

/** Built files have a fingerprint in their name, so a saved copy never goes stale */
async function builtFile(req) {
  const cache = await caches.open(SHELL);
  const saved = await cache.match(req);
  if (saved) return saved;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

/** Icons and the manifest: show the saved copy now, refresh it in the background */
async function staleWhileRevalidate(req) {
  const cache = await caches.open(SHELL);
  const saved = await cache.match(req);
  const fresh = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  return saved || (await fresh) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js' || url.pathname === '/firebase-messaging-sw.js') return;
  if (req.mode === 'navigate') return event.respondWith(page(req));
  if (url.pathname.startsWith('/_next/static/')) return event.respondWith(builtFile(req));
  if (/\.(png|svg|ico|json|webmanifest)$/.test(url.pathname)) return event.respondWith(staleWhileRevalidate(req));
});

// Fetch Firebase config from environment
// Note: Service workers can't access environment variables directly,
// so we fetch from an API endpoint
let firebaseConfig = null;

async function initializeFirebase() {
  try {
    if (typeof firebase === 'undefined') return; // its scripts did not load; the offline shell still works
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
      // Drop saved shells from older versions of this worker
      for (const key of await caches.keys()) if (key.startsWith('shell-') && key !== SHELL) await caches.delete(key);
      // Initialize Firebase when service worker activates
      await initializeFirebase();
      // Claim all clients immediately
      await clients.claim();
      console.log('Service Worker activated and ready');
    })()
  );
});
