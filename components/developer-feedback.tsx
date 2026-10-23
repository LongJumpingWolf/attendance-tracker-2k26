"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { getAuth, onAuthStateChanged } from "firebase/auth"
import Link from "next/link"
import { CheckCircle, ArrowClockwise, SignIn } from "@phosphor-icons/react"
import { app } from "@/lib/firebase"
import { confirmSwitch, signInWithGoogle } from "@/lib/account"
import { getAdminFeedback, replyToFeedback, type FeedbackKind, type FeedbackRecord } from "@/lib/feedback"

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
  const [kindFilter, setKindFilter] = useState<"all" | FeedbackKind>("all")
  const [replyFilter, setReplyFilter] = useState<"all" | "unreplied" | "replied" | "resolved">("all")
  const [search, setSearch] = useState("")
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
  const feedbackCounts = useMemo(() => ({
    total: rows.length,
    ratings: rows.filter((row) => row.kind === "rating").length,
    suggestions: rows.filter((row) => row.kind === "suggestion").length,
    bugs: rows.filter((row) => row.kind === "bug").length,
    unreplied: rows.filter((row) => !String(row.developerReply || "").trim()).length,
    replied: rows.filter((row) => Boolean(String(row.developerReply || "").trim())).length,
    resolved: rows.filter((row) => row.status === "resolved").length,
  }), [rows])

  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase()
    return rows.filter((row) => {
      if (kindFilter !== "all" && row.kind !== kindFilter) return false
      const hasReply = Boolean(String(row.developerReply || "").trim())
      if (replyFilter === "unreplied" && hasReply) return false
      if (replyFilter === "replied" && (!hasReply || row.status === "resolved")) return false
      if (replyFilter === "resolved" && row.status !== "resolved") return false
      if (!q) return true
      return [row.userName, row.userEmail, row.message, row.kind, row.status, row.developerReply, row.area]
        .some((value) => String(value || "").toLowerCase().includes(q))
    })
  }, [rows, kindFilter, replyFilter, search])

  const quickFilters: Array<{ label: string; count: number; active: boolean; onClick: () => void }> = [
    { label: "Ratings", count: feedbackCounts.ratings, active: kindFilter === "rating", onClick: () => setKindFilter(kindFilter === "rating" ? "all" : "rating") },
    { label: "Suggestions", count: feedbackCounts.suggestions, active: kindFilter === "suggestion", onClick: () => setKindFilter(kindFilter === "suggestion" ? "all" : "suggestion") },
    { label: "Bug reports", count: feedbackCounts.bugs, active: kindFilter === "bug", onClick: () => setKindFilter(kindFilter === "bug" ? "all" : "bug") },
    { label: "Unreplied", count: feedbackCounts.unreplied, active: replyFilter === "unreplied", onClick: () => setReplyFilter(replyFilter === "unreplied" ? "all" : "unreplied") },
  ]

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
      <header className="flex items-center justify-between gap-3"><div><p className="text-xs uppercase tracking-widest text-mute">College Tracker</p><h1 className="text-3xl font-bold">Developer feedback</h1><p className="text-sm text-mute mt-1">Ratings, bug reports, replies and resolution status.</p></div><div className="flex flex-wrap gap-2"><Link href="/developer-analytics" className="rounded-xl bg-ink text-paper px-4 py-2 text-sm font-semibold">Link analytics</Link><Link href="/" className="rounded-xl bg-secondary px-4 py-2 text-sm font-semibold">Open app</Link></div></header>
      {!user && <section className="rounded-2xl bg-card p-5 space-y-3"><p>Sign in with the developer’s Google account to review feedback.</p><button onClick={() => void signIn()} className="rounded-xl bg-ink text-paper px-4 py-3 font-semibold inline-flex items-center gap-2"><SignIn size={18}/> Sign in with Google</button></section>}
      {user && !isAdmin && <section className="rounded-2xl bg-card p-5"><h2 className="font-bold">No access</h2><p className="text-sm text-mute mt-1">This account is not configured as the developer account.</p></section>}
      {error && <p role="alert" className="rounded-xl bg-bad/10 text-bad p-3 text-sm">{error}</p>}
      {isAdmin && <><div className="flex items-center justify-between"><p className="text-sm text-mute">{filteredRows.length} shown · {rows.length} total feedback entries</p><button onClick={() => void refresh()} className="rounded-xl bg-secondary px-3 py-2 text-sm font-semibold inline-flex items-center gap-2"><ArrowClockwise size={16}/> Refresh</button></div>
        <section className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {quickFilters.map(({ label, count, active, onClick }) => <button key={label} type="button" onClick={onClick} aria-pressed={active} className={"rounded-2xl p-4 text-left border transition-colors " + (active ? "bg-ink text-paper border-ink" : "bg-card border-ink/10 hover:bg-secondary")}><p className={"text-xs " + (active ? "text-paper/70" : "text-mute")}>{label}</p><p className="text-2xl font-bold mt-1 tabular-nums">{count}</p></button>)}
        </section>
        <section className="rounded-2xl bg-card p-4 grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_auto_auto] gap-3">
          <label className="block min-w-0"><span className="text-xs font-semibold text-mute block mb-1.5">Search feedback</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search message, name, email, reply…" className="w-full min-h-11 rounded-xl bg-secondary px-3 text-sm outline-none focus:ring-1 focus:ring-ink/40"/></label>
          <label className="block"><span className="text-xs font-semibold text-mute block mb-1.5">Type</span><select value={kindFilter} onChange={(event) => setKindFilter(event.target.value as "all" | FeedbackKind)} className="min-h-11 w-full rounded-xl bg-secondary px-3 text-sm"><option value="all">All types</option><option value="rating">Ratings</option><option value="suggestion">Suggestions</option><option value="bug">Bugs</option></select></label>
          <label className="block"><span className="text-xs font-semibold text-mute block mb-1.5">Reply status</span><select value={replyFilter} onChange={(event) => setReplyFilter(event.target.value as "all" | "unreplied" | "replied" | "resolved")} className="min-h-11 w-full rounded-xl bg-secondary px-3 text-sm"><option value="all">All statuses</option><option value="unreplied">Unreplied</option><option value="replied">Replied · not resolved</option><option value="resolved">Resolved</option></select></label>
          {(kindFilter !== "all" || replyFilter !== "all" || search) && <button type="button" onClick={() => { setKindFilter("all"); setReplyFilter("all"); setSearch("") }} className="text-sm font-semibold underline underline-offset-4 justify-self-start">Clear filters</button>}
        </section>
        {loading ? <p className="rounded-2xl bg-card p-6">Loading feedback…</p> : rows.length === 0 ? <p className="rounded-2xl bg-card p-6">No feedback yet.</p> : filteredRows.length === 0 ? <p className="rounded-2xl bg-card p-6">No feedback matches these filters. Clear a filter or try another search.</p> : <div className="space-y-4">{filteredRows.map(row => <article key={row.id} className="rounded-2xl bg-card p-4 sm:p-5 space-y-3">
          <div className="flex items-start justify-between gap-3"><div><p className="font-bold capitalize">{row.kind} {row.rating ? `· ${"★".repeat(row.rating)}${"☆".repeat(5-row.rating)}` : ""}</p><p className="text-xs text-mute mt-1">{dateText(row.createdAt)} · {row.userName || "Guest"}{row.userEmail ? ` · ${row.userEmail}` : ""}</p></div><span className={`text-xs font-semibold rounded-full px-2.5 py-1 ${row.status === "resolved" ? "bg-good/15 text-good" : row.status === "replied" ? "bg-ink/10" : "bg-amber-500/15"}`}>{row.status}</span></div>
          {row.message && <p className="whitespace-pre-wrap text-sm leading-relaxed">{row.message}</p>}
          {row.kind === "bug" && <div className="rounded-xl bg-secondary p-3"><p className="text-xs font-bold uppercase tracking-wide text-mute mb-2">Bug questionnaire</p><dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 text-sm">{([["Device / OS", row.platform], ["Device type", row.deviceType], ["Browser", row.browser], ["App area", row.area], ["Frequency", row.frequency], ["Connection", row.network]] as const).filter(([, value]) => Boolean(value)).map(([label, value]) => <div key={label} className="flex gap-2 min-w-0"><dt className="text-mute shrink-0">{label}:</dt><dd className="break-words">{value}</dd></div>)}</dl></div>}
          {row.imageData && <a href={row.imageData} target="_blank" rel="noreferrer"><img src={row.imageData} alt="User attached screenshot" className="max-h-80 max-w-full rounded-xl border border-border object-contain" /></a>}
          <label className="block text-xs font-semibold text-mute" htmlFor={`reply-${row.id}`}>Developer reply</label><textarea id={`reply-${row.id}`} rows={3} maxLength={2000} value={drafts[row.id] ?? row.developerReply ?? ""} onChange={e => setDrafts(p => ({...p,[row.id]:e.target.value}))} className="w-full rounded-xl bg-secondary p-3 text-sm outline-none focus:ring-1 focus:ring-ink/40" placeholder="Reply with what you noted or fixed…" />
          <div className="flex flex-wrap gap-2"><button disabled={busyId === row.id} onClick={() => void sendReply(row, false)} className="rounded-xl bg-ink text-paper px-4 py-2 text-sm font-semibold disabled:opacity-50">{busyId === row.id ? "Saving…" : "Reply to user"}</button><button disabled={busyId === row.id} onClick={() => void sendReply(row, true)} className="rounded-xl bg-secondary px-4 py-2 text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"><CheckCircle size={17}/> Reply & resolve</button></div>
        </article>)}</div>}
      </>}
      <p className="text-xs text-mute leading-relaxed">This dashboard requires the matching Firebase Firestore rules. Never make the feedback collection readable or writable by arbitrary users beyond creating validated submissions.</p>
    </div>
  </main>
}
