/** In-app Pings are intentionally limited to Google-linked users with an accepted Mate connection. */
export interface InAppPingAccess {
  configured: boolean
  ready: boolean
  anonymous: boolean
  connected: boolean
}

export function canUseInAppPing(account: Omit<InAppPingAccess, "connected">): boolean {
  return account.configured && account.ready && !account.anonymous
}

export function canSendInAppPing(access: InAppPingAccess): boolean {
  return canUseInAppPing(access) && access.connected
}
