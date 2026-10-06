"use client"

import { useEffect } from "react"

/**
 * Registers the service worker on every launch (it used to start only when notifications were switched on) and saves the
 * page and the built files it is already using, so the very next launch can open with no internet at all.
 * Production only: a worker caching a dev server causes more confusion than it saves.
 */
export default function OfflineShell() {
  useEffect(() => {
    if (process.env.NODE_ENV !== "production" || !("serviceWorker" in navigator)) return
    let cancelled = false
    ;(async () => {
      try {
        await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
        await navigator.serviceWorker.ready
        if (cancelled || !("caches" in window)) return
        // The first page load happened before the worker was in charge, so it never saw those requests. Save them now.
        const cache = await caches.open("shell-v1")
        const used = performance
          .getEntriesByType("resource")
          .map((e) => new URL(e.name))
          .filter((u) => u.origin === location.origin && u.pathname.startsWith("/_next/static/"))
          .map((u) => u.pathname + u.search)
        await Promise.allSettled(used.map((u) => cache.add(u)))
        const page = await fetch("/", { cache: "no-store" })
        if (page.ok) await cache.put("/__shell", page)
      } catch {
        /* no worker support, or private mode: the app still works online */
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])
  return null
}
