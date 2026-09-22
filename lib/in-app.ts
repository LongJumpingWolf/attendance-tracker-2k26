/**
 * Apps that scan QR codes often open the link in their own built-in browser. Those keep no data between visits, so
 * every scan looks like a brand-new session with none of your data (Android's, unlike iOS's, sometimes does keep
 * data, but there's no reliable way to tell which do, so all of them are treated as unsafe).
 *
 * Detection is user-agent sniffing, so it is a best guess, not a guarantee, and apps change their strings over time.
 *
 *  - iOS: real Safari, and Chrome/Firefox on iPhone, all include the "Safari/xx.x" token. Most third-party in-app
 *    browsers (built on WKWebView) drop it. Apple's own in-app browser component (SFSafariViewController, used by
 *    some apps for an "in-app Safari") keeps the token, so it looks identical to real Safari and can't be told
 *    apart; those already have their own "Open in Safari" button, so it is not a problem in practice.
 *  - Android: the underlying WebView component stamps a "wv" token on itself, and the big single-purpose apps also
 *    add their own token on top (Instagram, Facebook's FBAN/FBAV, Twitter, LINE, Snapchat, ...). Either is enough.
 */
const IOS = /iPhone|iPad|iPod/
const ANDROID = /Android/
const ANDROID_IN_APP = /; ?wv\)|Instagram|FBAN|FBAV|Twitter|Line\/|Snapchat|MicroMessenger|WeChat/i

export const isIosInApp = (ua: string) => IOS.test(ua) && !/Safari\//.test(ua)
export const isAndroidInApp = (ua: string) => ANDROID.test(ua) && ANDROID_IN_APP.test(ua)
export const isInAppBrowser = (ua: string) => isIosInApp(ua) || isAndroidInApp(ua)

/**
 * Apple's private scheme that asks the system to open a link in Safari. Some in-app browsers pass it along, which
 * takes the person out of the temporary browser without them touching a menu. Others ignore it, so it is only ever
 * a best effort with a button next to it.
 */
export const safariUrl = (url: string) => url.replace(/^(https?):\/\//, "x-safari-$1://")

/**
 * Android's intent scheme, asking specifically for Chrome. Android in-app browsers honour this far more often than
 * iOS in-app browsers honour the Safari hand-off above, so on Android this is closer to reliable than best-effort.
 * `S.browser_fallback_url` is what a browser that doesn't understand `intent:` falls back to.
 */
export const chromeIntentUrl = (url: string) => {
  const bare = url.replace(/^https?:\/\//, "")
  const scheme = url.startsWith("https") ? "https" : "http"
  return `intent://${bare}#Intent;scheme=${scheme};package=com.android.chrome;S.browser_fallback_url=${encodeURIComponent(url)};end`
}
