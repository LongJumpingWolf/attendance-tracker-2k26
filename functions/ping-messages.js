/**
 * The push messages for Pings, as plain data (no Firebase here, so they can be tested).
 *
 * They carry no class names, subjects or dates: a notification can show on a locked screen. Everything the person
 * needs is on the Ping itself, which the app reads from Firestore when it opens. The message only says who, and where
 * to go (`/?ping=<id>`). The Ping in Firestore is the source of truth; a missed or late message loses nothing.
 *
 * They are data-only messages: the app's own service worker (public/sw.js) builds the notification from `data`, so
 * it doesn't depend on any Firebase code running inside the worker.
 */

const clean = (name) => String(name || '').trim().slice(0, 40) || 'A mate';

/** "Rahul is asking about your attendance" -> the person who was asked */
function incomingMessage(ping, id) {
  return {
    data: {
      type: 'ping',
      event: 'incoming',
      pingId: id,
      tag: `ping-${id}`,
      title: 'Ping',
      body: `${clean(ping.fromName)} is asking about your attendance`,
      url: `/?ping=${encodeURIComponent(id)}`,
    },
    // High urgency so it reaches a sleeping phone; a Ping stops being useful after about three days
    webpush: { headers: { Urgency: 'high', TTL: '259200' } },
  };
}

/** "Rahul marked you present" -> the person who asked */
function answeredMessage(ping, id) {
  const items = Array.isArray(ping.items) ? ping.items : [];
  const yes = items.filter((i) => i && i.answer === 'yes').length;
  const name = clean(ping.toName);
  const body = items.length > 0 && yes === items.length ? `${name} marked you present` : `${name} replied to your Ping`;
  return {
    data: {
      type: 'ping',
      event: 'result',
      pingId: id,
      tag: `ping-${id}`,
      title: 'Ping answered',
      body,
      url: `/?ping=${encodeURIComponent(id)}`,
    },
    webpush: { headers: { Urgency: 'high', TTL: '259200' } },
  };
}

module.exports = { incomingMessage, answeredMessage };
