"use client"

import { useEffect, useState } from "react"
import QRCode from "qrcode"
import { Check, X, Copy, ShareNetwork, CaretDown, Link as LinkIcon } from "@phosphor-icons/react"
import type { Mate, Ping, Subject } from "@/lib/types"
import { localDate } from "@/lib/attendance"
import { copyText } from "@/lib/clipboard"
import { PING_HISTORY_DAYS, daysSince, isExpired, whenLabel } from "@/lib/pings"
import PingSheet from "./ping-sheet"
import type { SocialApi } from "@/lib/use-social"
import Sheet, { Field, inputClass, primaryButton, SectionHeader, tintButton } from "./sheet"

interface MatesViewProps {
  mates: Mate[]
  social: SocialApi
  addOpen: boolean
  onCloseAdd: () => void
  onAdd: (name: string) => void
  onFavour: (id: string) => void
  onRepay: (id: string) => void
  onRemove: (id: string) => void
  /** Your subjects, so a ping can name the exact classes you were away for */
  subjects: Subject[]
  /** Open the month-end wrapped story */
  onOpenWrapped: () => void
  onToast: (message: string) => void
}

const TINTS = ["bg-ink/10 text-ink"]
const chip = "h-8 px-3 rounded-full whitespace-nowrap bg-secondary text-[13px] font-semibold disabled:opacity-35"
const card = "rounded-2xl bg-card"

function Avatar({ name, i = 0, size = 48 }: { name: string; i?: number; size?: number }) {
  return (
    <span
      className={`rounded-full grid place-items-center font-bold flex-shrink-0 ${TINTS[i % TINTS.length]}`}
      style={{ width: size, height: size, fontSize: size * 0.4 }}
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  )
}

async function shareOrCopy(text: string, url: string, onToast: (m: string) => void) {
  try {
    if (navigator.share) {
      await navigator.share({ text, url })
      return
    }
  } catch {
    return // the share sheet was dismissed
  }
  onToast((await copyText(url)) ? "Link copied" : "Couldn't copy the link")
}

/* ---------- connect: QR + links ---------- */

function ConnectCard({ social, onToast }: { social: SocialApi; onToast: (m: string) => void }) {
  const [qr, setQr] = useState("")
  const [nameDraft, setNameDraft] = useState("")
  const [invite, setInvite] = useState<{ link: string; expiresAt: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(Date.now())

  useEffect(() => {
    if (!social.addLink) return
    QRCode.toDataURL(social.addLink, { margin: 1, width: 480, color: { dark: "#000000", light: "#ffffff" } })
      .then(setQr)
      .catch(() => setQr(""))
  }, [social.addLink])

  useEffect(() => {
    if (!invite) return
    const t = setInterval(() => setTick(Date.now()), 1000)
    return () => clearInterval(t)
  }, [invite])

  if (!social.configured) {
    return (
      <div className={`${card} p-5`}>
        <p className="text-[17px] font-semibold">Friend connections are off</p>
        <p className="text-[15px] text-mute mt-1.5 leading-snug">
          Your QR code, share links and request inbox run on a free Firebase project. Add its keys to{" "}
          <span className="text-ink">.env.local</span> (see <span className="text-ink">.env.local.example</span>),
          turn on Anonymous sign-in, and deploy the rules. Everything else in the app keeps working without it.
        </p>
      </div>
    )
  }

  if (social.status === "error") {
    return (
      <div className={`${card} p-5`}>
        <p className="text-[17px] font-semibold text-bad">Couldn&rsquo;t connect</p>
        <p className="text-[15px] text-mute mt-1.5 leading-snug">{social.error}</p>
        <button onClick={social.enable} className="mt-3 h-10 px-4 rounded-xl bg-secondary text-[15px] font-semibold">
          Try again
        </button>
      </div>
    )
  }

  if (social.status !== "ready") {
    return (
      <div className={`${card} p-5`}>
        <p className="text-[15px] text-mute">Setting up your account…</p>
      </div>
    )
  }

  if (!social.name) {
    return (
      <form
        className={`${card} p-5`}
        onSubmit={(e) => {
          e.preventDefault()
          if (nameDraft.trim()) social.setName(nameDraft)
        }}
      >
        <p className="text-[17px] font-semibold">What should friends call you?</p>
        <p className="text-[15px] text-mute mt-1 mb-3 leading-snug">
          Your name is shown on your QR code and in requests. Nothing else about you is shared.
        </p>
        <input autoFocus value={nameDraft} onChange={(e) => setNameDraft(e.target.value)} placeholder="Your name" className={inputClass} />
        <button type="submit" className={`${primaryButton} mt-3`}>
          Continue
        </button>
      </form>
    )
  }

  const left = invite ? Math.max(0, Math.round((invite.expiresAt - tick) / 1000)) : 0
  const expired = invite !== null && left === 0

  const generate = async () => {
    setBusy(true)
    try {
      const made = await social.makeInvite()
      if (made) setInvite(made)
    } catch {
      onToast("Couldn't create a link. Try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={`${card} p-5`}>
      <p className="text-[13px] text-mute">Sharing as {social.name}</p>
      <p className="text-[22px] font-bold tracking-tight leading-tight mt-0.5">Add friends</p>
      <p className="text-[15px] text-mute mt-1 leading-snug">
        Friends scan this code with their camera, or open a link. You&rsquo;ll get their request in your inbox.
      </p>

      <div className="mx-auto mt-4 w-[208px] h-[208px] rounded-2xl bg-[#ffffff] p-3 grid place-items-center">
        {qr ? <img src={qr} alt="Your QR code" width={184} height={184} className="w-full h-full" /> : <span className="text-black/40 text-sm">…</span>}
      </div>
      <p className="text-[12px] text-mute text-center mt-2">This code is permanent. It never changes.</p>

      <div className="grid grid-cols-2 gap-2.5 mt-4">
        <button
          onClick={() => shareOrCopy(`Add me as a proxy-mate, I'm ${social.name}.`, social.addLink, onToast)}
          className="h-11 rounded-xl bg-ink text-paper text-[15px] font-semibold flex items-center justify-center gap-2"
        >
          <ShareNetwork weight="bold" className="w-4 h-4" /> Share link
        </button>
        <button
          onClick={generate}
          disabled={busy}
          className="h-11 rounded-xl bg-secondary text-[15px] font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
        >
          <LinkIcon weight="bold" className="w-4 h-4" /> Magic link
        </button>
      </div>

      {invite && (
        <div className="mt-3 rounded-2xl bg-secondary p-3.5">
          <div className="flex items-center justify-between">
            <span className="text-[13px] text-mute">{expired ? "Expired" : "Expires in"}</span>
            <span className={`num text-[15px] font-semibold ${expired ? "text-bad" : ""}`}>
              {expired ? "0:00" : `${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}`}
            </span>
          </div>
          <p className="text-[13px] text-mute mt-1.5 break-all leading-snug line-clamp-2">{invite.link}</p>
          <div className="flex gap-2 mt-3">
            <button
              onClick={async () => {
                onToast((await copyText(invite.link)) ? "Magic link copied" : "Couldn't copy the link. Select it and copy by hand.")
              }}
              disabled={expired}
              className="h-9 px-3 rounded-lg bg-ink/10 text-[13px] font-semibold flex items-center gap-1.5 disabled:opacity-40"
            >
              <Copy weight="bold" className="w-4 h-4" /> Copy
            </button>
            <button
              onClick={() => shareOrCopy(`Join me as a proxy-mate (link valid for a few minutes).`, invite.link, onToast)}
              disabled={expired}
              className="h-9 px-3 rounded-lg bg-ink/10 text-[13px] font-semibold flex items-center gap-1.5 disabled:opacity-40"
            >
              <ShareNetwork weight="bold" className="w-4 h-4" /> Share
            </button>
            <button onClick={generate} className="h-9 px-3 rounded-lg text-[13px] font-semibold text-info ml-auto">
              New link
            </button>
          </div>
        </div>
      )}
      <p className="text-[12px] text-mute mt-3 leading-snug">
        A magic link works for 15 minutes, then stops. Use it for one-off invites you don&rsquo;t want floating around.
      </p>
    </div>
  )
}

/* ---------- a mate asking "did you mark me present?" ---------- */

function dateLabel(date: string) {
  const today = localDate()
  const yesterday = localDate(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 1))
  if (date === today) return "today"
  if (date === yesterday) return "yesterday"
  return new Date(`${date}T00:00:00`).toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "short" })
}

const timeLabel = (t?: string) => {
  if (!t) return ""
  const [h, m] = t.split(":").map(Number)
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h >= 12 ? "PM" : "AM"}`
}

function PingCard({ ping, index, onSend }: { ping: Ping; index: number; onSend: (answers: Record<string, "yes" | "no">) => Promise<void> }) {
  const [ans, setAns] = useState<Record<string, "yes" | "no">>({})
  const [busy, setBusy] = useState(false)
  const complete = ping.items.every((i) => ans[i.key])
  const set = (key: string, v: "yes" | "no") => setAns((a) => ({ ...a, [key]: v }))
  return (
    <li className="px-4 py-4">
      <div className="flex items-center gap-3.5">
        <Avatar name={ping.fromName} i={index} />
        <div className="min-w-0 flex-1">
          <p className="text-[17px] font-semibold leading-snug">{ping.fromName} is asking</p>
          <p className="text-[13px] text-mute leading-snug">Did you mark them present {dateLabel(ping.date)}?</p>
        </div>
      </div>
      <ul className="mt-3.5 space-y-2">
        {ping.items.map((i) => (
          <li key={i.key} className="flex items-center gap-3 rounded-2xl bg-secondary px-3.5 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block text-[15px] font-semibold leading-snug truncate">{i.name}</span>
              {i.t && <span className="block text-[12px] text-mute num">{timeLabel(i.t)}</span>}
            </span>
            <span className="flex gap-1.5 flex-shrink-0">
              <button
                onClick={() => set(i.key, "no")}
                aria-pressed={ans[i.key] === "no"}
                className={`h-9 px-3.5 rounded-full text-[14px] font-semibold transition ${ans[i.key] === "no" ? "bg-bad text-paper" : "bg-card text-mute"}`}
              >
                No
              </button>
              <button
                onClick={() => set(i.key, "yes")}
                aria-pressed={ans[i.key] === "yes"}
                className={`h-9 px-3.5 rounded-full text-[14px] font-semibold transition ${ans[i.key] === "yes" ? "bg-good text-paper" : "bg-card text-mute"}`}
              >
                Yes
              </button>
            </span>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-3 mt-3.5">
        {ping.items.length > 1 && (
          <button
            onClick={() => setAns(Object.fromEntries(ping.items.map((i) => [i.key, "yes" as const])))}
            className="text-[14px] font-medium text-mute"
          >
            Yes to all
          </button>
        )}
        <button
          disabled={!complete || busy}
          onClick={async () => {
            setBusy(true)
            await onSend(ans).catch(() => {})
            setBusy(false)
          }}
          className="ml-auto h-11 px-6 rounded-xl bg-ink text-paper text-[15px] font-semibold disabled:opacity-40"
        >
          {busy ? "Sending…" : "Send answer"}
        </button>
      </div>
    </li>
  )
}

/** What a ping's answers say, in a few words */
function outcome(p: Ping) {
  const names = (list: Ping["items"]) => list.map((i) => i.name).join(", ")
  const yes = p.items.filter((i) => i.answer === "yes")
  const no = p.items.filter((i) => i.answer === "no")
  if (no.length === 0) return { tone: "yes" as const, text: `Covered you · ${names(yes)}` }
  if (yes.length === 0) return { tone: "no" as const, text: `Didn't cover · ${names(no)}` }
  return { tone: "mixed" as const, text: `Covered ${names(yes)} · not ${names(no)}` }
}

/** The latest ping you sent to this mate (within the last 3 days) as a one-line status */
function pingStatus(sent: Ping[], m: Mate) {
  const cutoff = localDate(new Date(new Date().getFullYear(), new Date().getMonth(), new Date().getDate() - 3))
  const mine = sent.filter((p) => p.date >= cutoff && ((m.uid && p.to === m.uid) || p.toName.trim().toLowerCase() === m.name.trim().toLowerCase()))
  const latest = mine.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))[0]
  if (!latest) return null
  const names = latest.items.map((i) => i.name).join(", ")
  if (latest.status === "asking") {
    if (isExpired(latest)) return { id: latest.id, tone: "expired" as const, text: `No reply from ${m.name} · ${names}`, cancel: false }
    return { id: latest.id, tone: "wait" as const, text: `Waiting for ${m.name} · ${names}`, cancel: true }
  }
  return { id: latest.id, ...outcome(latest), cancel: false }
}

/** Everything you asked or answered in the last month, newest first */
function PingHistory({ sent, received, onClear }: { sent: Ping[]; received: Ping[]; onClear: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  type Row = { id: string; date: string; text: string; tone: "yes" | "no" | "mute"; sentByMe: boolean }
  const rows: Row[] = [
    ...sent
      .filter((p) => daysSince(p.date) <= PING_HISTORY_DAYS)
      .map((p): Row => {
        const names = p.items.map((i) => i.name).join(", ")
        if (p.status === "asking") return { id: p.id, date: p.date, tone: "mute", text: isExpired(p) ? `${p.toName} didn't reply · ${names}` : `Waiting for ${p.toName} · ${names}`, sentByMe: true }
        const o = outcome(p)
        return { id: p.id, date: p.date, tone: o.tone === "yes" ? "yes" : o.tone === "no" ? "no" : "mute", text: `${p.toName}: ${o.text.toLowerCase()}`, sentByMe: true }
      }),
    ...received
      .filter((p) => p.status === "answered" && daysSince(p.date) <= PING_HISTORY_DAYS)
      .map((p): Row => {
        const yes = p.items.filter((i) => i.answer === "yes").map((i) => i.name)
        const no = p.items.filter((i) => i.answer === "no").map((i) => i.name)
        return { id: p.id, date: p.date, tone: "mute", text: `You told ${p.fromName}: ${[yes.length ? `yes to ${yes.join(", ")}` : "", no.length ? `no to ${no.join(", ")}` : ""].filter(Boolean).join(" · ")}`, sentByMe: false }
      }),
  ]
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0))
    .slice(0, 25)

  if (rows.length === 0) return null
  return (
    <section>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="w-full flex items-center justify-between px-1 mb-2.5">
        <span className="text-[12px] font-medium uppercase tracking-wider text-mute">Ping history</span>
        <span className="flex items-center gap-1.5 text-[12px] text-mute num">
          {rows.length}
          <CaretDown weight="bold" className={`w-3.5 h-3.5 transition-transform ${open ? "rotate-180" : ""}`} />
        </span>
      </button>
      {open && (
        <ul className="rounded-2xl bg-card overflow-hidden divide-y divide-ink/[0.08]">
          {rows.map((r) => (
            <li key={r.id} className="flex items-start gap-3 px-4 py-3">
              <span className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${r.tone === "yes" ? "bg-good" : r.tone === "no" ? "bg-bad" : "bg-ink/30"}`} />
              <span className="min-w-0 flex-1 text-[14px] leading-snug">{r.text}</span>
              <span className="text-[12px] text-mute whitespace-nowrap mt-0.5">{whenLabel(r.date)}</span>
              {r.sentByMe && (
                <button onClick={() => onClear(r.id)} aria-label="Remove from history" className="text-mute hover:text-bad mt-0.5">
                  <X weight="bold" className="w-3.5 h-3.5" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/* ---------- main view ---------- */

export default function MatesView({ mates, social, subjects, addOpen, onCloseAdd, onAdd, onFavour, onRepay, onRemove, onOpenWrapped, onToast }: MatesViewProps) {
  const [name, setName] = useState("")
  // Removing a mate wipes their favour history (and ends a connection), so it needs a second tap
  const [removing, setRemoving] = useState<Mate | null>(null)
  // The mate you are about to ping
  const [pinging, setPinging] = useState<Mate | null>(null)

  const owed = (m: Mate) => Math.max(0, m.covered - m.repaid)
  const ranked = [...mates].sort((a, b) => owed(b) - owed(a) || b.covered - a.covered || a.name.localeCompare(b.name))
  const totalOwed = mates.reduce((n, m) => n + owed(m), 0)

  const now = new Date()
  const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate()

  const me = social.uid
  const incoming = social.requests.filter((r) => r.status === "pending" && r.to === me)
  const outgoing = social.requests.filter((r) => r.status === "pending" && r.from === me)
  const toAnswer = social.received.filter((p) => p.status === "asking" && !isExpired(p))

  const submit = (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    onAdd(name.trim())
    setName("")
    onCloseAdd()
  }

  return (
    <div className="space-y-7 lg:space-y-0 lg:columns-2 lg:gap-x-10 lg:[&>*]:break-inside-avoid lg:[&>*]:mb-7">
      {/* Mates asking whether you marked them present */}
      {toAnswer.length > 0 && (
        <section>
          <SectionHeader>Mates are asking</SectionHeader>
          <ul className={`${card} overflow-hidden divide-y divide-ink/[0.08]`}>
            {toAnswer.map((p, i) => (
              <PingCard
                key={p.id}
                ping={p}
                index={i}
                onSend={(answers) => social.answerPing(p.id, answers).then(() => onToast(`Sent your answer to ${p.fromName}`))}
              />
            ))}
          </ul>
          <p className="text-[13px] text-mute px-1 mt-2 leading-snug">
            A yes marks that class present for them. Only say yes if you really did.
          </p>
        </section>
      )}

      {/* Inbox */}
      {incoming.length > 0 && (
        <section>
          <SectionHeader>Requests</SectionHeader>
          <ul className={`${card} overflow-hidden divide-y divide-ink/[0.08]`}>
            {incoming.map((r, i) => (
              <li key={r.id} className="flex items-center gap-3.5 px-4 py-3.5">
                <Avatar name={r.fromName} i={i} />
                <div className="min-w-0 flex-1">
                  <p className="text-[17px] font-semibold truncate leading-snug">{r.fromName}</p>
                  <p className="text-[13px] text-mute leading-snug">wants to be your proxy-mate</p>
                </div>
                <button
                  onClick={() => social.respond(r.id, "declined")}
                  aria-label={`Decline ${r.fromName}`}
                  className="w-10 h-10 rounded-full bg-bad/15 text-bad grid place-items-center"
                >
                  <X weight="bold" className="w-5 h-5" />
                </button>
                <button
                  onClick={() => social.respond(r.id, "accepted").then(() => onToast(`Connected with ${r.fromName}`))}
                  aria-label={`Accept ${r.fromName}`}
                  className="w-10 h-10 rounded-full bg-good text-paper grid place-items-center"
                >
                  <Check weight="bold" className="w-5 h-5" />
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Month-end */}
      <div className="rounded-2xl bg-card p-4" data-tour="mates-wrapped">
        <p className="text-[13px] text-mute">
          Month ends in {daysLeft} {daysLeft === 1 ? "day" : "days"}
        </p>
        <p className="text-[24px] font-bold tracking-tight leading-tight mt-1">
          {totalOwed > 0 ? `You owe ${totalOwed} ${totalOwed === 1 ? "favour" : "favours"}` : "All square"}
        </p>
        <p className="text-[15px] text-mute mt-1.5 leading-snug">
          {totalOwed > 0
            ? "Repay your mates before the month ends: a treat, a party, notes."
            : "Nobody has covered for you without being repaid."}
        </p>
        <button
          onClick={onOpenWrapped}
          className="mt-4 w-full h-12 rounded-xl text-[16px] font-bold text-[#ffffff] shadow-sm"
          style={{ background: "linear-gradient(120deg,#3730a3,#86198f)" }}
        >
          See your week wrapped
        </button>
      </div>

      {/* Leaderboard */}
      <section data-tour="mates-leaderboard">
        <SectionHeader>Leaderboard</SectionHeader>
        {mates.length === 0 ? (
          <div className={`${card} p-5`}>
            <p className="text-[17px] font-semibold">No proxy-mates yet</p>
            <p className="text-[15px] text-mute mt-1.5 leading-snug">
              A proxy-mate is a friend who marks you present when you can&rsquo;t make it. Connect with friends below, or add
              one by hand with the + button.
            </p>
          </div>
        ) : (
          <ul className={`${card} overflow-hidden divide-y divide-ink/[0.08]`}>
            {ranked.map((m, i) => (
              <li key={m.id} className="px-4 py-4">
                <div className="flex items-center gap-3.5">
                  <span className="grid place-items-center w-7 h-7 rounded-full bg-ink/10 text-[12px] font-bold text-ink">
                    #{i + 1}
                  </span>
                  <Avatar name={m.name} i={i} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[17px] font-semibold truncate leading-snug">
                      {m.name}
                      {m.uid && <span className="ml-2 align-middle text-[10px] font-bold tracking-wide text-mute bg-ink/10 rounded px-1.5 py-0.5">CONNECTED</span>}
                    </p>
                    <p className="text-[13px] text-mute">
                      <span className="whitespace-nowrap">Covered you {m.covered}×</span> · <span className="whitespace-nowrap">repaid {m.repaid}×</span>
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="num text-[28px] font-bold leading-none">{owed(m)}</p>
                    <p className="text-[11px] text-mute mt-1">you owe</p>
                  </div>
                </div>
                {(() => {
                  const st = pingStatus(social.sent, m)
                  if (!st) return null
                  return (
                    <p
                      className={`mt-3 flex items-center gap-2 text-[13px] font-medium leading-snug ${
                        st.tone === "yes" ? "text-good" : st.tone === "no" ? "text-bad" : "text-mute"
                      }`}
                    >
                      {st.tone === "wait" && <span className="ping-wait w-2 h-2 rounded-full bg-ink/60 flex-shrink-0" />}
                      <span className="min-w-0 flex-1 truncate">{st.text}</span>
                      {st.cancel && (
                        <button
                          onClick={() => social.cancelPing(st.id).then(() => onToast(`Cancelled your ping to ${m.name}`))}
                          className="text-mute font-semibold flex-shrink-0"
                        >
                          Cancel
                        </button>
                      )}
                    </p>
                  )
                })()}
                <div className="flex items-center gap-1.5 mt-3.5">
                  <button onClick={() => setPinging(m)} className={chip}>
                    Ping
                  </button>
                  {!m.uid && (
                    <button onClick={() => onFavour(m.id)} className={chip}>
                      Covered me
                    </button>
                  )}
                  {owed(m) > 0 && (
                    <button onClick={() => onRepay(m.id)} className={chip}>
                      Repaid
                    </button>
                  )}
                  <button onClick={() => setRemoving(m)} className="ml-auto text-[13px] text-mute hover:text-bad pl-1">
                    Remove
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <PingHistory sent={social.sent} received={social.received} onClear={(id) => void social.cancelPing(id)} />

      {/* Waiting for a reply */}
      {outgoing.length > 0 && (
        <section>
          <SectionHeader>Waiting for a reply</SectionHeader>
          <ul className={`${card} overflow-hidden divide-y divide-ink/[0.08]`}>
            {outgoing.map((r, i) => (
              <li key={r.id} className="flex items-center gap-3.5 px-4 py-3">
                <Avatar name={r.toName} i={i + 1} size={40} />
                <p className="flex-1 min-w-0 text-[15px] font-medium truncate">{r.toName}</p>
                <button onClick={() => social.cancel(r.id)} className="text-[13px] font-semibold text-mute">
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* QR + links */}
      <section>
        <SectionHeader>Connect with friends</SectionHeader>
        <ConnectCard social={social} onToast={onToast} />
      </section>

      <p className="text-[13px] text-mute px-1 leading-snug -mt-2">
        Ping a connected mate to ask if they marked you present in the classes you missed. Their yes marks the class
        present and adds a favour. For mates who aren&rsquo;t connected, Ping opens your share sheet and you tap
        &ldquo;Covered me&rdquo; yourself. The favour count is private to you.
      </p>

      <Sheet open={removing !== null} onClose={() => setRemoving(null)} title={removing ? `Remove ${removing.name}?` : "Remove mate"}>
        {removing && (
          <>
            <p className="text-[15px] text-mute leading-snug mb-5">
              This deletes your favour history with {removing.name} (covered you {removing.covered}× · repaid {removing.repaid}×)
              {removing.uid ? " and ends your connection with them" : ""}. You&rsquo;ll be able to undo it for a few seconds.
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setRemoving(null)} className={`${tintButton} h-[52px] text-[17px]`}>
                Keep mate
              </button>
              <button
                onClick={() => {
                  onRemove(removing.id)
                  setRemoving(null)
                }}
                className="h-[52px] rounded-2xl bg-bad text-paper text-[17px] font-semibold transition hover:opacity-90"
              >
                Remove
              </button>
            </div>
          </>
        )}
      </Sheet>

      <PingSheet
        open={pinging !== null}
        onClose={() => setPinging(null)}
        mate={pinging}
        subjects={subjects}
        waiting={pinging ? social.sent.filter((p) => p.status === "asking" && !isExpired(p) && (p.to === pinging.uid || p.toName === pinging.name)) : []}
        onAsk={(m, date, items) => social.sendPing({ uid: m.uid as string, name: m.name }, date, items)}
        onToast={onToast}
      />

      <Sheet open={addOpen} onClose={onCloseAdd} title="Add a mate">
        <form onSubmit={submit}>
          <Field label="Name">
            <input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Priya" className={inputClass} />
          </Field>
          <button type="submit" className={primaryButton}>
            Add mate
          </button>
        </form>
      </Sheet>
    </div>
  )
}
