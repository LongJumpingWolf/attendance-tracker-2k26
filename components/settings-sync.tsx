"use client"

import { useState } from "react"
import { GoogleLogo } from "@phosphor-icons/react"
import type { CloudSync } from "@/hooks/use-cloud-sync"
import { inputClass, primaryButton, tintButton } from "./sheet"

const label = "text-[12px] font-medium uppercase tracking-wider text-mute mb-2 px-1"
const card = "rounded-2xl bg-secondary p-4"

const STATUS: Record<CloudSync["status"], { text: string; cls: string }> = {
  off: { text: "Off", cls: "bg-ink/[0.07] text-mute" },
  syncing: { text: "Syncing…", cls: "bg-ink/[0.07] text-mute" },
  synced: { text: "Up to date", cls: "bg-good/15 text-good" },
  offline: { text: "Can’t reach the store", cls: "bg-bad/10 text-bad" },
}

/** Settings > Sync between browsers: sign in with Google and your data follows you */
export default function SyncPanel({ sync, onToast }: { sync: CloudSync; onToast: (message: string) => void }) {
  const [email, setEmail] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [confirmOut, setConfirmOut] = useState(false)

  const signIn = async () => {
    setBusy(true)
    setError("")
    const problem = await sync.signIn(email)
    setBusy(false)
    if (problem) setError(problem)
  }

  const choose = async (use: "cloud" | "here") => {
    setBusy(true)
    const ok = await sync.resolve(use)
    setBusy(false)
    if (!ok) return setError("Couldn’t save to the sync store. Try again.")
    onToast(use === "cloud" ? "Signed in. Your synced data replaced what was here." : "Signed in. This browser’s data is now the synced copy.")
  }

  if (sync.kind === "none") {
    return (
      <div className={card}>
        <p className="text-[15px] font-semibold">Sync isn’t set up yet</p>
        <p className="text-[13px] text-mute mt-1 leading-snug">
          It needs the Firebase keys in <span className="num">.env.local</span>, Google switched on as a sign-in method, and the updated Firestore
          rules. Until then this browser keeps its own data.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {sync.kind === "dev" && (
        <p className="rounded-2xl bg-warn/15 text-warn text-[13px] font-medium leading-snug px-4 py-3">
          Test mode: no Firebase keys yet, so there is no real Google sign-in. Any email works as a stand-in, and the synced data lives on this dev
          server, so your laptop and phone can sync through it while it is running.
        </p>
      )}

      {sync.choice ? (
        <section>
          <h3 className={label}>This browser already has data</h3>
          <div className={card}>
            <p className="text-[15px] font-semibold leading-snug">Which copy should you keep?</p>
            <p className="text-[13px] text-mute mt-1 leading-snug">
              Your account already has {sync.choice.cloud.subjects.length} {sync.choice.cloud.subjects.length === 1 ? "subject" : "subjects"} saved. The
              two copies can’t be combined, so one replaces the other.
            </p>
            <div className="grid gap-2 mt-4">
              <button disabled={busy} onClick={() => void choose("cloud")} className={primaryButton}>
                Use my account’s copy
              </button>
              <button disabled={busy} onClick={() => void choose("here")} className={tintButton}>
                Keep this browser’s data instead
              </button>
            </div>
            {error && <p className="text-[13px] text-bad mt-2">{error}</p>}
          </div>
        </section>
      ) : sync.account ? (
        <>
          <section>
            <h3 className={label}>Account</h3>
            <div className={`${card} flex items-center gap-3`}>
              <span className="min-w-0 flex-1">
                <span className="block text-[16px] font-semibold leading-snug truncate">{sync.account.name}</span>
                <span className="block text-[13px] text-mute leading-snug truncate">{sync.account.email}</span>
                <span className="block text-[13px] text-mute leading-snug">
                  {sync.lastAt ? `Last synced ${new Date(sync.lastAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Not synced yet"}
                </span>
              </span>
              <span className={`text-[12px] font-semibold rounded-full px-2.5 py-1 ${STATUS[sync.status].cls}`}>{STATUS[sync.status].text}</span>
            </div>
            <button
              onClick={async () => onToast((await sync.syncNow()) ? "Updated from your other browser" : "Everything is up to date")}
              className={`${tintButton} w-full mt-2`}
            >
              Sync now
            </button>
            <p className="text-[13px] text-mute mt-3 px-1 leading-snug">
              Sign in with this same account in any other browser and your subjects, marks and deadlines appear there. A scanned QR code then marks
              your attendance whichever browser opens it.
            </p>
          </section>

          <section>
            {confirmOut ? (
              <div className={card}>
                <p className="text-[15px] font-semibold leading-snug">Sign out in this browser?</p>
                <p className="text-[13px] text-mute mt-1 leading-snug">Nothing is deleted. Your account’s copy and the data here both stay as they are.</p>
                <div className="grid grid-cols-2 gap-2 mt-3">
                  <button onClick={() => setConfirmOut(false)} className={tintButton}>
                    Stay signed in
                  </button>
                  <button
                    onClick={() => {
                      setConfirmOut(false)
                      void sync.signOut()
                    }}
                    className={`${tintButton} text-bad`}
                  >
                    Sign out
                  </button>
                </div>
              </div>
            ) : (
              <button onClick={() => setConfirmOut(true)} className="text-[14px] text-mute px-1">
                Sign out in this browser
              </button>
            )}
          </section>
        </>
      ) : (
        <section>
          <h3 className={label}>Use your data in any browser</h3>
          <div className={card}>
            <p className="text-[13px] text-mute leading-snug">
              Sign in once in each browser you use (Safari, the home-screen app, Chrome). Your subjects, marks and deadlines are saved to your account
              and appear everywhere you sign in.
            </p>

            {sync.kind === "dev" && (
              <input
                value={email}
                onChange={(e) => {
                  setEmail(e.target.value)
                  setError("")
                }}
                placeholder="test@example.com"
                inputMode="email"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className={`${inputClass} mt-3`}
                aria-label="Test email"
              />
            )}

            <button disabled={busy} onClick={() => void signIn()} className={`${primaryButton} w-full mt-3 flex items-center justify-center gap-2`}>
              <GoogleLogo weight="bold" className="w-5 h-5" />
              {busy ? "Signing in…" : sync.kind === "dev" ? "Test sign-in" : "Sign in with Google"}
            </button>
            {error && <p className="text-[13px] text-bad mt-2 leading-snug">{error}</p>}
            <p className="text-[12px] text-mute mt-3 leading-snug">
              Google may refuse to sign in inside a scanner app’s built-in browser. If it does, open the page in Safari or Chrome.
            </p>
          </div>
        </section>
      )}
    </div>
  )
}
