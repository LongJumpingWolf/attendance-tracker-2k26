'use client';

import { useEffect, useRef, useState } from 'react';
import { registerServiceWorker, subscribeToPushNotifications } from '@/lib/notifications';
import { isSubjectSleeping, localDate, toMin } from '@/lib/attendance';
import type { ScheduleOverride, Subject } from '@/lib/types';
import { normalizeScheduleEntry } from '@/lib/reminders';

export function useNotifications(subjects: Subject[] = [], scheduleOverrides: ScheduleOverride[] = []) {
    const subjectsRef = useRef(subjects)
    const overridesRef = useRef(scheduleOverrides)
    subjectsRef.current = subjects
    overridesRef.current = scheduleOverrides

    // --- Custom notification scheduling logic ---
    useEffect(() => {
      // Only run in browser
      if (typeof window === 'undefined') return;

      const FIRED_KEY = 'remindersFired';
      // A reminder still fires if the check runs a few minutes late (a throttled background tab, a phone that
      // just woke up), and never fires twice in one day.
      const GRACE_MIN = 10;

      const inFlight = new Set<string>()
      const firedInMemory = new Set<string>()
      const show = async (title: string, body: string, tag?: string): Promise<boolean> => {
        if (!('Notification' in window) || Notification.permission !== 'granted') return false
        // A tag makes the system replace a repeat (the app open in two tabs or windows) instead of showing it twice
        const options = { body, icon: '/favicon-192.png', badge: '/favicon-192.png', data: { url: `${window.location.origin}/` }, ...(tag ? { tag } : {}) }
        try {
          // Phones only allow notifications made through the service worker.
          const registration = await navigator.serviceWorker?.ready
          if (registration) {
            await registration.showNotification(title, options)
            return true
          }
        } catch {
          // Fall through to the page notification where supported.
        }
        try {
          new Notification(title, options)
          return true
        } catch {
          return false
        }
      }

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

        const readFired = (): { date: string; ids: string[] } => {
          try {
            const saved = JSON.parse(localStorage.getItem(FIRED_KEY) || 'null');
            if (saved && saved.date === today && Array.isArray(saved.ids)) {
              return { date: today, ids: saved.ids.filter((id: unknown): id is string => typeof id === 'string') };
            }
          } catch {
            /* start fresh */
          }
          return { date: today, ids: [] };
        };
        const fired = readFired();
        for (const rawEntry of schedule) {
          // The shared normalizer keeps one malformed reminder from breaking other scheduled alerts.
          const entry = normalizeScheduleEntry(rawEntry);
          if (!entry || entry.day !== nowDay) continue;

          // Legacy reminders may not have an immutable subject ID. Resolve a name only when it is unique;
          // never hide/show a reminder based on an ambiguous same-name subject.
          const currentSubjects = subjectsRef.current;
          const subjectMatches = typeof entry.subjectId === 'string'
            ? currentSubjects.filter((subject) => subject.id === entry.subjectId)
            : currentSubjects.filter((subject) => subject.name === entry.subjectName);
          const linkedSubject = subjectMatches.length === 1 ? subjectMatches[0] : undefined;
          const todayKey = localDate(now);
          if (linkedSubject && isSubjectSleeping(linkedSubject, todayKey)) continue;

          let reminderName = linkedSubject?.name ?? (typeof entry.subjectName === 'string' && entry.subjectName.trim() ? entry.subjectName : 'Class');
          const override = linkedSubject ? overridesRef.current.find((item) => item.date === todayKey && item.originalSubjectId === linkedSubject.id && item.start === entry.startTime) : undefined;
          if (override?.kind === 'cancelled') continue;
          if (override?.kind === 'substitute' && override.substituteSubjectId) {
            const replacement = currentSubjects.find((subject) => subject.id === override.substituteSubjectId);
            if (replacement && !isSubjectSleeping(replacement, todayKey)) reminderName = replacement.name;
          }

          const offset = typeof entry.notifyOffset === 'number' && Number.isFinite(entry.notifyOffset) && entry.notifyOffset >= 0 && entry.notifyOffset <= 240 ? entry.notifyOffset : 10;
          const notifyWhen = entry.notifyWhen === 'after' ? 'after' : 'before';
          const startMin = toMin(entry.startTime), endMin = toMin(entry.endTime);
          const trigger = notifyWhen === 'before' ? startMin - offset : endMin + offset;
          const late = nowMinutes - trigger;
          const firedKey = `${today}:${entry.id}`
          if (late < 0 || late > GRACE_MIN || fired.ids.includes(entry.id) || firedInMemory.has(firedKey) || inFlight.has(firedKey)) continue

          const timeStr = `${formatTime(entry.startTime)} - ${formatTime(entry.endTime)}`
          inFlight.add(firedKey)
          void show('Class Reminder', `${reminderName}\n${timeStr}\nTap to open the app.`, `reminder-${firedKey}`)
            .then((shown) => {
              if (!shown) return
              // Persist only after the browser accepted the notification request. Failed attempts may retry in the grace window.
              firedInMemory.add(firedKey)
              try {
                const latest = readFired()
                if (!latest.ids.includes(entry.id)) latest.ids.push(entry.id)
                localStorage.setItem(FIRED_KEY, JSON.stringify(latest))
              } catch {
                // In-memory dedupe still prevents a duplicate during this page session.
              }
            })
            .finally(() => inFlight.delete(firedKey))
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
      try {
        const swRegistration = await registerServiceWorker();
        if (swRegistration) {
          const subscription = await swRegistration.pushManager.getSubscription();
          setIsSubscribed(!!subscription);
        } else {
          setIsSubscribed(false);
        }
      } catch (error) {
        // Browser push APIs can reject in private browsing or unsupported contexts; don't leave an unhandled promise.
        console.warn('Notification initialization is unavailable in this browser context.', error);
        setIsSubscribed(false);
      }
    };

    void initNotifications();
  }, []);

  const enableNotifications = async () => {
    if (!notificationSupported) {
      alert('Your device does not support notifications')
      return
    }

    try {
      if (!('Notification' in window)) {
        alert('This browser does not support notifications.')
        return
      }

      // Permission may have been granted on a previous visit before setup completed. In that case
      // we must still register the worker and try FCM token setup rather than returning early.
      const permission = Notification.permission === 'granted'
        ? 'granted'
        : await Notification.requestPermission()
      setNotificationPermission(permission)
      if (permission !== 'granted') {
        setIsSubscribed(false)
        alert(permission === 'denied'
          ? 'Notifications are blocked. Allow them in this site’s browser settings, then try again.'
          : 'Notification permission was not granted. You can enable it later in browser settings.')
        return
      }

      const registration = await registerServiceWorker()
      if (!registration) {
        setIsSubscribed(false)
        alert('Permission is enabled, but the service worker could not be registered. Local reminders may only work while this page is open.')
        return
      }

      const token = await subscribeToPushNotifications()
      setIsSubscribed(!!token)
      alert(token
        ? 'Browser notifications are enabled and an FCM token is available. This does not guarantee background delivery; a configured Firebase sender and device testing are still required.'
        : 'Browser notifications are enabled. No FCM token was obtained, so remote push delivery is not confirmed.')
    } catch (error) {
      console.error('Error enabling notifications:', error)
      alert('Could not finish notification setup. Check this site’s notification permission and try again.')
    }
  };

  return {
    notificationSupported,
    notificationPermission,
    isSubscribed,
    enableNotifications,
  };
}
