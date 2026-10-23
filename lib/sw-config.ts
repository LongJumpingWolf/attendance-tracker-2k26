/**
 * The one address the service worker is registered under, and the name of the cache it keeps the app in.
 * Registering the same worker under different addresses (or options) makes the browser treat each as a new worker
 * and reinstall it on every launch, so everything that registers it uses these. The cache name is also written in
 * public/sw.js, which cannot import this file: tests/sw-config.test.ts keeps the two equal.
 */
export const SW_URL = "/sw.js?v=8"
export const SW_OPTIONS = { scope: "/", updateViaCache: "none" } as const
export const SHELL_CACHE = "shell-v6"
