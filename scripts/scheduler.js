/**
 * Simple scheduler script.
 * Run with: `node scripts/scheduler.js` (ensure env VAPID keys set).
 * This script checks `data/schedules.json` and `data/subscriptions.json` and sends
 * notifications for:
 * - type === 'backup' : last day of month at 21:00 local time
 * - type === 'subject': one-off when `notifyAt` <= now (marks sent after delivery)
 */

const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

const SUBS_PATH = path.join(process.cwd(), 'data', 'subscriptions.json');
const SCHEDULES_PATH = path.join(process.cwd(), 'data', 'schedules.json');

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
} else {
  console.warn('VAPID keys not set; scheduler will not be able to send pushes until keys are configured.');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) || [];
  } catch (e) {
    return [];
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function isLastDayOfMonth(date) {
  const test = new Date(date.getTime());
  const next = new Date(test.getFullYear(), test.getMonth() + 1, 1);
  next.setDate(next.getDate() - 1);
  return test.getDate() === next.getDate();
}

async function sendNotification(subscription, payload) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    console.log('Sent to', subscription.endpoint);
    return true;
  } catch (err) {
    console.error('Failed to send', err && err.statusCode, err && err.body);
    // If subscription gone, remove it
    if (err && (err.statusCode === 410 || err.statusCode === 404)) {
      let subs = readJson(SUBS_PATH);
      subs = subs.filter(s => s.endpoint !== subscription.endpoint);
      writeJson(SUBS_PATH, subs);
      console.log('Removed expired subscription', subscription.endpoint);
    }
    return false;
  }
}

async function checkAndSend() {
  const schedules = readJson(SCHEDULES_PATH);
  const subs = readJson(SUBS_PATH);
  const now = new Date();
  const hour = now.getHours();
  const minute = now.getMinutes();

  // Backup: last day of month at 21:00
  if (isLastDayOfMonth(now) && hour === 21 && minute === 0) {
    const backupSchedules = schedules.filter(s => s.type === 'backup');
    for (const s of backupSchedules) {
      const subscription = subs.find(x => x.endpoint === s.subscriptionEndpoint);
      if (!subscription) continue;
      const payload = {
        title: s.payload.title || 'Backup Reminder',
        body: s.payload.body || 'Please backup/export your data for the month',
        tag: 'backup',
        data: s.payload.data || {},
      };
      // eslint-disable-next-line no-await-in-loop
      await sendNotification(subscription, payload);
    }
  }

  // Subject: one-off notifyAt entries
  // Subject: support both one-off entries (notifyAt) and recurring weekly entries
  // Recurring entries should include `day` (0-6), `startTime` (HH:MM), `notifyOffset` and `notifyWhen`.
  const subjectSchedules = schedules.filter(s => s.type === 'subject');
  for (const s of subjectSchedules) {
    try {
      // One-off notifyAt
      if (s.notifyAt && !s.sent) {
        const notifyAt = new Date(s.notifyAt);
        if (now >= notifyAt) {
          const subscription = subs.find(x => x.endpoint === s.subscriptionEndpoint);
          if (!subscription) {
            s.sent = true; // mark sent to avoid retries
            continue;
          }
          const payload = {
            title: s.payload.title || 'Class Reminder',
            body: s.payload.body || `Your ${s.payload.subject || 'class'} is coming up`,
            tag: s.payload.tag || 'subject',
            data: s.payload.data || { subject: s.payload.subject, tag: s.payload.tag },
          };
          // eslint-disable-next-line no-await-in-loop
          const ok = await sendNotification(subscription, payload);
          if (ok) s.sent = true;
        }
        continue;
      }

      // Recurring weekly entry
      if (typeof s.day === 'number' && s.startTime && typeof s.notifyOffset === 'number' && s.notifyWhen) {
        // check if today is the configured day
        if (now.getDay() !== s.day) continue;

        // compute trigger minute for today
        const [hStr, mStr] = s.startTime.split(':');
        const startH = Number(hStr);
        const startM = Number(mStr);
        let trigger = new Date(now.getFullYear(), now.getMonth(), now.getDate(), startH, startM, 0, 0);
        if (s.notifyWhen === 'before') {
          trigger = new Date(trigger.getTime() - (s.notifyOffset * 60 * 1000));
        } else {
          // after: use endTime if present else use start + notifyOffset
          if (s.endTime) {
            const [eh, em] = s.endTime.split(':').map(Number);
            trigger = new Date(now.getFullYear(), now.getMonth(), now.getDate(), eh, em, 0, 0);
            trigger = new Date(trigger.getTime() + (s.notifyOffset * 60 * 1000));
          } else {
            trigger = new Date(trigger.getTime() + (s.notifyOffset * 60 * 1000));
          }
        }

        // compare current time to trigger within same minute
        const diff = Math.abs(now.getTime() - trigger.getTime());
        if (diff <= 60 * 1000) {
          const subscription = subs.find(x => x.endpoint === s.subscriptionEndpoint);
          if (!subscription) continue;
          const payload = {
            title: s.payload.title || `Class Reminder: ${s.payload.subject || ''}`,
            body: s.payload.body || `${s.payload.subject || 'Your class'} is scheduled now`,
            tag: s.payload.tag || 'subject',
            data: s.payload.data || { subject: s.payload.subject, tag: s.payload.tag },
          };
          // eslint-disable-next-line no-await-in-loop
          await sendNotification(subscription, payload);
        }
      }
    } catch (err) {
      console.error('Error processing subject schedule', err, s);
    }
  }

  // Persist any sent flags changes
  writeJson(SCHEDULES_PATH, schedules);
}

async function loop() {
  console.log('Scheduler started - checks every minute');
  await checkAndSend();
  setInterval(checkAndSend, 60 * 1000);
}

loop().catch(err => {
  console.error('Scheduler crashed', err);
  process.exit(1);
});
