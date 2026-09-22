import { NextRequest, NextResponse } from 'next/server';
import { addSchedule, upsertSchedule, removeScheduleByClientId } from '@/lib/subscriptions';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();

    if (!body || !body.subscriptionEndpoint || !body.type) {
      return NextResponse.json({ error: 'subscriptionEndpoint and type required' }, { status: 400 });
    }

    // A recurring class reminder keeps its day, times and offset, and is keyed by the app's own id
    // so that editing it updates one entry instead of piling up copies.
    if (body.clientId && typeof body.day === 'number') {
      const entry = await upsertSchedule({
        subscriptionEndpoint: body.subscriptionEndpoint,
        type: body.type,
        payload: body.payload || {},
        clientId: String(body.clientId),
        day: body.day,
        startTime: body.startTime,
        endTime: body.endTime,
        notifyOffset: body.notifyOffset,
        notifyWhen: body.notifyWhen,
      });
      return NextResponse.json({ success: true, entry });
    }

    // One-off or backup reminder
    const entry = await addSchedule({
      subscriptionEndpoint: body.subscriptionEndpoint,
      type: body.type,
      payload: body.payload || {},
      notifyAt: body.notifyAt,
    });

    return NextResponse.json({ success: true, entry });
  } catch (err) {
    console.error('schedule route error', err);
    return NextResponse.json({ error: 'Failed to save schedule' }, { status: 500 });
  }
}

/** Removes a reminder the app deleted. Body: { subscriptionEndpoint, clientId } */
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    if (!body?.subscriptionEndpoint || !body?.clientId) {
      return NextResponse.json({ error: 'subscriptionEndpoint and clientId required' }, { status: 400 });
    }
    const removed = await removeScheduleByClientId(body.subscriptionEndpoint, String(body.clientId));
    return NextResponse.json({ success: true, removed });
  } catch (err) {
    console.error('schedule delete error', err);
    return NextResponse.json({ error: 'Failed to remove schedule' }, { status: 500 });
  }
}
