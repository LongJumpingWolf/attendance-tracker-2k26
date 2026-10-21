"use client"

import { useRef, useState } from "react"
import { Bug, Camera, Star, Lightbulb, X } from "@phosphor-icons/react"
import Sheet, { primaryButton, tintButton } from "./sheet"
import { compressFeedbackImage, submitFeedback, type FeedbackKind } from "@/lib/feedback"

export default function FeedbackSheet({ open, onClose, onSubmitted }: { open: boolean; onClose: () => void; onSubmitted: () => void }) {
  const [kind, setKind] = useState<FeedbackKind>("bug")
  const [rating, setRating] = useState<number | null>(null)
  const [message, setMessage] = useState("")
  const [imageData, setImageData] = useState<string | undefined>()
  const [imageName, setImageName] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")
  const fileRef = useRef<HTMLInputElement>(null)

  const reset = () => { setKind("bug"); setRating(null); setMessage(""); setImageData(undefined); setImageName(""); setError("") }
  const close = () => { if (!busy) { reset(); onClose() } }
  const pickImage = async (file?: File) => {
    if (!file) return
    setError("")
    try {
      const compressed = await compressFeedbackImage(file)
      setImageData(compressed)
      setImageName(`${file.name} · ${(compressed.length / 1024).toFixed(0)} KB compressed`)
    } catch (e) { setError(e instanceof Error ? e.message : "Could not process that image.") }
  }
  return <Sheet open={open} onClose={close} title="Help improve College Tracker">
    <div className="space-y-4">
      <p className="text-[13px] text-mute leading-snug">Your feedback goes to the developer. Please avoid including passwords or sensitive personal information.</p>
      <div className="grid grid-cols-3 gap-2">
        {([ ["bug", Bug, "Report a bug"], ["rating", Star, "Rate app"], ["suggestion", Lightbulb, "Suggestion"] ] as const).map(([id, Icon, label]) => <button key={id} onClick={() => setKind(id)} className={`min-h-[72px] rounded-2xl p-2 flex flex-col items-center justify-center gap-1 text-[12px] font-semibold ${kind === id ? "bg-ink text-paper" : "bg-secondary text-ink"}`}><Icon size={22} weight="duotone" />{label}</button>)}
      </div>
      <div>
        <p className="text-[12px] font-medium uppercase tracking-wider text-mute mb-2">Your rating (optional)</p>
        <div className="flex gap-2" role="radiogroup" aria-label="App rating">
          {[1,2,3,4,5].map(n => <button key={n} aria-label={`${n} star${n===1?"":"s"}`} aria-pressed={rating===n} onClick={() => setRating(n)} className={`w-10 h-10 rounded-xl grid place-items-center ${rating !== null && n <= rating ? "bg-amber-300 text-black" : "bg-secondary text-mute"}`}><Star size={22} weight={rating !== null && n <= rating ? "fill" : "regular"} /></button>)}
        </div>
      </div>
      <div>
        <label className="block text-[13px] font-medium text-mute mb-1.5" htmlFor="feedback-message">{kind === "bug" ? "What went wrong?" : kind === "suggestion" ? "What would you like to see?" : "Note for the developer (optional)"}</label>
        <textarea id="feedback-message" value={message} onChange={e => setMessage(e.target.value.slice(0,2000))} rows={4} maxLength={2000} placeholder={kind === "bug" ? "What did you tap, what did you expect, and what happened?" : "Share a note…"} className="w-full rounded-xl bg-secondary p-3 text-[15px] leading-snug outline-none focus:ring-1 focus:ring-ink/40 resize-y" />
        <p className="text-right text-[11px] text-mute mt-1">{message.length}/2000</p>
      </div>
      {kind === "bug" && <div className="rounded-2xl bg-secondary p-3 space-y-2">
        <input ref={fileRef} type="file" accept="image/*" className="hidden" onChange={e => void pickImage(e.target.files?.[0])} />
        <button type="button" onClick={() => fileRef.current?.click()} className={`${tintButton} w-full`}><Camera size={18} /> Attach screenshot (optional)</button>
        {imageData && <div className="flex items-center gap-3"><img src={imageData} alt="Compressed bug report attachment preview" className="w-16 h-16 object-cover rounded-xl" /><span className="min-w-0 flex-1 text-[12px] text-mute break-words">{imageName}</span><button aria-label="Remove image" onClick={() => {setImageData(undefined);setImageName("")}} className="w-8 h-8 grid place-items-center rounded-full bg-card"><X size={16}/></button></div>}
        <p className="text-[12px] text-mute leading-snug">Images are resized and compressed on your device before upload.</p>
      </div>}
      {error && <p role="alert" className="text-[13px] text-bad">{error}</p>}
      <button disabled={busy || (!message.trim() && rating === null)} className={`${primaryButton} disabled:opacity-40`} onClick={async () => {
        setBusy(true); setError("")
        try { await submitFeedback({ kind, rating, message, imageData }); reset(); onSubmitted(); onClose() }
        catch (e) { setError(e instanceof Error ? e.message : "Could not send feedback. Try again.") }
        finally { setBusy(false) }
      }}>{busy ? "Sending…" : "Send feedback"}</button>
      <button disabled={busy} onClick={close} className={`${tintButton} w-full`}>Cancel</button>
    </div>
  </Sheet>
}
