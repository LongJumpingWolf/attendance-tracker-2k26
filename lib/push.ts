import webpush from 'web-push';
import { getAllSubscriptions, removeSubscriptionByEndpoint } from './subscriptions';

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY || process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.com';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC, VAPID_PRIVATE);
  } catch (err) {
    // ignore; will fail at send time
    console.error('Failed to set VAPID details:', err);
  }
} else {
  console.warn('VAPID keys not set. Set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in env.');
}

export async function sendToSubscription(subscription: any, payload: any) {
  try {
    await webpush.sendNotification(subscription, JSON.stringify(payload));
    return { success: true };
  } catch (err: any) {
    // If subscription no longer valid, remove it
    const status = err && err.statusCode;
    if (status === 410 || status === 404) {
      try {
        await removeSubscriptionByEndpoint(subscription.endpoint);
      } catch {}
    }
    console.error('Error sending push:', err?.message || err);
    return { success: false, error: err };
  }
}

export async function sendToAll(payload: any) {
  const subs = await getAllSubscriptions();
  const results = [] as any[];
  for (const sub of subs) {
    const r = await sendToSubscription(sub, payload);
    results.push({ endpoint: sub.endpoint, ...r });
  }
  return results;
}

const push = { sendToSubscription, sendToAll };
export default push;
