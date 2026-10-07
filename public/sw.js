// Service Worker for College Tracker
// 1. Keeps the app openable with no internet (the app shell, below).
// 2. Shows push notifications (a Ping) and opens the right place when one is tapped.
//
// It does not load Firebase. A push arrives here as plain data and the worker builds the notification itself, so
// delivery doesn't depend on any library starting up inside the worker (workers are stopped and restarted constantly).

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
  if (url.pathname.startsWith('/api/') || url.pathname === '/sw.js') return;
  if (req.mode === 'navigate') return event.respondWith(page(req));
  if (url.pathname.startsWith('/_next/static/')) return event.respondWith(builtFile(req));
  if (/\.(png|svg|ico|json|webmanifest)$/.test(url.pathname)) return event.respondWith(staleWhileRevalidate(req));
});

// ---- Notifications ----

/** A link from a notification, kept inside this app: anything pointing elsewhere falls back to the home page */
function safeUrl(value) {
  try {
    const u = new URL(value || '/', self.location.origin);
    if (u.origin !== self.location.origin) return '/';
    return u.pathname + u.search + u.hash;
  } catch (e) {
    return '/';
  }
}

/** What to show for a push: the message's own `data` (what the server sends), or a plain notification payload */
function describePush(payload) {
  const d = (payload && payload.data) || {};
  const n = (payload && payload.notification) || {};
  const title = d.title || n.title || (payload && payload.title) || 'College Tracker';
  const body = d.body || n.body || (payload && payload.body) || '';
  if (!d.title && !n.title && !(payload && payload.title) && !body) return null; // nothing worth showing
  return {
    title,
    options: {
      body,
      icon: '/favicon-192.png',
      badge: '/favicon-192.png',
      // The Ping's own id is the tag, so a repeat for the same Ping replaces the first instead of stacking
      tag: d.tag || n.tag || 'notification',
      data: { url: safeUrl(d.url), pingId: d.pingId || null, type: d.type || null },
    },
  };
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      let payload = {};
      try {
        payload = event.data ? event.data.json() : {};
      } catch (e) {
        return;
      }
      const info = describePush(payload);
      if (!info) return;
      // The app is open in front of the person: it shows the Ping itself (from its live connection), so a system
      // notification on top would only be a second copy of the same thing.
      if (info.options.data.type === 'ping') {
        const open = await clients.matchAll({ type: 'window', includeUncontrolled: true });
        if (open.some((c) => c.visibilityState === 'visible')) return;
      }
      await self.registration.showNotification(info.title, info.options);
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = safeUrl(data.url);
  event.waitUntil(
    (async () => {
      const open = await clients.matchAll({ type: 'window', includeUncontrolled: true });
      const here = open.find((c) => 'focus' in c);
      if (here) {
        await here.focus();
        // The app is already running: tell it which Ping, instead of reloading it
        if (data.pingId) here.postMessage({ type: 'open-ping', id: data.pingId });
        return;
      }
      if (clients.openWindow) return clients.openWindow(url);
    })(),
  );
});

// Service worker installation
self.addEventListener('install', event => {
  self.skipWaiting();
});

// Service worker activation
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      // Drop saved shells from older versions of this worker
      for (const key of await caches.keys()) if (key.startsWith('shell-') && key !== SHELL) await caches.delete(key);
      // Claim all clients immediately
      await clients.claim();
    })()
  );
});
