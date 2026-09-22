"use client"

import { useEffect } from "react"
import { applyTheme, readTheme } from "@/lib/theme"

/** Applies the saved theme on load and follows the device setting while the choice is "system" */
export default function ThemeSync() {
  useEffect(() => {
    applyTheme(readTheme())
    const media = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = () => {
      if (readTheme() === "system") applyTheme("system")
    }
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [])
  return null
}
