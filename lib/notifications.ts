// Notification helpers: permission, the service worker, the FCM token (used for mate alerts) and local notifications
import { SW_OPTIONS, SW_URL } from './sw-config';
import { requestFCMToken, onMessageListener } from './firebase';

export async function requestNotificationPermission() {
  // Check if notifications are supported
  if (!('Notification' in window)) {
    console.warn('❌ This browser does not support notifications');
    return false;
  }

  // If already granted, return true
  if (Notification.permission === 'granted') {
    return true;
  }

  // If permission denied, don't ask again
  if (Notification.permission === 'denied') {
    console.warn('⚠️ Notification permission was previously denied');
    return false;
  }

  // Request permission - this should show the browser prompt
  try {
    const permission = await Notification.requestPermission();
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
    const registration = await navigator.serviceWorker.register(SW_URL, SW_OPTIONS);
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
      return { token };
    }
  } catch (error) {
    console.error('⚠️ FCM subscription failed:', error);
  }
  return null;
}

export async function sendLocalNotification(title: string, options?: NotificationOptions): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window) || Notification.permission !== 'granted') return false
  if (!('serviceWorker' in navigator)) return false
  try {
    const registration = await navigator.serviceWorker.ready
    await registration.showNotification(title, { icon: '/favicon-192.png', badge: '/favicon-192.png', ...options })
    return true
  } catch (error) {
    console.error('Error sending notification:', error)
    return false
  }
}

export { onMessageListener };
