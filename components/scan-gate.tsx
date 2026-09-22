"use client"

import { useEffect, useState } from "react"
import { ArrowSquareOut } from "@phosphor-icons/react"
import { copyText } from "@/lib/clipboard"
import { chromeIntentUrl, safariUrl } from "@/lib/in-app"
import { useScrollLock } from "@/lib/use-scroll-lock"

interface Props {
  open: boolean
  /** The scan link to hand to the real browser */
  link: string
  /** Go ahead in this temporary browser anyway */
  onContinue: () => void
}

/**
 * Shown instead of a scan when the link was opened inside a scanner app's built-in browser. The page has already
 * tried to hand itself to the real browser; this is what is left if that didn't happen.
 */
export default function ScanGate({ open, link, onContinue }: Props) {
  useScrollLock(open)
  const [copied, setCopied] = useState<boolean | null>(null)
  const [android, setAndroid] = useState(false)
  useEffect(() => setAndroid(/Android/.test(navigator.userAgent)), [])
  const browser = android ? "Chrome" : "Safari"
  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Open in Safari"
      className="fixed inset-0 z-[70] bg-paper overflow-y-auto overscroll-contain no-scrollbar"
      style={{ paddingTop: "env(safe-area-inset-top)", paddingBottom: "env(safe-area-inset-bottom)" }}
    >
      <div className="mx-auto min-h-dvh max-w-md px-6 py-10 flex flex-col items-center justify-center text-center">
        <span className="w-16 h-16 rounded-full bg-card grid place-items-center text-ink">
          <ArrowSquareOut weight="bold" className="w-8 h-8" />
        </span>
        <h2 className="font-display text-[clamp(24px,7vw,30px)] leading-[1.1] mt-6">Open this in {browser}</h2>
        <p className="text-[15px] text-mute mt-2 leading-snug">
          Your scanner app opened a temporary browser that forgets everything when it closes. {browser} keeps your timetable, so your check-in
          lands in the right place.
        </p>

        <div className="mt-8 w-full grid gap-3">
          <a
            href={android ? chromeIntentUrl(link) : safariUrl(link)}
            className="h-[52px] rounded-2xl bg-ink text-paper text-[17px] font-semibold flex items-center justify-center"
          >
            Open in {browser}
          </a>
          <button
            onClick={async () => setCopied(await copyText(link))}
            className="h-12 rounded-2xl bg-card text-[16px] font-semibold"
          >
            {copied === null ? `Copy link, then paste it in ${browser}` : copied ? "Link copied" : "Couldn’t copy the link"}
          </button>
          <button onClick={onContinue} className="h-11 text-[15px] font-medium text-mute">
            Continue here anyway
          </button>
        </div>
      </div>
    </div>
  )
}
