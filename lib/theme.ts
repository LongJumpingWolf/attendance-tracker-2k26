/** Light / dark / follow the device. The choice is kept in localStorage under "theme". */
export type ThemePref = "system" | "light" | "dark"

export const THEME_KEY = "theme"
const COLORS = { light: "#f2f2f7", dark: "#000000" }

export function readTheme(): ThemePref {
  try {
    const t = localStorage.getItem(THEME_KEY)
    return t === "light" || t === "dark" ? t : "system"
  } catch {
    return "system"
  }
}

const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches

/** Puts the "dark" class on <html>, so every colour token flips at once, and keeps the browser bar in step */
export function applyTheme(pref: ThemePref) {
  const dark = pref === "dark" || (pref === "system" && prefersDark())
  const root = document.documentElement
  root.classList.toggle("dark", dark)
  root.style.colorScheme = dark ? "dark" : "light"
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]:not([media])')
  if (!meta) {
    meta = document.createElement("meta")
    meta.name = "theme-color"
    document.head.appendChild(meta)
  }
  meta.content = dark ? COLORS.dark : COLORS.light
}

export function setTheme(pref: ThemePref) {
  try {
    if (pref === "system") localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, pref)
  } catch {
    /* not remembered, but it still applies now */
  }
  applyTheme(pref)
}
