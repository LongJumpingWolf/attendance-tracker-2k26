// Example API endpoint for sending push notifications
// Place this in: app/api/notifications/send/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { sendToAll, sendToSubscription } from '@/lib/push';
import { getAllSubscriptions } from '@/lib/subscriptions';

/**
 * Sending is for you (or your own scripts), not for the public: in production the request must carry the
 * PUSH_ADMIN_KEY value in an "x-admin-key" header. Without that key set, production refuses every send.
 * In development it stays open so you can try it.
 */
function allowed(request: NextRequest) {
  if (process.env.NODE_ENV !== 'production') return true;
  const key = process.env.PUSH_ADMIN_KEY;
  return Boolean(key) && request.headers.get('x-admin-key') === key;
}

export async function POST(request: NextRequest) {
  if (!allowed(request)) return NextResponse.json({ error: 'Not allowed' }, { status: 401 });
  try {
    const body = await request.json();

    // Simple validation
    if (!body || !body.title || !body.body) {
      return NextResponse.json({ error: 'title and body required' }, { status: 400 });
    }

    const payload = {
      title: body.title,
      body: body.body,
      tag: body.tag || 'default',
      requireInteraction: !!body.requireInteraction,
      data: body.data || {},
    };

    // If a `subscriptionEndpoint` is provided, send only to that subscription
    if (body.subscriptionEndpoint) {
      const subs = await getAllSubscriptions();
      const target = subs.find(s => s.endpoint === body.subscriptionEndpoint);
      if (!target) return NextResponse.json({ error: 'subscription not found' }, { status: 404 });
      const res = await sendToSubscription(target, payload);
      return NextResponse.json({ success: true, results: res });
    }

    // Otherwise broadcast to all subscriptions
    const results = await sendToAll(payload);
    return NextResponse.json({ success: true, results });
  } catch (err) {
    console.error('send route error', err);
    return NextResponse.json({ error: 'Failed to send notification' }, { status: 500 });
  }
}
