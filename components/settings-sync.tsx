"use client"

import { useEffect, useState } from "react"
import { getAuth, updateProfile } from "firebase/auth"
import { GoogleLogo, SpinnerGap, UserCircle, PencilSimple } from "@phosphor-icons/react"
import { app } from "@/lib/firebase"
import { saveProfile } from "@/lib/social"
import type { CloudSync } from "@/hooks/use-cloud-sync"
import { inputClass, primaryButton, tintButton } from "./sheet"

const label = "text-[12px] font-medium uppercase tracking-wider text-mute mb-2 px-1"
const card = "rounded-2xl bg-secondary p-4"

const STATUS: Record<CloudSync["status"], { text: string; cls: string }> = {
  off: { text: "Off", cls: "bg-ink/[0.07] text-mute" },
  syncing: { text: "Syncing…", cls: "bg-ink/[0.07] text-mute" },
  synced: { text: "Up to date", cls: "bg-good/15 text-good" },
  offline: { text: "Offline", cls: "bg-ink/[0.07] text-mute" },
  "too-large": { text: "Not backed up", cls: "bg-bad/10 text-bad" },
  "needs-choice": { text: "Waiting for you", cls: "bg-warn/15 text-warn" },
  paused: { text: "Paused while the demo shows", cls: "bg-ink/[0.07] text-mute" },
}

/** Settings > Sync between browsers: sign in with Google and your data follows you */
export default function SyncPanel({ sync, onToast }: { sync: CloudSync; onToast: (message: string) => void }) {
  const [email, setEmail] = useState("")
  const [error, setError] = useState("")
  const [busy, setBusy] = useState(false)
  const [redirectBusy, setRedirectBusy] = useState(false)
  const [confirmOut, setConfirmOut] = useState(false)
  const [profileName, setProfileName] = useState(sync.account?.name || "Your account")
  const [nameDraft, setNameDraft] = useState(sync.account?.name || "")
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null)
  const [editingName, setEditingName] = useState(false)
  const [nameError, setNameError] = useState("")
  const [nameChangesUsed, setNameChangesUsed] = useState(0)
  const NAME_CHANGE_LIMIT = 3
  const NAME_LIMIT_KEY = "attendance-profile-name-change-limit"
  const nameMonth = () => {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`
  }
  const readNameChangeCount = () => {
    try {
      const raw = localStorage.getItem(NAME_LIMIT_KEY)
      if (!raw) return 0
      const saved = JSON.parse(raw) as { month?: string; count?: number }
      return saved.month === nameMonth() && Number.isFinite(saved.count) ? Math.max(0, Math.min(NAME_CHANGE_LIMIT, Number(saved.count))) : 0
    } catch { return 0 }
  }

  useEffect(() => {
    let savedName = sync.account?.name || "Your account"
    try {
      const local = localStorage.getItem("displayName")?.trim()
      if (local) savedName = local
    } catch { /* local name is optional */ }
    setProfileName(savedName)
    setNameDraft(savedName)
    setNameChangesUsed(readNameChangeCount())
    const user = getAuth(app).currentUser
    setAvatarUrl(user?.photoURL || null)
  }, [sync.account?.id, sync.account?.name])
  
  const saveProfileName = async () => {
    const next = nameDraft.trim().replace(/\s+/g, " ")
    if (!next) return setNameError("Enter a name to continue.")
    if (next.length > 40) return setNameError("Use 40 characters or fewer.")
    if (next === profileName) {
      setEditingName(false)
      setNameError("")
      return
    }
    const used = readNameChangeCount()
    if (used >= NAME_CHANGE_LIMIT) {
      setNameChangesUsed(used)
      return setNameError("You’ve used all 3 name changes for this month. You can change it again next month.")
    }
    setNameError("")
    setBusy(true)
    try {
      const user = getAuth(app).currentUser
      if (user && !user.isAnonymous) await updateProfile(user, { displayName: next })
      // Mates read the name from the account's cloud profile, and a new browser starts from it, so it has to be saved there too
      if (user) await saveProfile(user.uid, next)
      localStorage.setItem("displayName", next)
      window.dispatchEvent(new CustomEvent("display-name-changed", { detail: next }))
      localStorage.setItem(NAME_LIMIT_KEY, JSON.stringify({ month: nameMonth(), count: used + 1 }))
      setProfileName(next)
      setNameDraft(next)
      setNameChangesUsed(used + 1)
      setEditingName(false)
      onToast("Display name updated")
    } catch (e) {
      setNameError(e instanceof Error ? e.message : "Could not update your name. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  const signIn = async () => {
    setBusy(true)
    setError("")
    try {
      const problem = await sync.signIn(email)
      if (problem) setError(problem)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in could not start. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  const signInRedirect = async () => {
    setRedirectBusy(true)
    setError("")
    try {
      const problem = await sync.signInRedirect()
      if (problem) setError(problem)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Full-page sign-in could not start. Please try again.")
    } finally {
      setRedirectBusy(false)
    }
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

      {sync.switchPlan ? (
        <section>
          <h3 className={label}>This Google account is already set up</h3>
          <div className={card}>
            <p className="text-[15px] font-semibold leading-snug">Use it here, and reconnect your mates?</p>
            <p className="text-[13px] text-mute mt-1 leading-snug">
              Your Google account was first used on another device, so this device will switch to it. The{" "}
              {sync.switchPlan.carry.length === 1 ? "mate" : `${sync.switchPlan.carry.length} mates`} you connected here (
              {sync.switchPlan.carry.map((c) => c.name).join(", ")}) will be asked to connect with your account again. Their history with you is kept.
            </p>
            <div className="grid gap-2 mt-4">
              <button
                disabled={busy}
                onClick={async () => {
                  setBusy(true)
                  const problem = await sync.confirmSwitch()
                  setBusy(false)
                  if (problem) setError(problem)
                  else onToast("Signed in. Your mates have been asked to reconnect.")
                }}
                className={primaryButton}
              >
                {busy ? "Switching…" : "Switch and reconnect"}
              </button>
              <button disabled={busy} onClick={sync.cancelSwitch} className={tintButton}>
                Cancel
              </button>
            </div>
            {error && <p className="text-[13px] text-bad mt-2 leading-snug">{error}</p>}
          </div>
        </section>
      ) : sync.account ? (
        <>
          <section>
            <h3 className={label}>Account</h3>
            <div className={`${card} flex items-start gap-3`}>
              <span className="w-14 h-14 rounded-full bg-card border border-ink/10 text-mute grid place-items-center overflow-hidden shrink-0">
                {avatarUrl ? <img src={avatarUrl} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover" onError={() => setAvatarUrl(null)} /> : <UserCircle weight="regular" className="w-10 h-10" />}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[16px] font-semibold leading-snug truncate">{profileName || sync.account.name || "Your account"}</span>
                <span className="block text-[13px] text-mute leading-snug truncate">{sync.account.email}</span>
                <span className="block text-[12px] text-mute leading-snug mt-1">
                  {sync.lastAt ? `Last synced ${new Date(sync.lastAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}` : "Not synced yet"}
                </span>
                <button type="button" onClick={() => { setNameDraft(profileName); setNameError(""); setEditingName((v) => !v) }} className="mt-2 inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink">
                  <PencilSimple size={14} /> {editingName ? "Cancel name change" : "Change display name"}
                </button>
              </span>
              <span className={`text-[11px] font-semibold rounded-full px-2 py-1 ${STATUS[sync.status].cls}`}>
                {sync.status === "offline" && sync.pending ? "Saved here" : sync.status === "synced" && sync.realtime ? "Live" : STATUS[sync.status].text}
              </span>
            </div>
            {editingName && (
              <div className={`${card} mt-2 space-y-2`}>
                <label htmlFor="account-display-name" className="block text-[12px] font-semibold text-mute">Display name</label>
                <input id="account-display-name" value={nameDraft} maxLength={40} onChange={(e) => { setNameDraft(e.target.value); setNameError("") }} autoComplete="nickname" className={inputClass} placeholder="Your name" />
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-mute">{Math.max(0, NAME_CHANGE_LIMIT - nameChangesUsed)} name changes left this month</span>
                  <span className="text-[11px] text-mute">{nameDraft.length}/40</span>
                </div>
                {nameError && <p role="alert" className="text-[12px] text-bad">{nameError}</p>}
                <button type="button" disabled={busy || !nameDraft.trim()} onClick={() => void saveProfileName()} className={`${primaryButton} disabled:opacity-50`}>
                  {busy ? "Saving…" : "Save name"}
                </button>
              </div>
            )}
            {sync.status === "needs-choice" && sync.reconcile && (
              <div className={`${card} mt-2`} data-testid="reconcile-waiting">
                <p className="text-[15px] font-semibold leading-snug">Choose how to combine your data</p>
                <p className="text-[13px] text-mute mt-1 leading-snug">
                  This device and your account both have data. Nothing is synced until you choose, and nothing has been changed.
                </p>
                <button onClick={sync.reopenReconcile} className={`${primaryButton} mt-3`}>
                  Choose
                </button>
              </div>
            )}
            {sync.status === "too-large" && (
              <p className="text-[13px] text-bad font-medium mt-2 px-1 leading-snug">Cloud backup is too large. Your data is safe on this device.</p>
            )}
            <button
              onClick={async () => {
                if (sync.status === "needs-choice" && sync.reconcile) {
                  sync.reopenReconcile()
                  return
                }
                onToast((await sync.syncNow()) ? "Updated from your other browser" : "Everything is up to date")
              }}
              className={`${tintButton} w-full mt-2`}
            >
              {sync.status === "needs-choice" ? "Choose how to sync" : "Sync now"}
            </button>
            <p className="text-[13px] text-mute mt-3 px-1 leading-snug">
              Sign in with this same account in any other browser and your subjects, marks and deadlines appear there. If both browsers changed things, the changes are combined, never one thrown away. A scanned QR code then marks
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
                    className="h-12 rounded-xl bg-bad text-white text-[15px] font-bold flex items-center justify-center gap-2 shadow-sm hover:opacity-90"
                  >
                    Sign out
                  </button>
                </div>
              </div>
            ) : (
              <button type="button" onClick={() => setConfirmOut(true)} className="w-full h-12 rounded-xl border border-bad/25 bg-bad/10 text-bad px-4 font-semibold flex items-center justify-center gap-2 hover:bg-bad/15">
                Sign out of this browser
              </button>
            )}
          </section>
        </>
      ) : (
        <section>
          <h3 className={label}>Your account</h3>
          <div className={card}>
            <div className="flex items-center gap-3 mb-3">
              <span className="w-14 h-14 rounded-full bg-card border border-ink/10 text-mute grid place-items-center overflow-hidden shrink-0">
                <UserCircle weight="regular" className="w-10 h-10" />
              </span>
              <span className="min-w-0">
                <span className="block text-[15px] font-semibold">Your College Tracker account</span>
                <span className="block text-[12px] text-mute mt-0.5">Sign in with Google to sync across browsers.</span>
              </span>
            </div>
            <div className="rounded-xl bg-warn/10 p-3 mb-3">
              <p className="text-[13px] font-semibold">Not backed up until you sign in and sync</p>
              <p className="text-[12px] text-mute leading-snug mt-1">Your data is stored in this browser’s local database for now. Clearing site data, deleting/resetting the browser profile, private browsing, or losing the device can make that local copy unavailable. After signing in, wait for “Up to date” and keep a separate export for important records.</p>
            </div>
            <p className="text-[13px] text-mute leading-snug">
              Sign in once in each browser you use (Safari, the home-screen app, Chrome). Your subjects, marks and deadlines are saved to your account
              and appear everywhere you sign in. The same Google account also unlocks Mates and direct in-app Pings.
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
            {error && <p className="text-[13px] text-bad mt-2 leading-snug" role="alert">{error}</p>}
            {/(closed before|cancelled|popup|window closed|didn.t work)/i.test(error) && (
              <button disabled={busy || redirectBusy} onClick={() => void signInRedirect()} className={`${tintButton} w-full mt-2 flex items-center justify-center gap-2 disabled:opacity-50`}>
                {redirectBusy && <SpinnerGap className="h-4 w-4 animate-spin" />}
                {redirectBusy ? "Opening Google sign-in…" : "Try full-page Google sign-in"}
              </button>
            )}
            <p className="text-[12px] text-mute mt-3 leading-snug">
              If Safari closes the sign-in window, retry here or use full-page Google sign-in. The friend link is preserved until sign-in finishes.
            </p>
          </div>
        </section>
      )}
    </div>
  )
}
