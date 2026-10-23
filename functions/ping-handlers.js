/**
 * What the Cloud Functions do when a Ping is created or answered, with everything outside the logic passed in (the
 * token store and the messaging service), so it can be tested without Firebase.
 *
 * The push is a nudge, never the record: it carries the Ping's id and a line of safe text, and the app reads the real
 * Ping from Firestore when it opens. A message that is late, missing or delivered twice changes nothing that matters:
 * a repeat for the same Ping has the same tag, so the phone shows it once.
 */
const { incomingMessage, answeredMessage } = require('./ping-messages');

const DEAD_TOKEN = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token'];

/** Pushes one person may send another in a window: more than this is nudging, and only the notification is held back */
const PUSH_LIMIT = 5;
const PUSH_WINDOW_MS = 10 * 60 * 1000;

/**
 * `allowPush(from, to)` answers whether this sender may notify this person now (see pushAllowance). Left out, nothing is
 * limited. The Ping itself is always kept: a held-back notification only means the person sees it when they open the app.
 */
function makeHandlers({ getToken, deleteToken, send, allowPush, log = console }) {
  async function push(uid, message) {
    if (!uid) return 'no-recipient';
    const token = await getToken(uid);
    if (!token) return 'no-token'; // this person never turned alerts on: they will see the Ping when they open the app
    try {
      await send({ token, ...message });
      return 'sent';
    } catch (e) {
      // A token that is no longer valid is dropped so we stop trying it
      if (DEAD_TOKEN.includes(e && e.code)) {
        await deleteToken(uid);
        return 'token-removed';
      }
      log.error(`Ping push to ${uid} failed`, e);
      return 'failed';
    }
  }

  return {
    /** A new request: tell the person who was asked */
    onCreated: async (ping, id) => {
      if (!ping || ping.status !== 'asking') return 'ignored';
      if (allowPush) {
        let allowed = true;
        try {
          allowed = await allowPush(ping.from, ping.to);
        } catch (e) {
          log.error('Ping push limit check failed; sending anyway', e); // a broken counter must not silence real Pings
        }
        if (!allowed) return 'throttled';
      }
      return push(ping.to, incomingMessage(ping, id));
    },

    /** Only the moment it is answered: tell the person who asked. Taking the lease, or finishing, is not news. */
    onUpdated: (before, after, id) =>
      before && after && before.status === 'asking' && after.status === 'answered'
        ? push(after.from, answeredMessage(after, id))
        : Promise.resolve('ignored'),
  };
}

/**
 * The counting rule behind allowPush, separate from where the counts are kept: given what is stored for a sender and
 * recipient (or nothing) and the time, whether this push is allowed and what to store next.
 */
function pushAllowance(stored, now) {
  const fresh = !stored || typeof stored.start !== 'number' || now - stored.start >= PUSH_WINDOW_MS;
  const start = fresh ? now : stored.start;
  const count = fresh ? 0 : Number(stored.count) || 0;
  if (count >= PUSH_LIMIT) return { allowed: false, next: { start, count } };
  return { allowed: true, next: { start, count: count + 1 } };
}

module.exports = { makeHandlers, pushAllowance, DEAD_TOKEN, PUSH_LIMIT, PUSH_WINDOW_MS };
