"use client"

import { useRef, useState } from "react"
import { Bug, Camera, Star, Lightbulb, X, SpinnerGap } from "@phosphor-icons/react"
import Sheet, { primaryButton, tintButton } from "./sheet"
import { compressFeedbackImage, submitFeedback, type BugDiagnostics, type FeedbackKind } from "@/lib/feedback"

function detectPlatform() {
  if (typeof navigator === "undefined") return "Not sure"
  const ua = navigator.userAgent
  if (/iPad|iPhone|iPod/i.test(ua)) return "iOS / iPadOS"
  if (/Android/i.test(ua)) return "Android"
  if (/Windows/i.test(ua)) return "Windows"
  if (/Mac OS|Macintosh/i.test(ua)) return "macOS"
  if (/Linux/i.test(ua)) return "Linux"
  return "Other / not sure"
}
function detectBrowser() {
  if (typeof navigator === "undefined") return "Not sure"
  const ua = navigator.userAgent
  if (/Edg\//i.test(ua)) return "Microsoft Edge"
  if (/Firefox\//i.test(ua)) return "Firefox"
  if (/Brave/i.test(ua)) return "Brave"
  if (/CriOS|Chrome\//i.test(ua) && !/Edg\//i.test(ua)) return "Chrome"
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return "Safari"
  return "Other / not sure"
}

export default function FeedbackSheet({ open, onClose, onSubmitted }: { open: boolean; onClose: () => void; onSubmitted: () => void }) {
  const [kind, setKind] = useState<FeedbackKind>("bug")
  const [rating, setRating] = useState<number | null>(null)
  const [message, setMessage] = useState("")
  const [imageData, setImageData] = useState<string | undefined>()
  const [imageName, setImageName] = useState("")
  const [busy, setBusy] = useState(false)
  const [compressing, setCompressing] = useState(false)
  const [error, setError] = useState("")
  const [diagnostics, setDiagnostics] = useState<BugDiagnostics>({
    platform: detectPlatform(), deviceType: typeof window !== "undefined" && window.matchMedia("(pointer: coarse)").matches ? "Phone / tablet" : "Computer",
    browser: detectBrowser(), area: "Not sure", frequency: "First time", network: "Not sure",
  })
  const fileRef = useRef<HTMLInputElement>(null)

  const reset = () => { setKind("bug"); setRating(null); setMessage(""); setImageData(undefined); setImageName(""); setError(""); setCompressing(false) }
  const close = () => { if (!busy && !compressing) { reset(); onClose() } }
  const pickImage = async (file?: File) => {
    if (!file) return
    setError(""); setCompressing(true)
    try {
      const compressed = await compressFeedbackImage(file)
      setImageData(compressed)
      setImageName(`${file.name} · ${(compressed.length / 1024).toFixed(0)} KB compressed`)
    } catch (e) { setError(e instanceof Error ? e.message : "Could not process that image.") }
    finally { setCompressing(false); if (fileRef.current) fileRef.current.value = "" }
  }
  const setDiagnostic = (key: keyof BugDiagnostics, value: string) => setDiagnostics(prev => ({ ...prev, [key]: value }))
  const selectClass = "w-full min-w-0 rounded-xl bg-card border border-border px-3 py-2.5 text-[14px] text-ink outline-none focus:ring-1 focus:ring-ink/40"
  return <Sheet open={open} onClose={close} title="Help improve College Tracker" priority="high">
    <div className="space-y-4">
      <p className="text-[13px] text-mute leading-snug">Your feedback goes to the developer. Please avoid including passwords or sensitive personal information.</p>
      <div className="grid grid-cols-3 gap-2">
        {([ ["bug", Bug, "Report a bug"], ["rating", Star, "Rate app"], ["suggestion", Lightbulb, "Suggestion"] ] as const).map(([id, Icon, label]) => <button key={id} type="button" onClick={() => setKind(id)} className={`min-h-[72px] rounded-2xl p-2 flex flex-col items-center justify-center gap-1 text-[12px] font-semibold ${kind === id ? "bg-ink text-paper" : "bg-secondary text-ink"}`}><Icon size={22} weight="duotone" />{label}</button>)}
      </div>
      <div>
        <p className="text-[12px] font-medium uppercase tracking-wider text-mute mb-2">Your rating (optional)</p>
        <div className="flex gap-2" role="radiogroup" aria-label="App rating">
          {[1,2,3,4,5].map(n => <button type="button" key={n} aria-label={`${n} star${n===1?"":"s"}`} aria-pressed={rating===n} onClick={() => setRating(n)} className={`w-10 h-10 rounded-xl grid place-items-center ${rating !== null && n <= rating ? "bg-amber-300 text-black" : "bg-secondary text-mute"}`}><Star size={22} weight={rating !== null && n <= rating ? "fill" : "regular"} /></button>)}
        </div>
      </div>
      <div>
        <label className="block text-[13px] font-medium text-mute mb-1.5" htmlFor="feedback-message">{kind === "bug" ? "What went wrong?" : kind === "suggestion" ? "What would you like to see?" : "Note for the developer (optional)"}</label>
        <textarea id="feedback-message" value={message} onChange={e => setMessage(e.target.value.slice(0,2000))} rows={4} maxLength={2000} placeholder={kind === "bug" ? "What were you trying to do, what did you expect, and what happened?" : "Share a note…"} className="w-full rounded-xl bg-secondary p-3 text-[15px] leading-snug outline-none focus:ring-1 focus:ring-ink/40 resize-y" />
        <p className="text-right text-[11px] text-mute mt-1">{message.length}/2000</p>
      </div>
      {kind === "bug" && <section className="rounded-2xl bg-secondary p-3 space-y-3" aria-label="Bug details">
        <div><h3 className="text-[14px] font-bold">A few quick details</h3><p className="text-[12px] text-mute mt-0.5">These help narrow down the issue. We only send the selections below—not your full browser history or page contents.</p></div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label className="block text-[12px] font-medium text-mute">Device / operating system<select className={selectClass} value={diagnostics.platform} onChange={e => setDiagnostic("platform", e.target.value)}><option>iOS / iPadOS</option><option>Android</option><option>Windows</option><option>macOS</option><option>Linux</option><option>ChromeOS</option><option>Other / not sure</option><option>Not sure</option></select></label>
          <label className="block text-[12px] font-medium text-mute">Device type<select className={selectClass} value={diagnostics.deviceType} onChange={e => setDiagnostic("deviceType", e.target.value)}><option>Phone / tablet</option><option>Computer</option><option>Not sure</option></select></label>
          <label className="block text-[12px] font-medium text-mute">Browser<select className={selectClass} value={diagnostics.browser} onChange={e => setDiagnostic("browser", e.target.value)}><option>Chrome</option><option>Safari</option><option>Firefox</option><option>Microsoft Edge</option><option>Brave</option><option>Other / not sure</option><option>Not sure</option></select></label>
          <label className="block text-[12px] font-medium text-mute">Which part of the app?<select className={selectClass} value={diagnostics.area} onChange={e => setDiagnostic("area", e.target.value)}><option>Not sure</option><option>Today / attendance</option><option>Subjects</option><option>Calendar / holidays</option><option>Sync / data merge</option><option>Mates / connection</option><option>Ping / WhatsApp link</option><option>Notifications</option><option>Feedback / rating</option><option>Setup / sign-in</option><option>Other</option></select></label>
          <label className="block text-[12px] font-medium text-mute">How often does it happen?<select className={selectClass} value={diagnostics.frequency} onChange={e => setDiagnostic("frequency", e.target.value)}><option>First time</option><option>Sometimes</option><option>Every time</option><option>After refresh / reopen</option><option>Not sure</option></select></label>
          <label className="block text-[12px] font-medium text-mute">Connection at the time<select className={selectClass} value={diagnostics.network} onChange={e => setDiagnostic("network", e.target.value)}><option>Not sure</option><option>Wi-Fi</option><option>Mobile data</option><option>Offline / weak signal</option><option>Switched networks</option></select></label>
        </div>
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e => void pickImage(e.target.files?.[0])} />
        <button type="button" disabled={compressing || busy} onClick={() => fileRef.current?.click()} className={`${tintButton} w-full disabled:opacity-60`}>{compressing ? <><SpinnerGap size={18} className="animate-spin"/> Compressing image…</> : <><Camera size={18} /> Attach screenshot (optional)</>}</button>
        {imageData && <div className="flex items-center gap-3"><img src={imageData} alt="Compressed bug report attachment preview" className="w-16 h-16 object-cover rounded-xl" /><span className="min-w-0 flex-1 text-[12px] text-mute break-words">{imageName}</span><button type="button" aria-label="Remove image" onClick={() => {setImageData(undefined);setImageName("")}} className="w-8 h-8 grid place-items-center rounded-full bg-card"><X size={16}/></button></div>}
        <p className="text-[12px] text-mute leading-snug">Any image size can be selected; it is resized and compressed on your device before sending.</p>
      </section>}
      {error && <p role="alert" className="text-[13px] text-bad">{error}</p>}
      <button disabled={busy || compressing || (!message.trim() && rating === null)} className={`${primaryButton} disabled:opacity-50`} onClick={async () => {
        setBusy(true); setError("")
        try { await submitFeedback({ kind, rating, message, imageData, ...(kind === "bug" ? { diagnostics } : {}) }); reset(); onSubmitted(); onClose() }
        catch (e) { setError(e instanceof Error ? e.message : "Could not send feedback. Try again.") }
        finally { setBusy(false) }
      }}>{busy ? <><SpinnerGap size={18} className="animate-spin"/> Sending feedback…</> : "Send feedback"}</button>
      <button type="button" disabled={busy || compressing} onClick={close} className={`${tintButton} w-full`}>Cancel</button>
    </div>
  </Sheet>
}
