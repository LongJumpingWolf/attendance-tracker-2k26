/**
 * The push messages for Pings on the Supabase side, as plain data. A line-for-line port of functions/ping-messages.js (which stays the
 * Firebase source of truth; tests/phase10-push-dispatch.test.ts checks the two produce identical output).
 *
 * They carry no class names, subjects or dates: a notification can show on a locked screen. The Ping in the database is the record;
 * the message only says who, and where to go (`/?ping=<id>`). Data-only: the app's service worker builds the notification.
 */
export interface PushMessage {
  data: Record<string, string>
  webpush: { headers: { Urgency: string; TTL: string } }
}

interface MessagePing {
  fromName?: string | null
  toName?: string | null
  items?: unknown
}

const clean = (name: unknown): string => String(name || "").trim().slice(0, 40) || "A mate"

const HEADERS = { Urgency: "high", TTL: "259200" } // high urgency so it reaches a sleeping phone; a Ping stops being useful after ~3 days

/** "Rahul is asking about your attendance" -> the person who was asked */
export function incomingMessage(ping: MessagePing, id: string): PushMessage {
  return {
    data: {
      type: "ping",
      event: "incoming",
      pingId: id,
      tag: `ping-${id}`,
      title: "Ping",
      body: `${clean(ping.fromName)} is asking about your attendance`,
      url: `/?ping=${encodeURIComponent(id)}`,
    },
    webpush: { headers: { ...HEADERS } },
  }
}

/** "Rahul marked you present" -> the person who asked */
export function answeredMessage(ping: MessagePing, id: string): PushMessage {
  const items = Array.isArray(ping.items) ? (ping.items as { answer?: unknown }[]) : []
  const yes = items.filter((i) => i && i.answer === "yes").length
  const name = clean(ping.toName)
  const body = items.length > 0 && yes === items.length ? `${name} marked you present` : `${name} replied to your Ping`
  return {
    data: { type: "ping", event: "result", pingId: id, tag: `ping-${id}`, title: "Ping answered", body, url: `/?ping=${encodeURIComponent(id)}` },
    webpush: { headers: { ...HEADERS } },
  }
}
