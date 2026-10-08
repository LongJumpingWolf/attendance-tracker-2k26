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
