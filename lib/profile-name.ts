import { getProfileName } from "./social"

/** The label given to an account that has never been named. It is derived from the id, so it is the same on every device. */
export const placeholderName = (uid: string) => `Mate-${uid.slice(-8).toUpperCase()}`

/**
 * The name this account goes by, for a device that may not have it saved locally (a new browser, a cleared one).
 * Order: a name saved on this device, the name already on the account's profile, the name on the signed-in account,
 * and only then the generated placeholder. `publish` is false when the profile could not be read and the name is just
 * the placeholder: announcing it then would overwrite a real name that is merely out of reach right now.
 */
export async function resolveProfileName(
  uid: string,
  local: string,
  authName: string | null | undefined,
  lookup: (uid: string) => Promise<string | null> = getProfileName,
): Promise<{ name: string; publish: boolean }> {
  const placeholder = placeholderName(uid)
  const real = (n: string | null | undefined) => {
    const t = (n ?? "").trim()
    return t && t !== placeholder ? t : ""
  }
  if (real(local)) return { name: real(local), publish: true }
  let cloud: string | null = null
  let readable = true
  try {
    cloud = await lookup(uid)
  } catch {
    readable = false
  }
  const found = real(cloud) || real(authName)
  if (found) return { name: found, publish: true }
  return { name: placeholder, publish: readable && !cloud }
}
