"use client"

import { useEffect } from "react"
import { Bug, ThumbsUp } from "@phosphor-icons/react"

export default function FeedbackCelebration({ open, kind = "thanks", message, onClose }: { open: boolean; kind?: "thanks" | "bug"; message?: string; onClose: () => void }) {
  useEffect(() => { if (!open) return; const timer = window.setTimeout(onClose, message ? 8000 : 3000); return () => window.clearTimeout(timer) }, [open, onClose, message])
  if (!open) return null
  const Icon = kind === "bug" ? Bug : ThumbsUp
  return <div className="fixed inset-0 z-[100] grid place-items-center bg-black/35 p-5" role="status" aria-live="polite" onClick={onClose}>
    <div className="animate-feedback-pop w-full max-w-xs max-h-[80dvh] overflow-y-auto rounded-[28px] bg-card shadow-2xl p-6 text-center" onClick={e => e.stopPropagation()}>
      <div className={`mx-auto mb-4 w-20 h-20 rounded-3xl grid place-items-center ${kind === "bug" ? "animate-feedback-bug bg-good/15 text-good" : "animate-feedback-icon bg-ink text-paper"}`}><Icon size={42} weight="duotone" /></div>
      <h2 className="text-[22px] font-bold">{kind === "bug" ? "Bug swatted!" : "Thank you!"}</h2>
      <p className="text-[14px] text-mute leading-snug mt-2">{message || (kind === "bug" ? "Thanks for reporting this. The developer has replied to your bug report." : "The developer has read your feedback and sends their thanks.")}</p>
      <button onClick={onClose} className="mt-5 w-full h-11 rounded-xl bg-secondary text-[14px] font-semibold">Done</button>
    </div>
    <style jsx>{`
      @keyframes feedback-pop { 0% { opacity:0; transform:translateY(18px) scale(.88) } 70% { opacity:1; transform:translateY(-3px) scale(1.02) } 100% { opacity:1; transform:translateY(0) scale(1) } }
      @keyframes feedback-icon { 0% { transform:scale(.3) rotate(-18deg) } 65% { transform:scale(1.16) rotate(8deg) } 100% { transform:scale(1) rotate(0) } }
      @keyframes feedback-bug { 0% { transform:translateY(-14px) rotate(-18deg) scale(1.1) } 35% { transform:translateY(4px) rotate(16deg) scale(.94) } 55% { transform:translateY(-2px) rotate(-10deg) scale(.82,1.08) } 75% { transform:translateY(1px) rotate(4deg) scale(1.05,.9) } 100% { transform:translateY(0) rotate(0) scale(1) } }
      .animate-feedback-pop { animation:feedback-pop .42s cubic-bezier(.2,.8,.2,1) both }
      .animate-feedback-icon { animation:feedback-icon .65s cubic-bezier(.2,.8,.2,1) both }
      .animate-feedback-bug { animation:feedback-bug .9s cubic-bezier(.2,.8,.2,1) both }
      @media (prefers-reduced-motion: reduce) { .animate-feedback-pop,.animate-feedback-icon,.animate-feedback-bug { animation:none } }
    `}</style>
  </div>
}
