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

function makeHandlers({ getToken, deleteToken, send, log = console }) {
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
    onCreated: (ping, id) => (ping && ping.status === 'asking' ? push(ping.to, incomingMessage(ping, id)) : Promise.resolve('ignored')),

    /** Only the moment it is answered: tell the person who asked. Taking the lease, or finishing, is not news. */
    onUpdated: (before, after, id) =>
      before && after && before.status === 'asking' && after.status === 'answered'
        ? push(after.from, answeredMessage(after, id))
        : Promise.resolve('ignored'),
  };
}

module.exports = { makeHandlers, DEAD_TOKEN };
