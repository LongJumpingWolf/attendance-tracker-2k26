/** An unguessable invite token: 18 characters from 12 random bytes (unchanged from the original invite code) */
export const randomToken = (): string => {
  const bytes = new Uint8Array(12)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => b.toString(36).padStart(2, "0")).join("").slice(0, 18)
}
