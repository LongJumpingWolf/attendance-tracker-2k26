// Example API endpoint for storing subscription info
// Place this in: app/api/notifications/subscribe/route.ts

import { NextRequest, NextResponse } from 'next/server';
import { addSubscription } from '@/lib/subscriptions';

export async function POST(request: NextRequest) {
  try {
    const subscription = await request.json();

    if (!subscription || !subscription.endpoint) {
      return NextResponse.json({ error: 'Invalid subscription' }, { status: 400 });
    }

    await addSubscription(subscription);

    return NextResponse.json({ success: true, message: 'Subscription stored' });
  } catch (err) {
    console.error('subscribe error', err);
    return NextResponse.json({ error: 'Failed to store subscription' }, { status: 500 });
  }
}
