// lib/firebase.ts
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getAuth, connectAuthEmulator } from 'firebase/auth';
import { getFirestore, connectFirestoreEmulator } from 'firebase/firestore';
import { getMessaging, isSupported } from 'firebase/messaging';
import { isPushServiceUnavailable, resolveFirebaseVapidKey } from './push-config';

const firebaseConfig = {
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY!,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN!,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID!,
  storageBucket: process.env.NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET!,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID!,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID!,
  measurementId: process.env.NEXT_PUBLIC_FIREBASE_MEASUREMENT_ID,
};

export const app = !getApps().length ? initializeApp(firebaseConfig) : getApp();
export const db = getFirestore(app);

/**
 * LOCAL INTEGRATION TESTS ONLY. When both NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST and NEXT_PUBLIC_FIREBASE_FIRESTORE_EMULATOR_HOST are set
 * (host:port, loopback only) in a NON-production build, Firebase Auth and Firestore talk to the local emulators instead of Firebase, so a
 * test build can never reach the real project. Anything else is ignored: unset in every real build; a production build ignores it
 * completely; one half set without the other, or a non-loopback host, does nothing (it never half-connects).
 */
const LOOPBACK_HOSTPORT = /^(127\.0\.0\.1|localhost|\[::1\]):\d{2,5}$/;
const authEmulatorHost = process.env.NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST?.trim() ?? '';
const firestoreEmulatorHost = process.env.NEXT_PUBLIC_FIRESTORE_EMULATOR_HOST?.trim() ?? '';
export const usingFirebaseEmulators =
  process.env.NODE_ENV !== 'production' && LOOPBACK_HOSTPORT.test(authEmulatorHost) && LOOPBACK_HOSTPORT.test(firestoreEmulatorHost);

if (usingFirebaseEmulators && typeof window !== 'undefined') {
  const g = globalThis as unknown as { __firebaseEmulatorsConnected?: boolean };
  if (!g.__firebaseEmulatorsConnected) {
    g.__firebaseEmulatorsConnected = true; // once per page, also across hot reloads
    try {
      connectAuthEmulator(getAuth(app), `http://${authEmulatorHost}`, { disableWarnings: true });
      const [host, port] = firestoreEmulatorHost.replace(/^\[|\]$/g, '').split(/:(?=\d+$)/);
      connectFirestoreEmulator(db, host, Number(port));
    } catch {
      /* already connected */
    }
  }
}

/** True when the Firebase keys are in .env.local. Without them there is no push, and the rest of the app works locally. */
export const firebaseConfigured = () =>
  Boolean(
    process.env.NEXT_PUBLIC_FIREBASE_API_KEY &&
      process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID &&
      process.env.NEXT_PUBLIC_FIREBASE_APP_ID &&
      process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  );

// Safe function to get messaging in the browser
export const getClientMessaging = async () => {
  if (typeof window === 'undefined') return null; // prevents server-side execution
  // getMessaging() throws "missing projectId" on an app with no config, so skip it quietly
  if (!firebaseConfigured()) return null;
  if (usingFirebaseEmulators) return null; // no push service in the local emulator setup
  if (!(await isSupported())) return null;
  return getMessaging(app);
};

export const getFirebaseVapidKey = () =>
  resolveFirebaseVapidKey(
    process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY,
    process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
  );

export const requestFCMToken = async () => {
  try {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator) || !('PushManager' in window)) return null;
    const vapidKey = getFirebaseVapidKey();
    if (!vapidKey) {
      console.warn('FCM token not requested: set NEXT_PUBLIC_FIREBASE_VAPID_KEY (or the legacy NEXT_PUBLIC_VAPID_PUBLIC_KEY) in .env.local.');
      return null;
    }
    const messaging = await getClientMessaging();
    if (!messaging) return null;
    const { getToken } = await import('firebase/messaging');
    // Ensure the root-scoped worker is active before asking the browser push service to subscribe.
    await navigator.serviceWorker.register('/sw.js', { scope: '/' });
    const registration = await navigator.serviceWorker.ready;
    if (!registration.active) {
      console.warn('FCM token not requested: the service worker is not active yet.');
      return null;
    }
    return await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration });
  } catch (error) {
    if (isPushServiceUnavailable(error)) {
      // Push is an optional enhancement. A browser push-service failure must not break attendance or Mates.
      console.warn('Remote push subscription is unavailable in this browser/profile; non-push features remain available.');
    } else {
      const e = error && typeof error === 'object' ? error as { code?: unknown; name?: unknown } : {};
      console.warn('FCM token setup failed.', { code: e.code, name: e.name });
    }
    return null;
  }
};

export const onMessageListener = async (callback: (payload: any) => void) => {
  const messaging = await getClientMessaging();
  if (!messaging) return;
  const { onMessage } = await import('firebase/messaging');
  onMessage(messaging, callback);
};
