// Notification utility hook for managing push notifications with FCM
import { requestFCMToken, onMessageListener, db, firebaseConfigured } from './firebase';
import { ensureSignedIn } from './social';
import { addDoc, collection, serverTimestamp, getDocs, deleteDoc, query, where } from 'firebase/firestore';

export async function requestNotificationPermission() {
  // Check if notifications are supported
  if (!('Notification' in window)) {
    console.warn('❌ This browser does not support notifications');
    return false;
  }

  // If already granted, return true
  if (Notification.permission === 'granted') {
    console.log('✅ Notification permission already granted');
    return true;
  }

  // If permission denied, don't ask again
  if (Notification.permission === 'denied') {
    console.warn('⚠️ Notification permission was previously denied');
    return false;
  }

  // Request permission - this should show the browser prompt
  try {
    console.log('📢 Requesting notification permission from browser...');
    const permission = await Notification.requestPermission();
    console.log('📢 Browser permission response:', permission);
    return permission === 'granted';
  } catch (error) {
    console.error('❌ Error requesting notification permission:', error);
    return false;
  }
}

export async function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    console.warn('Service Workers are not supported');
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register('/sw.js', {
      scope: '/',
    });
    console.log('✅ Service Worker registered successfully');
    return registration;
  } catch (error) {
    console.error('❌ Service Worker registration failed:', error);
    return null;
  }
}

export async function subscribeToPushNotifications() {
  try {
    const token = await requestFCMToken();
    if (token) {
      console.log('✅ FCM token obtained');
      return { token };
    }
  } catch (error) {
    console.error('⚠️ FCM subscription failed:', error);
  }
  return null;
}

export async function sendLocalNotification(title: string, options?: NotificationOptions) {
  if (Notification.permission !== 'granted') {
    console.warn('Notification permission not granted');
    return;
  }

  try {
    const registration = await navigator.serviceWorker.ready;
    await registration.showNotification(title, {
      icon: '/favicon-192.png',
      badge: '/favicon-192.png',
      ...options,
    });
  } catch (error) {
    console.error('Error sending notification:', error);
  }
}

export { onMessageListener };

export async function importNotificationSchedule(jsonString: string): Promise<{ success: boolean, errors: string[] }> {
  const errors: string[] = []
  try {
    const parsed = JSON.parse(jsonString)

    if (!parsed.timezone || typeof parsed.timezone !== 'string') {
      errors.push('Invalid timezone')
    }
    if (!Array.isArray(parsed.subjects)) {
      errors.push('Subjects must be an array')
    } else {
      for (const subject of parsed.subjects) {
        if (!subject.title || typeof subject.title !== 'string') {
          errors.push('Each subject must have a title')
        }
        if (!subject.message || typeof subject.message !== 'string') {
          errors.push('Each subject must have a message')
        }
        if (!subject.schedule || typeof subject.schedule !== 'object') {
          errors.push('Each subject must have a schedule object')
        } else {
          for (const [day, times] of Object.entries(subject.schedule)) {
            if (!Array.isArray(times)) {
              errors.push(`Schedule for ${day} must be an array`)
            } else {
              for (const time of times) {
                if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(time)) {
                  errors.push(`Invalid time format: ${time} for ${day}`)
                }
              }
            }
          }
        }
      }
    }

    if (errors.length > 0) {
      return { success: false, errors }
    }

    if (!firebaseConfigured()) {
      return { success: false, errors: ["Firebase isn't set up yet, so a schedule can't be saved to the server."] }
    }
    const user = await ensureSignedIn()
    const fcmToken = await requestFCMToken()
    if (!fcmToken) {
      return { success: false, errors: ['Failed to get FCM token'] }
    }

    // Replace only this account's schedule. Other people's schedules are never touched.
    const mine = await getDocs(query(collection(db, 'notificationSchedules'), where('owner', '==', user.uid)));
    await Promise.all(mine.docs.map((d) => deleteDoc(d.ref)));

    const promises = []
    for (const subject of parsed.subjects) {
      for (const [day, times] of Object.entries(subject.schedule) as [string, string[]][]) {
        for (const time of times) {
          promises.push(addDoc(collection(db, 'notificationSchedules'), {
            owner: user.uid,
            fcmToken,
            timezone: parsed.timezone,
            day,
            time,
            title: subject.title,
            body: subject.message,
            enabled: true,
            lastSent: null,
            createdAt: serverTimestamp()
          }))
        }
      }
    }

    await Promise.all(promises)

    return { success: true, errors: [] }
  } catch {
    return { success: false, errors: ['Invalid JSON'] }
  }
}
