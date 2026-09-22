"use client"

import { useEffect, useState } from "react"
import QRCode from "qrcode"
import { copyText } from "@/lib/clipboard"
import { inputClass, tintButton } from "./sheet"

const KEY = "scanBaseUrl"
const LAN_FALLBACK = "http://192.168.1.66:3000"

interface Props {
  testCount: number
  onAddTest: (withOverlap: boolean) => void
  onRemoveTest: () => void
  onSimulateScan: () => void
  onPreviewAnimation: () => void
  onToast: (message: string) => void
}

const label = "text-[12px] font-medium uppercase tracking-wider text-mute mb-2 px-1"

/** Developer panel: the master QR code, a timetable to test it with, and buttons that trigger the scan flow by hand */
export default function ScanPanel({ testCount, onAddTest, onRemoveTest, onSimulateScan, onPreviewAnimation, onToast }: Props) {
  const [base, setBase] = useState("")
  const [qr, setQr] = useState("")

  // The code must point at an address a phone can reach, so localhost is swapped for the network address
  useEffect(() => {
    let saved = ""
    try {
      saved = localStorage.getItem(KEY) ?? ""
    } catch {
      /* private mode */
    }
    const here = window.location.origin
    setBase(saved || (/localhost|127\.0\.0\.1/.test(here) ? LAN_FALLBACK : here))
  }, [])

  const link = `${base.trim().replace(/\/+$/, "")}/scan`

  useEffect(() => {
    if (!base.trim()) return setQr("")
    QRCode.toDataURL(link, { margin: 1, width: 640, color: { dark: "#000000", light: "#ffffff" } })
      .then(setQr)
      .catch(() => setQr(""))
  }, [base, link])

  const change = (v: string) => {
    setBase(v)
    try {
      localStorage.setItem(KEY, v)
    } catch {
      /* private mode */
    }
  }

  return (
    <div className="space-y-6">
      <section>
        <h3 className={label}>Master QR code</h3>
        <div className="rounded-2xl bg-secondary p-4 text-center">
          <div className="mx-auto w-52 h-52 rounded-2xl bg-white grid place-items-center overflow-hidden">
            {qr ? <img src={qr} alt="Scan check-in QR code" width={208} height={208} className="w-full h-full" /> : <span className="text-black/40 text-sm">…</span>}
          </div>
          <p className="num text-[13px] text-mute mt-3 break-all">{link}</p>
          <p className="text-[13px] text-mute mt-1 leading-snug">
            Scanning opens the app, marks the class that fits the time, and plays the check-in animation. The code never changes.
          </p>

          <label className="block text-left mt-4">
            <span className="block text-[13px] font-medium text-mute mb-1.5">App address</span>
            <input
              value={base}
              onChange={(e) => change(e.target.value)}
              inputMode="url"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
              className={inputClass}
            />
          </label>

          <div className="grid grid-cols-2 gap-2 mt-3">
            <button
              onClick={async () => onToast((await copyText(link)) ? "Link copied" : "Couldn’t copy the link")}
              className={tintButton}
            >
              Copy link
            </button>
            <a href={qr || undefined} download="attendance-scan-code.png" className={`${tintButton} grid place-items-center`}>
              Save image
            </a>
          </div>
        </div>
      </section>

      <section>
        <h3 className={label}>NFC tag</h3>
        <div className="rounded-2xl bg-secondary p-4">
          <p className="text-[13px] text-mute leading-snug">
            The reliable route on iPhone: a QR scanner app often opens a temporary browser that forgets your data, but an NFC tap is read by the
            phone itself and opens straight in Safari, where your data already is.
          </p>
          <ol className="mt-3 space-y-2 text-[13px] leading-snug list-decimal list-inside text-mute">
            <li>Buy NFC stickers (NTAG213 or better, anti-metal if going on a desk or door).</li>
            <li>
              Write the same link as the QR code to a tag using a free app like NFC Tools: Write → Add a record → URL, then paste it in.
            </li>
            <li>Tap the tag with the top of an iPhone (XS or later) or any NFC Android phone.</li>
          </ol>
          <button
            onClick={async () => onToast((await copyText(link)) ? "Link copied" : "Couldn’t copy the link")}
            className={`${tintButton} w-full mt-3`}
          >
            Copy link to write to a tag
          </button>
        </div>
      </section>

      <section>
        <h3 className={label}>Test timetable</h3>
        <div className="rounded-2xl bg-secondary p-4">
          <p className="text-[13px] text-mute leading-snug mb-3">
            Adds four classes for today built around the current time: one in progress, one that ended earlier, and two later. Times are
            fixed when you add them, so add again to refresh. {testCount > 0 ? `${testCount} test subjects are in your list.` : ""}
          </p>
          <div className="grid grid-cols-2 gap-2">
            <button onClick={() => onAddTest(false)} className={tintButton}>
              {testCount ? "Refresh test timetable" : "Add test timetable"}
            </button>
            <button onClick={() => onAddTest(true)} className={tintButton}>
              Add with a clash
            </button>
            {testCount > 0 && (
              <button onClick={onRemoveTest} className={`${tintButton} col-span-2 text-bad`}>
                Remove test subjects
              </button>
            )}
          </div>
        </div>
      </section>

      <section>
        <h3 className={label}>Trigger by hand</h3>
        <div className="grid grid-cols-1 gap-2">
          <button onClick={onSimulateScan} className={tintButton}>
            Simulate a scan now (marks the class that fits)
          </button>
          <button onClick={onPreviewAnimation} className={tintButton}>
            Play the animation only (changes nothing)
          </button>
        </div>
      </section>
    </div>
  )
}
