"use client"

import { useState } from "react"
import { CloudArrowUp, GoogleLogo, ShieldCheck, WarningCircle } from "@phosphor-icons/react"
import type { CloudSync } from "@/hooks/use-cloud-sync"
import type { SocialApi } from "@/lib/use-social"
import { inputClass, primaryButton, tintButton } from "./sheet"
import SyncPanel from "./settings-sync"

/** The Mates feature requires a stable Google-backed identity. Local attendance remains usable without sign-in. */
export default function MatesAccessGate({
  sync,
  social,
  onToast,
}: {
  sync: CloudSync
  social: SocialApi
  onToast: (message: string) => void
}) {
  const [email, setEmail] = useState("")
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState("")

  // When Google belongs to an account already used on another device, preserve the existing safe switch/reconnect flow.
  if (sync.switchPlan) {
    return (
      <div className="space-y-4">
        <section className="rounded-2xl bg-card p-5 space-y-2">
          <p className="text-[19px] font-bold">Connect your account to unlock Mates</p>
          <p className="text-[14px] text-mute leading-snug">Your sign-in found an account already used elsewhere. Review the account-switch and mate-reconnection choice below before continuing.</p>
        </section>
        <SyncPanel sync={sync} onToast={onToast} />
      </div>
    )
  }

  const submit = async () => {
    setBusy(true)
    setError("")
    const problem = await sync.signIn(sync.kind === "dev" ? email : undefined)
    setBusy(false)
    if (problem) setError(problem)
  }

  return (
    <div className="mx-auto w-full max-w-xl space-y-4">
      <section className="rounded-3xl bg-card p-5 sm:p-6">
        <div className="w-12 h-12 rounded-2xl bg-secondary grid place-items-center">
          <ShieldCheck weight="duotone" className="w-7 h-7" />
        </div>
        <p className="text-[24px] font-bold tracking-tight leading-tight mt-4">Sign in to unlock Mates</p>
        <p className="text-[15px] text-mute leading-snug mt-2">
          Mates, connection requests and direct in-app Pings need a stable account so we can identify the right person and protect attendance records. Use the same Google account on every device; it will also be used for your cloud sync.
        </p>

        <div className="rounded-2xl bg-warn/10 p-4 mt-5 flex items-start gap-3">
          <WarningCircle weight="fill" className="w-5 h-5 text-warn flex-shrink-0 mt-0.5" />
          <div className="min-w-0">
            <p className="text-[14px] font-semibold">Your data is currently saved on this device</p>
            <p className="text-[13px] text-mute leading-snug mt-1">
              Subjects, attendance, deadlines and other app data are stored locally in this browser. They can be lost if you clear this site’s data, delete or reset the browser profile, use private browsing, or lose the device. Signing in lets the app back up and sync your data, but wait until Sync says “Up to date” before relying on the cloud copy.
            </p>
          </div>
        </div>

        {sync.kind === "none" ? (
          <div className="rounded-2xl bg-secondary p-4 mt-4">
            <p className="text-[14px] font-semibold">Sign-in is not configured yet</p>
            <p className="text-[13px] text-mute leading-snug mt-1">The app owner needs to configure Firebase/Google sign-in and the cloud-sync backend before Mates can be unlocked. Your local attendance remains available.</p>
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            {sync.kind === "dev" && (
              <label className="block">
                <span className="block text-[12px] font-medium uppercase tracking-wider text-mute mb-2 px-1">Test account email</span>
                <input
                  value={email}
                  onChange={(e) => { setEmail(e.target.value); setError("") }}
                  placeholder="test@example.com"
                  inputMode="email"
                  autoCapitalize="off"
                  autoCorrect="off"
                  spellCheck={false}
                  className={inputClass}
                />
              </label>
            )}
            {social.configured && social.status !== "ready" && (
              <p className="text-[12px] text-mute leading-snug" role="status">
                {social.status === "error" ? `Friend identity setup needs attention: ${social.error}` : "Preparing your friend identity so existing connections can be preserved…"}
              </p>
            )}
            <button
              type="button"
              disabled={busy || (sync.kind === "dev" ? !/^\S+@\S+$/.test(email.trim()) : !social.configured || social.status !== "ready")}
              onClick={() => void submit()}
              className={`${primaryButton} w-full flex items-center justify-center gap-2`}
            >
              {sync.kind === "dev" ? <CloudArrowUp weight="bold" className="w-5 h-5" /> : <GoogleLogo weight="bold" className="w-5 h-5" />}
              {busy ? "Signing in…" : sync.kind === "dev" ? "Test sign-in and sync" : "Sign in with Google"}
            </button>
            {social.configured && (social.status === "error" || social.status === "idle" || social.status === "off") && (
              <button type="button" onClick={social.enable} className={`${tintButton} w-full`}>
                {social.status === "error" ? "Retry friend identity setup" : "Prepare friend identity"}
              </button>
            )}
            {error && <p className="text-[13px] text-bad leading-snug" role="alert">{error}</p>}
            <p className="text-[12px] text-mute leading-snug">If Google sign-in opens a blank window or fails inside a QR scanner, open this site in Chrome or Safari and try again.</p>
          </div>
        )}
      </section>
      <section className="rounded-2xl bg-card p-4">
        <div className="flex items-start gap-3">
          <CloudArrowUp weight="duotone" className="w-5 h-5 flex-shrink-0 mt-0.5" />
          <div>
            <p className="text-[14px] font-semibold">One account for Mates and sync</p>
            <p className="text-[13px] text-mute leading-snug mt-1">After signing in, open Settings → Sync and confirm the status reaches “Up to date.” If this device and the account both contain data, the app will ask how to combine them before replacing anything.</p>
          </div>
        </div>
      </section>
    </div>
  )
}
