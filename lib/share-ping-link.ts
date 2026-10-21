/** Share URLs must be reachable by the recipient, not resolve to the sender's own device. */
export function shareablePingOrigin(origin: string): { ok: true; origin: string } | { ok: false; message: string } {
  let url: URL
  try { url = new URL(origin) } catch {
    return { ok: false, message: "The website address is invalid. Open Attendance Tracker from its normal web address and try again." }
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)?.slice(1).map(Number)
  const privateIp = !!ipv4 && (
    ipv4[0] === 10 || ipv4[0] === 127 || ipv4[0] === 0 ||
    (ipv4[0] === 192 && ipv4[1] === 168) ||
    (ipv4[0] === 172 && ipv4[1] >= 16 && ipv4[1] <= 31) ||
    (ipv4[0] === 169 && ipv4[1] === 254)
  )
  const ipv6Loopback = host === "::1"
  const ipv6Unspecified = host === "::"
  const ipv6Private = host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host)
  const local = host === "localhost" || host.endsWith(".localhost") || ipv6Loopback || ipv6Unspecified || ipv6Private || host === "0.0.0.0" || privateIp || host.endsWith(".local")
  if (local) return {
    ok: false,
    message: "This copy is running on localhost or a private network. To create a working link from localhost, set NEXT_PUBLIC_APP_URL to your deployed HTTPS app URL (running this same Firebase project) in .env.local, then restart the dev server. Without it, localhost links cannot be opened by the recipient.",
  }
  if (url.protocol !== "https:") return {
    ok: false,
    message: "Interactive Ping links require your public HTTPS website. This address is not HTTPS, so no unusable link was created.",
  }
  return { ok: true, origin: url.origin }
}


/**
 * Resolve the recipient-facing site URL. On a local dev server this may be configured to a deployed HTTPS preview,
 * but that preview must run the same Firebase project as this build for its links to resolve. Never generate links to
 * localhost or a private network address.
 */
export function shareableAppOrigin(currentOrigin: string, configuredOrigin?: string): { ok: true; origin: string } | { ok: false; message: string } {
  return shareablePingOrigin(configuredOrigin?.trim() || currentOrigin)
}
