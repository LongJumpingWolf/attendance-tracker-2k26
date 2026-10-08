/**
 * The one feature flag of the Firebase -> Supabase auth bridge (Phase 6A). OFF unless the build says exactly "true".
 *
 *   NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE   unset, empty, "false" or anything else -> OFF (the production default)
 *                                      "true" (any case, spaces ignored)       -> the bridge MAY be used by future Supabase work
 *
 * OFF means the application behaves exactly as it did before: no Firebase token is requested for Supabase, nothing is
 * sent to Supabase, nothing is cached. There is no user-visible setting and no runtime switch. Anything that is not an
 * explicit "true" is treated as off, so a typo can never switch the bridge on.
 */
export function parseAuthBridgeFlag(raw: string | undefined): boolean {
  return raw?.trim().toLowerCase() === "true"
}

/** The static reference lets Next.js inline the build-time value */
export const authBridgeEnabled = (): boolean => parseAuthBridgeFlag(process.env.NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE)

/**
 * Phase 6B shadow-write flags. Every one is OFF unless the build says exactly "true" (same rule as above). A shadow write
 * is only ever attempted when its domain flag AND NEXT_PUBLIC_SUPABASE_AUTH_BRIDGE are on AND the Supabase configuration
 * exists AND Firebase is the selected backend. Firebase stays authoritative in every combination.
 *
 *   NEXT_PUBLIC_SUPABASE_SHADOW_SYNC     mirror each confirmed sync write (opaque blob + rev)
 *   NEXT_PUBLIC_SUPABASE_SHADOW_SOCIAL   mirror profile names and invites
 *   NEXT_PUBLIC_SUPABASE_SHADOW_PUSH     mirror the push token
 *
 * Connections and Pings have no flag because they are deliberately not mirrored yet (see PHASE6B_SHADOW_DUAL_WRITE.md).
 */
export interface ShadowFlags {
  sync: boolean
  social: boolean
  push: boolean
}

export const parseShadowFlags = (raw: { sync?: string; social?: string; push?: string }): ShadowFlags => ({
  sync: parseAuthBridgeFlag(raw.sync),
  social: parseAuthBridgeFlag(raw.social),
  push: parseAuthBridgeFlag(raw.push),
})

/** The static references let Next.js inline the build-time values */
export const shadowFlags = (): ShadowFlags =>
  parseShadowFlags({
    sync: process.env.NEXT_PUBLIC_SUPABASE_SHADOW_SYNC,
    social: process.env.NEXT_PUBLIC_SUPABASE_SHADOW_SOCIAL,
    push: process.env.NEXT_PUBLIC_SUPABASE_SHADOW_PUSH,
  })

export const anyShadowFlag = (f: ShadowFlags): boolean => f.sync || f.social || f.push
