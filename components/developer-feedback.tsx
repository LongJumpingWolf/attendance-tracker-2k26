"use client"

import { useCallback, useEffect, useState } from "react"
import { getAuth, onAuthStateChanged } from "firebase/auth"
import Link from "next/link"
import { CheckCircle, ArrowClockwise, SignIn } from "@phosphor-icons/react"
import { app } from "@/lib/firebase"
import { confirmSwitch, signInWithGoogle } from "@/lib/account"
import { getAdminFeedback, replyToFeedback, type FeedbackRecord } from "@/lib/feedback"

const DEVELOPER_EMAIL = (process.env.NEXT_PUBLIC_DEVELOPER_EMAIL || "adityavw2006@gmail.com").toLowerCase()
const dateText = (value: FeedbackRecord["createdAt"]) => {
  if (value && typeof value === "object" && "toDate" in value && typeof value.toDate === "function") return value.toDate().toLocaleString()
  if (value instanceof Date) return value.toLocaleString()
  return "Just now"
}

export default function DeveloperFeedback() {
  const [user, setUser] = useState<ReturnType<typeof getAuth>['currentUser']>(null)
  const [rows, setRows] = useState<FeedbackRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [busyId, setBusyId] = useState<string | null>(null)
  const auth = getAuth(app)
  const isAdmin = Boolean(user && !user.isAnonymous && user.email?.toLowerCase() === DEVELOPER_EMAIL)
  const refresh = useCallback(async () => {
    if (!isAdmin) { setRows([]); setLoading(false); return }
    setLoading(true); setError("")
    try { setRows(await getAdminFeedback()) } catch (e) { setError(e instanceof Error ? e.message : "Could not load feedback. Check Firestore rules.") }
    finally { setLoading(false) }
  }, [isAdmin])
  useEffect(() => onAuthStateChanged(auth, setUser), [auth])
  useEffect(() => { const timer = window.setTimeout(() => { void refresh() }, 0); return () => window.clearTimeout(timer) }, [refresh])
  const signIn = async () => {
    const result = await signInWithGoogle()
    if (result.kind === "error") setError(result.message)
    if (result.kind === "confirm") { const problem = await confirmSwitch(result.plan); if (problem) setError(problem) }
  }
  const sendReply = async (row: FeedbackRecord, resolved: boolean) => {
    const reply = (drafts[row.id] ?? row.developerReply ?? "").trim()
    if (!reply) { setError("Write a short reply before sending it."); return }
    setBusyId(row.id); setError("")
    try { await replyToFeedback(row.id, reply, resolved); await refresh() }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save the reply. Check Firestore rules.") }
    finally { setBusyId(null) }
  }
  return <main className="min-h-screen bg-background text-foreground p-4 sm:p-8">
    <div className="max-w-4xl mx-auto space-y-5">
      <header className="flex items-center justify-between gap-3"><div><p className="text-xs uppercase tracking-widest text-mute">College Tracker</p><h1 className="text-3xl font-bold">Developer feedback</h1><p className="text-sm text-mute mt-1">Ratings, bug reports, replies and resolution status.</p></div><Link href="/" className="rounded-xl bg-secondary px-4 py-2 text-sm font-semibold">Open app</Link></header>
      {!user && <section className="rounded-2xl bg-card p-5 space-y-3"><p>Sign in with the developer’s Google account to review feedback.</p><button onClick={() => void signIn()} className="rounded-xl bg-ink text-paper px-4 py-3 font-semibold inline-flex items-center gap-2"><SignIn size={18}/> Sign in with Google</button></section>}
      {user && !isAdmin && <section className="rounded-2xl bg-card p-5"><h2 className="font-bold">No access</h2><p className="text-sm text-mute mt-1">This account is not configured as the developer account.</p></section>}
      {error && <p role="alert" className="rounded-xl bg-bad/10 text-bad p-3 text-sm">{error}</p>}
      {isAdmin && <><div className="flex items-center justify-between"><p className="text-sm text-mute">{rows.length} feedback entries</p><button onClick={() => void refresh()} className="rounded-xl bg-secondary px-3 py-2 text-sm font-semibold inline-flex items-center gap-2"><ArrowClockwise size={16}/> Refresh</button></div>
        {loading ? <p className="rounded-2xl bg-card p-6">Loading feedback…</p> : rows.length === 0 ? <p className="rounded-2xl bg-card p-6">No feedback yet.</p> : <div className="space-y-4">{rows.map(row => <article key={row.id} className="rounded-2xl bg-card p-4 sm:p-5 space-y-3">
          <div className="flex items-start justify-between gap-3"><div><p className="font-bold capitalize">{row.kind} {row.rating ? `· ${"★".repeat(row.rating)}${"☆".repeat(5-row.rating)}` : ""}</p><p className="text-xs text-mute mt-1">{dateText(row.createdAt)} · {row.userName || "Guest"}{row.userEmail ? ` · ${row.userEmail}` : ""}</p></div><span className={`text-xs font-semibold rounded-full px-2.5 py-1 ${row.status === "resolved" ? "bg-good/15 text-good" : row.status === "replied" ? "bg-ink/10" : "bg-amber-500/15"}`}>{row.status}</span></div>
          {row.message && <p className="whitespace-pre-wrap text-sm leading-relaxed">{row.message}</p>}
          {row.imageData && <a href={row.imageData} target="_blank" rel="noreferrer"><img src={row.imageData} alt="User attached screenshot" className="max-h-80 max-w-full rounded-xl border border-border object-contain" /></a>}
          <label className="block text-xs font-semibold text-mute" htmlFor={`reply-${row.id}`}>Developer reply</label><textarea id={`reply-${row.id}`} rows={3} maxLength={2000} value={drafts[row.id] ?? row.developerReply ?? ""} onChange={e => setDrafts(p => ({...p,[row.id]:e.target.value}))} className="w-full rounded-xl bg-secondary p-3 text-sm outline-none focus:ring-1 focus:ring-ink/40" placeholder="Reply with what you noted or fixed…" />
          <div className="flex flex-wrap gap-2"><button disabled={busyId === row.id} onClick={() => void sendReply(row, false)} className="rounded-xl bg-ink text-paper px-4 py-2 text-sm font-semibold disabled:opacity-50">{busyId === row.id ? "Saving…" : "Reply to user"}</button><button disabled={busyId === row.id} onClick={() => void sendReply(row, true)} className="rounded-xl bg-secondary px-4 py-2 text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"><CheckCircle size={17}/> Reply & resolve</button></div>
        </article>)}</div>}
      </>}
      <p className="text-xs text-mute leading-relaxed">This dashboard requires the matching Firebase Firestore rules. Never make the feedback collection readable or writable by arbitrary users beyond creating validated submissions.</p>
    </div>
  </main>
}
