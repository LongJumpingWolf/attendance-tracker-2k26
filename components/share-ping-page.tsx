"use client"

import { useEffect, useMemo, useState } from "react"
import { CheckCircle, XCircle, ShieldCheck, ClockCountdown, SpinnerGap } from "@phosphor-icons/react"
import { doc, getDoc, serverTimestamp, updateDoc } from "firebase/firestore"
import { db } from "@/lib/firebase"
import { recordProductLinkEvent } from "@/lib/link-analytics"

type SharedItem = { key: string; name: string; t?: string; answer: "yes" | "no" | null }
type PublicPing = {
  id: string
  ownerUid: string
  status: "asking" | "answered" | "processed" | "cancelled" | "expired"
  fromName: string
  toName: string
  date: string
  expiresAt: number
  items: SharedItem[]
}

function niceDate(date: string) {
  const d = new Date(`${date}T00:00:00`)
  return Number.isNaN(d.getTime()) ? date : d.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })
}
function niceTime(t?: string) {
  if (!t) return ""
  const [h, m] = t.split(":").map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`
}

export default function SharePingPage({ pingId }: { pingId: string }) {
  const [ping, setPing] = useState<PublicPing | null>(null)
  const [answers, setAnswers] = useState<Record<string, "yes" | "no">>({})
  const [loading, setLoading] = useState(true)
  const [sending, setSending] = useState(false)
  const [error, setError] = useState("")
  const [done, setDone] = useState(false)

  useEffect(() => {
    let active = true
    setLoading(true)
    setError("")
    if (!/^[a-f0-9]{64}$/.test(pingId)) {
      setLoading(false)
      setError("This Ping link is invalid. Ask the sender to create a new one.")
      return
    }
    getDoc(doc(db, "sharePings", pingId)).then((snapshot) => {
      if (!active) return
      if (!snapshot.exists()) {
        setError("This Ping link is invalid, has expired, or was removed by the sender.")
        return
      }
      const raw = snapshot.data()
      const expiresAt = raw.expiresAt && typeof raw.expiresAt.toMillis === "function" ? raw.expiresAt.toMillis() : 0
      const status = raw.status as PublicPing["status"]
      const next: PublicPing = {
        id: snapshot.id,
        ownerUid: typeof raw.ownerUid === "string" ? raw.ownerUid : "",
        status: status === "asking" && (!expiresAt || expiresAt <= Date.now()) ? "expired" : status,
        fromName: typeof raw.fromName === "string" ? raw.fromName : "Someone",
        toName: typeof raw.recipientName === "string" ? raw.recipientName : "",
        date: typeof raw.date === "string" ? raw.date : "",
        expiresAt,
        items: Array.isArray(raw.items) ? raw.items.map((item: Record<string, unknown>) => ({
          key: typeof item.key === "string" ? item.key : "",
          name: typeof item.name === "string" ? item.name : "Class",
          ...(typeof item.t === "string" ? { t: item.t } : {}),
          answer: item.answer === "yes" || item.answer === "no" ? item.answer : null,
        })) : [],
      }
      setPing(next)
      if (next.ownerUid) {
        let shouldRecord = true
        try {
          const key = `attendance-share-ping-opened:${pingId}`
          if (sessionStorage.getItem(key)) shouldRecord = false
          else sessionStorage.setItem(key, "1")
        } catch { /* approximate open counts; analytics is best-effort */ }
        if (shouldRecord) void recordProductLinkEvent({ source: "share-ping", linkId: pingId, kind: "opened", ownerUid: next.ownerUid, fromName: next.fromName, recipientName: next.toName })
      }
      if (next.status === "expired") setError("This Ping link has expired. Ask the sender to share a new link.")
    }).catch((e: unknown) => {
      if (!active) return
      const message = e instanceof Error ? e.message : "This Ping link is invalid or has expired."
      setError(message.toLowerCase().includes("permission") ? "This Ping link is invalid or has expired." : "We couldn't load this Ping. Check your connection and reopen the link.")
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [pingId])

  const complete = useMemo(() => !!ping && ping.items.length > 0 && ping.items.every((item) => answers[item.key] === "yes" || answers[item.key] === "no"), [ping, answers])

  const submit = async () => {
    if (!ping || !complete || sending) return
    setSending(true)
    setError("")
    try {
      if (!/^[a-f0-9]{64}$/.test(pingId)) throw new Error("This Ping link is invalid.")
      if (!ping || ping.status !== "asking" || !ping.items.length) throw new Error("This Ping can no longer be answered.")
      if (ping.expiresAt <= Date.now()) throw new Error("This Ping has expired. Ask for a new link.")
      const ref = doc(db, "sharePings", pingId)
      const fresh = await getDoc(ref)
      if (!fresh.exists() || fresh.data().status !== "asking") {
        setDone(fresh.exists() && ["answered", "processed"].includes(String(fresh.data().status)))
        if (fresh.exists() && ["answered", "processed"].includes(String(fresh.data().status))) return
        throw new Error("This Ping can no longer be answered.")
      }
      const items = Array.isArray(fresh.data().items) ? fresh.data().items : []
      if (items.length !== ping.items.length || items.some((item: { key?: string }) => !Object.prototype.hasOwnProperty.call(answers, item.key ?? ""))) throw new Error("The class list changed. Reload the link before answering.")
      await updateDoc(ref, {
        items: items.map((item: Record<string, unknown>) => ({ ...item, answer: answers[String(item.key)] })),
        status: "answered",
        respondedAt: serverTimestamp(),
      })
      void recordProductLinkEvent({ source: "share-ping", linkId: pingId, kind: "answered", ownerUid: ping.ownerUid, fromName: ping.fromName, recipientName: ping.toName })
      setDone(true)
    } catch (e) {
      // A second responder can race this write. If the one-time answer already landed, treat it as completed.
      try {
        const fresh = await getDoc(doc(db, "sharePings", pingId))
        if (fresh.exists() && ["answered", "processed"].includes(String(fresh.data().status))) {
          setDone(true)
          return
        }
      } catch { /* keep the original message below */ }
      const message = e instanceof Error ? e.message : "Your response wasn't saved. Please try again."
      setError(message.toLowerCase().includes("permission") ? "Your answer couldn't be saved. This link may have expired or already been answered." : message)
    } finally {
      setSending(false)
    }
  }

  const alreadyAnswered = ping?.status === "answered" || ping?.status === "processed"
  const unavailable = ping?.status === "cancelled" || ping?.status === "expired"

  return (
    <main className="min-h-[100dvh] bg-paper text-ink flex items-center justify-center px-4 py-6 sm:px-6">
      <div className="w-full max-w-xl">
        <div className="flex items-center justify-center gap-2 mb-5 text-[13px] font-semibold text-mute">
          <span className="w-7 h-7 rounded-lg bg-ink text-paper grid place-items-center font-black">A</span>
          Attendance Tracker · Secure Ping
        </div>
        <section className="rounded-[28px] bg-card border border-ink/[0.06] shadow-sm overflow-hidden">
          <div className="px-5 sm:px-7 pt-7 pb-5 text-center">
            <span className="mx-auto w-14 h-14 rounded-2xl bg-info/10 text-info grid place-items-center"><ShieldCheck weight="duotone" className="w-7 h-7" /></span>
            <h1 className="text-[26px] sm:text-[30px] font-bold tracking-tight mt-4 leading-tight">Attendance confirmation</h1>
            <p className="text-[15px] text-mute leading-relaxed mt-2">{ping ? `${ping.fromName} is asking whether you marked them present.` : "A person has shared a private attendance question with you."}</p>
          </div>

          {loading ? <div className="px-6 py-12 flex justify-center text-mute"><SpinnerGap className="w-7 h-7 animate-spin" /> <span className="ml-2">Loading secure Ping…</span></div> : error && !ping ? <div className="m-5 rounded-2xl bg-bad/10 text-bad p-4 text-[14px] leading-relaxed">{error}</div> : null}

          {ping && !loading && !unavailable && !alreadyAnswered && !done && (
            <div className="px-5 sm:px-7 pb-7">
              <div className="rounded-2xl bg-secondary p-3.5 flex items-start gap-3 mb-4">
                <ClockCountdown className="w-5 h-5 mt-0.5 text-mute flex-shrink-0" />
                <div><p className="text-[13px] font-semibold">Class date: {niceDate(ping.date)}</p><p className="text-[12px] text-mute mt-1">This one-time link expires {ping.expiresAt ? new Date(ping.expiresAt).toLocaleString() : "within 24 hours"}.</p></div>
              </div>
              <p className="text-[13px] font-semibold uppercase tracking-wider text-mute mb-2">Did you actually mark this person present?</p>
              <ul className="space-y-3">
                {ping.items.map((item) => (
                  <li key={item.key} className="rounded-2xl border border-ink/10 p-3.5 sm:p-4">
                    <p className="text-[16px] font-bold leading-snug">{item.name}</p>
                    {item.t && <p className="text-[13px] text-mute mt-0.5">{niceTime(item.t)}</p>}
                    <div className="grid grid-cols-2 gap-2 mt-3">
                      <button type="button" onClick={() => setAnswers((prev) => ({ ...prev, [item.key]: "yes" }))} aria-pressed={answers[item.key] === "yes"} className={`h-12 rounded-xl flex items-center justify-center gap-2 text-[15px] font-bold transition ${answers[item.key] === "yes" ? "bg-good text-white ring-2 ring-good/30" : "bg-good/10 text-good"}`}><CheckCircle weight="bold" className="w-5 h-5" />Yes, present</button>
                      <button type="button" onClick={() => setAnswers((prev) => ({ ...prev, [item.key]: "no" }))} aria-pressed={answers[item.key] === "no"} className={`h-12 rounded-xl flex items-center justify-center gap-2 text-[15px] font-bold transition ${answers[item.key] === "no" ? "bg-bad text-white ring-2 ring-bad/30" : "bg-bad/10 text-bad"}`}><XCircle weight="bold" className="w-5 h-5" />No</button>
                    </div>
                  </li>
                ))}
              </ul>
              <div className="rounded-2xl bg-secondary text-ink p-3.5 mt-4 text-[13px] leading-relaxed">Your response may update the sender&apos;s attendance record for the listed classes.</div>
              {error && <p role="alert" className="mt-3 text-[13px] text-bad">{error}</p>}
              <button disabled={!complete || sending} onClick={submit} className="w-full h-13 min-h-13 rounded-2xl bg-ink text-paper text-[16px] font-bold mt-5 disabled:opacity-40">{sending ? "Saving response…" : "Send my answer"}</button>
              <p className="text-[11px] text-mute leading-relaxed text-center mt-3">No account or Mates connection is required. This page only submits your Yes/No answers for this Ping.</p>
            </div>
          )}

          {ping && !loading && (done || alreadyAnswered) && (
            <div className="px-6 sm:px-8 pb-8 text-center"><span className="mx-auto w-16 h-16 rounded-full bg-good/15 text-good grid place-items-center"><CheckCircle weight="duotone" className="w-9 h-9" /></span><h2 className="text-[22px] font-bold mt-4">{done ? "Answer sent" : "Already answered"}</h2><p className="text-[14px] text-mute leading-relaxed mt-2">{done ? "Thanks. Your answer is safely saved. The sender&apos;s app will receive it and process it when connected." : "This Ping has already received a response. You don't need to answer again."}</p></div>
          )}
          {ping && !loading && unavailable && <div className="m-5 rounded-2xl bg-secondary p-4 text-[14px] leading-relaxed">{error || (ping.status === "cancelled" ? "The sender cancelled this Ping." : "This Ping is no longer available.")}</div>}
          <div className="border-t border-ink/[0.08] px-5 py-4 text-center space-y-2">
            <p className="text-[11px] text-mute leading-relaxed">Shared securely for one attendance question. The sender can see the result in their app. Anyone holding this private link can view and answer this Ping. Do not forward the link.</p>
            <p className="text-[10px] text-mute leading-relaxed">Privacy notice: link opens and submitted responses are counted for product improvement, alongside sender and recipient display names already attached to this link. No IP address, precise location, or device fingerprint is intentionally recorded.</p>
          </div>
        </section>
        <p className="text-center text-[11px] text-mute mt-4">If you weren&apos;t expecting this, you can close the page without responding.</p>
      </div>
    </main>
  )
}
