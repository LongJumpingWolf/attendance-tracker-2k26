'use client';

import { useEffect, useState } from 'react';
import { registerServiceWorker, subscribeToPushNotifications } from '@/lib/notifications';

export function useNotifications() {
    // --- Custom notification scheduling logic ---
    useEffect(() => {
      // Only run in browser
      if (typeof window === 'undefined') return;

      const FIRED_KEY = 'remindersFired';
      // A reminder still fires if the check runs a few minutes late (a throttled background tab, a phone that
      // just woke up), and never fires twice in one day.
      const GRACE_MIN = 10;

      const show = async (title: string, body: string) => {
        if (!('Notification' in window) || Notification.permission !== 'granted') return;
        const options = { body, icon: '/favicon-192.png', badge: '/favicon-192.png', data: { url: `${window.location.origin}/` } };
        try {
          // Phones only allow notifications made through the service worker
          const registration = await navigator.serviceWorker?.ready;
          if (registration) {
            await registration.showNotification(title, options);
            return;
          }
        } catch {
          /* fall through to the page notification */
        }
        try {
          new Notification(title, options);
        } catch {
          /* not allowed here */
        }
      };

      const check = () => {
        let schedule: any[] = [];
        try {
          const raw = localStorage.getItem('notificationSchedule');
          schedule = raw ? JSON.parse(raw) : [];
        } catch {
          return;
        }
        if (!Array.isArray(schedule) || schedule.length === 0) return;

        const now = new Date();
        const today = `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}`;
        const nowDay = now.getDay();
        const nowMinutes = now.getHours() * 60 + now.getMinutes();

        let fired: { date: string; ids: string[] } = { date: today, ids: [] };
        try {
          const saved = JSON.parse(localStorage.getItem(FIRED_KEY) || 'null');
          if (saved && saved.date === today && Array.isArray(saved.ids)) fired = saved;
        } catch {
          /* start fresh */
        }

        let changed = false;
        for (const entry of schedule) {
          if (entry.day !== nowDay) continue;
          const [startH, startM] = entry.startTime.split(':').map(Number);
          const [endH, endM] = entry.endTime.split(':').map(Number);
          const trigger = entry.notifyWhen === 'before' ? startH * 60 + startM - entry.notifyOffset : endH * 60 + endM + entry.notifyOffset;
          const late = nowMinutes - trigger;
          if (late < 0 || late > GRACE_MIN || fired.ids.includes(entry.id)) continue;

          fired.ids.push(entry.id);
          changed = true;
          const timeStr = `${formatTime(entry.startTime)} - ${formatTime(entry.endTime)}`;
          void show('Class Reminder', `${entry.subjectName}
${timeStr}
Tap to open the app.`);
        }
        if (changed) {
          try {
            localStorage.setItem(FIRED_KEY, JSON.stringify(fired));
          } catch {
            /* worst case it fires again on the next check */
          }
        }
      };

      check();
      const interval = setInterval(check, 30000);
      const onVisible = () => {
        if (document.visibilityState === 'visible') check();
      };
      document.addEventListener('visibilitychange', onVisible);
      return () => {
        clearInterval(interval);
        document.removeEventListener('visibilitychange', onVisible);
      };
    }, []);

    // Helper to format time as h:mm am/pm
    function formatTime(time: string) {
      const [h, m] = time.split(':').map(Number);
      const ampm = h >= 12 ? 'pm' : 'am';
      const hour = h % 12 === 0 ? 12 : h % 12;
      return `${hour}:${m.toString().padStart(2, '0')} ${ampm}`;
    }

  const [notificationSupported, setNotificationSupported] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState<NotificationPermission | null>(null);
  const [isSubscribed, setIsSubscribed] = useState(false);

  useEffect(() => {
    // Check notification support
    const supported = 'Notification' in window && 'serviceWorker' in navigator;
    setNotificationSupported(supported);

    if (!supported) return;

    // Set initial permission state
    setNotificationPermission(Notification.permission);

    // Initialize service worker and notifications
    const initNotifications = async () => {
      const swRegistration = await registerServiceWorker();
      if (swRegistration) {
        const subscription = await swRegistration.pushManager.getSubscription();
        setIsSubscribed(!!subscription);
      }
    };

    initNotifications();
  }, []);

  const enableNotifications = async () => {
    if (!notificationSupported) {
      console.error('❌ Notifications not supported on this device')
      alert('Your device does not support notifications');
      return;
    }

    try {
      console.log('📱 Step 1: Checking notification support...')
      if (!('Notification' in window)) {
        console.error('❌ Notification API not available')
        return
      }

      console.log('📱 Step 2: Current permission:', Notification.permission)
      
      // If already granted, no need to request
      if (Notification.permission === 'granted') {
        console.log('✅ Permission already granted')
        return
      }

      // Request permission - this shows the browser prompt
      console.log('📱 Step 3: Requesting permission from browser (this should show a prompt)...')
      const permission = await Notification.requestPermission();
      console.log('📱 Step 4: User responded with:', permission)

      // Update state with new permission
      setNotificationPermission(permission);

      if (permission === 'granted') {
        console.log('✅ Permission granted! Setting up notifications...')
        // Register service worker
        const swRegistration = await registerServiceWorker();
        if (swRegistration) {
          console.log('✅ Service worker registered')
          // Try to subscribe to push notifications (optional, falls back to local)
          const pushSubscription = await subscribeToPushNotifications();
          setIsSubscribed(!!pushSubscription);
          console.log('✅ Notifications enabled! Local notifications will work immediately.');
        }
      } else if (permission === 'default') {
        console.log('ℹ️ User dismissed the prompt (permission: default)')
      } else {
        console.warn('⚠️ User denied notification permission')
        alert('Notifications were blocked.\n\nTo enable them:\n1. Click the lock/info icon in the address bar\n2. Find "Notifications" and change it to "Allow"\n3. Come back and click Enable again');
      }
    } catch (error) {
      console.error('❌ Error enabling notifications:', error);
    }
  };

  return {
    notificationSupported,
    notificationPermission,
    isSubscribed,
    enableNotifications,
  };
}
