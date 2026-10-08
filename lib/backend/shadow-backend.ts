/**
 * Wraps the Firebase backend so that confirmed writes are also offered to a shadow writer (Phase 6B).
 *
 * The contract with the application does not change in any way:
 *  - the wrapped method runs FIRST, exactly as before, and its result (or its error) is returned untouched;
 *  - only after it has succeeded is the shadow write started, and it is NOT awaited: the application never waits for it;
 *  - nothing the shadow does (a throw, a rejection, a slow answer) can reach the caller;
 *  - reads and subscriptions are passed through as they are; Supabase is never read here;
 *  - with no flag on, `withShadow` returns the SAME backend object it was given, so the default build is unchanged.
 *
 * What it forwards: sync writes (opaque blob and the revision Firebase confirmed), profile names, invites, the push token.
 * Connections and Pings are not wrapped (see shadow-supabase.ts).
 */
import type { Backend } from "./contracts"
import { anyShadowFlag, type ShadowFlags } from "./flags"
import type { ShadowWriter } from "./shadow"

/** Starts `job` without waiting for it and without letting anything it does escape */
function fire(job: () => Promise<void> | void): void {
  try {
    void Promise.resolve()
      .then(job)
      .catch(() => {})
  } catch {
    /* never reaches the caller */
  }
}

export function withShadow(base: Backend, writer: ShadowWriter, flags: ShadowFlags): Backend {
  if (!anyShadowFlag(flags)) return base

  const sync = flags.sync
    ? {
        ...base.sync,
        async put(owner: string, data: string, expectedRev: number | null) {
          const result = await base.sync.put(owner, data, expectedRev) // Firebase decides; errors pass through unchanged
          if (result.ok) {
            const rev = result.rev
            // the same string reference: the blob is never copied, parsed or changed
            fire(() => writer.syncBlob({ owner, data, rev, updatedAt: Date.now() }))
          }
          return result
        },
      }
    : base.sync

  const profiles = flags.social
    ? {
        ...base.profiles,
        async save(uid: string, name: string) {
          await base.profiles.save(uid, name)
          fire(() => writer.profile({ uid, name }))
        },
      }
    : base.profiles

  const invites = flags.social
    ? {
        ...base.invites,
        async create(uid: string, name: string, minutes: number) {
          const made = await base.invites.create(uid, name, minutes)
          fire(() => writer.invite({ op: "create", uid, token: made.token, name, minutes })) // the SAME token Firebase issued
          return made
        },
        async remove(token: string) {
          await base.invites.remove(token)
          fire(() => writer.invite({ op: "remove", token }))
        },
      }
    : base.invites

  const pushTokens = flags.push
    ? {
        ...base.pushTokens,
        async save(uid: string, token: string) {
          await base.pushTokens.save(uid, token)
          fire(() => writer.pushToken({ op: "save", uid, token }))
        },
        async remove(uid: string) {
          await base.pushTokens.remove(uid)
          fire(() => writer.pushToken({ op: "remove", uid }))
        },
      }
    : base.pushTokens

  return { ...base, sync, profiles, invites, pushTokens }
}
