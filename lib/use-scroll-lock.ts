"use client"

import { useEffect } from "react"

/**
 * Freezes the page behind a sheet or full-screen overlay so scrolling only moves what's on top.
 * Several overlays can be open at once (a sheet over a sheet), so it counts them and only lets go
 * when the last one closes.
 */
let locks = 0
let saved = { body: "", html: "", padding: "" }

export function useScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return
    const body = document.body
    const html = document.documentElement

    if (locks === 0) {
      // The page's scrollbar disappears when it is locked; pad by its width so nothing jumps sideways
      const gap = window.innerWidth - html.clientWidth
      saved = { body: body.style.overflow, html: html.style.overflow, padding: body.style.paddingRight }
      body.style.overflow = "hidden"
      html.style.overflow = "hidden"
      if (gap > 0) body.style.paddingRight = `${gap}px`
    }
    locks += 1

    return () => {
      locks -= 1
      if (locks === 0) {
        body.style.overflow = saved.body
        html.style.overflow = saved.html
        body.style.paddingRight = saved.padding
      }
    }
  }, [active])
}
