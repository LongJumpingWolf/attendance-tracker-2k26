// lib/firebase.ts
import { initializeApp, getApps, getApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getMessaging, isSupported } from 'firebase/messaging';

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
  if (!(await isSupported())) return null;
  return getMessaging(app);
};

export const requestFCMToken = async () => {
  try {
    const messaging = await getClientMessaging();
    if (!messaging) return null;
    const { getToken } = await import('firebase/messaging');
    const token = await getToken(messaging, {
      vapidKey: process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY,
      serviceWorkerRegistration: await navigator.serviceWorker.register('/sw.js')
    });
    return token;
  } catch (error) {
    console.error('Error getting FCM token:', error);
    return null;
  }
};

export const onMessageListener = async (callback: (payload: any) => void) => {
  const messaging = await getClientMessaging();
  if (!messaging) return;
  const { onMessage } = await import('firebase/messaging');
  onMessage(messaging, callback);
};
