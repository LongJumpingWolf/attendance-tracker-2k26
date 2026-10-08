/**
 * The shadow-write interface (Phase 6A): INTERFACE AND A NO-OP ONLY.
 *
 * During shadow operation Firebase stays the only authority. A shadow writer receives what the application has ALREADY
 * done against Firebase (after Firebase confirmed it) and mirrors it to Supabase for comparison. It never decides
 * anything, never answers the application, and its failures must never reach the application.
 *
 * Phase 6A connects nothing: no application file imports this module, `getShadowWriter()` always returns the no-op, and
 * the production application emits no shadow write. A real writer is the next phase, after the auth bridge is finalized.
 *
 * Rules every implementation must keep:
 *  - the sync blob is OPAQUE. It is the packed text exactly as stored in Firebase; it is never parsed, normalized,
 *    decompressed or turned into relational rows;
 *  - Supabase gets no authority over Ping or connection state: these calls only mirror a transition Firebase already made,
 *    and a Ping is never processed twice because of them;
 *  - the methods never reject and never throw (see `isolateShadowFailures`);
 *  - nothing here reads from Supabase to change Firebase. Comparison is read-only (lib/backend/reconcile.ts).
 */
import type { PingItem } from "../types"

export interface ShadowSyncBlob {
  /** The owner's Firebase uid (the Google account's sync document) */
  owner: string
  /** The packed text, exactly as written to Firebase. Opaque. */
  data: string
  /** The revision Firebase confirmed for this write */
  rev: number
  /** Firebase's last-write time in ms, when known */
  updatedAt: number | null
}

export interface ShadowProfile {
  uid: string
  name: string
}

export type ShadowConnection =
  | { op: "send"; id: string; from: { uid: string; name: string }; to: { uid: string; name: string } }
  | { op: "respond"; id: string; status: "accepted" | "declined" }
  | { op: "remove"; id: string }

export type ShadowPing =
  | { op: "create"; id: string; from: { uid: string; name: string }; to: { uid: string; name: string }; requestId: string; date: string; items: PingItem[] }
  | { op: "answer"; id: string; items: PingItem[] }
  | { op: "lease"; id: string; deviceId: string }
  | { op: "finalize"; id: string }
  | { op: "remove"; id: string }

export type ShadowPushToken = { op: "save"; uid: string; token: string } | { op: "remove"; uid: string }

export type ShadowInvite = { op: "create"; uid: string; token: string; name: string; minutes: number } | { op: "remove"; token: string }

export interface ShadowWriter {
  /** False for the no-op. Callers may skip building payloads when this is false. */
  readonly active: boolean
  syncBlob(w: ShadowSyncBlob): Promise<void>
  profile(w: ShadowProfile): Promise<void>
  connection(w: ShadowConnection): Promise<void>
  ping(w: ShadowPing): Promise<void>
  pushToken(w: ShadowPushToken): Promise<void>
  invite(w: ShadowInvite): Promise<void>
}

/** Does nothing, to nothing. The only writer that exists in Phase 6A. */
export const noopShadowWriter: ShadowWriter = {
  active: false,
  syncBlob: async () => {},
  profile: async () => {},
  connection: async () => {},
  ping: async () => {},
  pushToken: async () => {},
  invite: async () => {},
}

/**
 * Wraps a writer so that nothing it does can reach the caller: a thrown error or a rejected promise is swallowed (and
 * reported to `onError` if given). Firebase flows must behave identically whether or not the shadow works.
 */
export function isolateShadowFailures(writer: ShadowWriter, onError?: (op: string, error: unknown) => void): ShadowWriter {
  const guard =
    <T>(op: string, fn: (x: T) => Promise<void>) =>
    async (x: T): Promise<void> => {
      try {
        await fn(x)
      } catch (e) {
        try {
          onError?.(op, e)
        } catch {
          /* a failing reporter must not matter either */
        }
      }
    }
  return {
    active: writer.active,
    syncBlob: guard("syncBlob", (x: ShadowSyncBlob) => writer.syncBlob(x)),
    profile: guard("profile", (x: ShadowProfile) => writer.profile(x)),
    connection: guard("connection", (x: ShadowConnection) => writer.connection(x)),
    ping: guard("ping", (x: ShadowPing) => writer.ping(x)),
    pushToken: guard("pushToken", (x: ShadowPushToken) => writer.pushToken(x)),
    invite: guard("invite", (x: ShadowInvite) => writer.invite(x)),
  }
}

/** Always the no-op. The real writer (Phase 6B, lib/backend/shadow-supabase.ts) is built only by lib/backend/index.ts, behind its flags. */
export function getShadowWriter(): ShadowWriter {
  return noopShadowWriter
}
