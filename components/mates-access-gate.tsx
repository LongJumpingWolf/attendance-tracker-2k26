"use client"

import { useState } from "react"
import { CloudArrowUp, GoogleLogo, Heart, ShieldCheck, SpinnerGap, WarningCircle, UsersThree } from "@phosphor-icons/react"
import type { CloudSync } from "@/hooks/use-cloud-sync"
import type { SocialApi } from "@/lib/use-social"
import { inputClass, primaryButton, tintButton } from "./sheet"
import SyncPanel from "./settings-sync"

/** The Mates feature requires a stable Google-backed identity. Local attendance remains usable without sign-in. */
export default function MatesAccessGate({ sync, social, onToast }: { sync: CloudSync; social: SocialApi; onToast: (message: string) => void }) {
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  if (sync.switchPlan) {
    return <div className="space-y-4">
      <section className="rounded-3xl bg-card p-5 space-y-2"><p className="text-[19px] font-bold">One quick account check</p><p className="text-[14px] text-mute leading-snug">This Google account has been used on another device. Review the account-switch and Mate-reconnection choice below before continuing.</p></section>
      <SyncPanel sync={sync} onToast={onToast} />
    </div>
  }

  const submit = async () => {
    setBusy(true); setError("")
    try {
      const problem = await sync.signIn(sync.kind === "dev" ? email : undefined)
      if (problem) setError(problem)
    } catch (e) { setError(e instanceof Error ? e.message : "Sign-in could not start. Please try again.") }
    finally { setBusy(false) }
  }

  return <div className="mx-auto w-full max-w-xl space-y-3">
    <section className="rounded-3xl bg-card p-4 sm:p-6 overflow-hidden">
      <div className="relative mx-auto mb-3 h-28 w-full max-w-[220px] flex items-center justify-center" aria-hidden="true">
        <span className="mates-orbit absolute inset-3 rounded-full bg-good/10" />
        <span className="mates-float absolute left-7 top-3 grid h-10 w-10 place-items-center rounded-2xl bg-secondary text-ink shadow-sm"><Heart size={20} weight="fill" /></span>
        <span className="mates-float-late absolute right-7 top-5 grid h-9 w-9 place-items-center rounded-2xl bg-good/15 text-good"><CloudArrowUp size={20} weight="duotone" /></span>
        <div className="relative flex items-end gap-2">
          <span className="grid h-[58px] w-[58px] place-items-center rounded-[22px] bg-secondary text-ink shadow-sm"><UsersThree size={35} weight="duotone" /></span>
          <span className="mb-1 grid h-[46px] w-[46px] place-items-center rounded-[18px] bg-good text-white shadow-sm"><Heart size={24} weight="fill" /></span>
        </div>
      </div>
      <p className="text-center text-[11px] font-bold uppercase tracking-[0.16em] text-good">A little help from your friends</p>
      <h2 className="mt-1 text-center text-[25px] font-bold tracking-tight leading-tight">Meet your Mates</h2>
      <p className="mx-auto mt-2 max-w-sm text-center text-[14px] text-mute leading-relaxed">Sign in once to connect with friends, send direct Pings and use the same account to sync your attendance across devices.</p>

      {sync.kind === "none" ? <div className="rounded-2xl bg-secondary p-3 mt-4"><p className="text-[14px] font-semibold">Sign-in is not available yet</p><p className="text-[13px] text-mute leading-snug mt-1">The app owner needs to configure Google sign-in and cloud sync first. Your local attendance remains available.</p></div> : <div className="mt-4 space-y-3">
        {sync.kind === "dev" && <label className="block"><span className="block text-[12px] font-medium uppercase tracking-wider text-mute mb-2 px-1">Test account email</span><input value={email} onChange={e => { setEmail(e.target.value); setError("") }} placeholder="test@example.com" inputMode="email" autoCapitalize="off" autoCorrect="off" spellCheck={false} className={inputClass} /></label>}
        {social.configured && social.status !== "ready" && <p className="text-[12px] text-mute leading-snug" role="status">{social.status === "error" ? `Friend setup needs attention: ${social.error}` : "Getting your account ready…"}</p>}
        <button type="button" disabled={busy || (sync.kind === "dev" ? !/^\S+@\S+$/.test(email.trim()) : !social.configured || social.status !== "ready")} onClick={() => void submit()} className={`${primaryButton} w-full flex items-center justify-center gap-2 disabled:opacity-55`}>
          {busy ? <SpinnerGap className="h-5 w-5 animate-spin" /> : sync.kind === "dev" ? <CloudArrowUp weight="bold" className="h-5 w-5" /> : <GoogleLogo weight="bold" className="h-5 w-5" />}
          {busy ? "Connecting securely…" : sync.kind === "dev" ? "Test sign-in and sync" : "Continue with Google"}
        </button>
        {social.configured && (social.status === "error" || social.status === "idle" || social.status === "off") && <button type="button" onClick={social.enable} className={`${tintButton} w-full`}>Try connection again</button>}
        {error && <p className="text-[13px] text-bad leading-snug" role="alert">{error}</p>}
        <p className="text-center text-[12px] text-mute leading-snug">If sign-in opens a blank window, open this page directly in Chrome or Safari and try again.</p>
      </div>}
    </section>

    <section className="rounded-2xl border border-warn/15 bg-warn/5 p-3.5 flex items-start gap-3">
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-warn/10 text-warn"><WarningCircle size={18} weight="fill" /></span>
      <div className="min-w-0"><p className="text-[13px] font-semibold">Your attendance is safe here for now</p><p className="mt-1 text-[12px] text-mute leading-snug">Without sync, your data stays in this browser. Clearing site data, resetting/deleting the browser profile, private browsing, or losing the device can make it unavailable. After signing in, wait for <b>Up to date</b> before relying on the cloud copy.</p></div>
    </section>
    <section className="rounded-2xl bg-card p-3.5 flex items-start gap-3">
      <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-secondary"><ShieldCheck size={18} weight="duotone" /></span>
      <div><p className="text-[13px] font-semibold">You stay in control</p><p className="mt-1 text-[12px] text-mute leading-snug">Your local subjects and attendance remain usable without signing in. Google sign-in is only needed for Mates and cross-device sync.</p></div>
    </section>
    <style jsx>{`
      @keyframes mates-float { 0%,100% { transform:translateY(0) rotate(-4deg) } 50% { transform:translateY(-6px) rotate(3deg) } }
      @keyframes mates-orbit { 0%,100% { transform:scale(.96); opacity:.7 } 50% { transform:scale(1.04); opacity:1 } }
      .mates-float { animation:mates-float 3.2s ease-in-out infinite }
      .mates-float-late { animation:mates-float 3.6s ease-in-out -1.1s infinite }
      .mates-orbit { animation:mates-orbit 4s ease-in-out infinite }
      @media (prefers-reduced-motion: reduce) { .mates-float,.mates-float-late,.mates-orbit { animation:none } }
    `}</style>
  </div>
}
