"use client"

import { useEffect, useState } from "react"
import QRCode from "qrcode"
import { Check, X, Copy, ShareNetwork, CaretDown, Link as LinkIcon, ChatCircleDots, LockKey, SpinnerGap } from "@phosphor-icons/react"
import type { Mate, Ping, ScheduleOverride, Subject } from "@/lib/types"
import { localDate } from "@/lib/attendance"
import { shareableAppOrigin } from "@/lib/share-ping-link"
import { copyText } from "@/lib/clipboard"
import { PING_HISTORY_DAYS, daysSince, isAnswered, isExpired, whenLabel } from "@/lib/pings"
import { canSendInAppPing, canUseInAppPing } from "@/lib/ping-capabilities"
import { writeMateAlias } from "@/lib/mate-aliases"
import InfoTip from "./info-tip"
import PingSheet from "./ping-sheet"
import type { SocialApi } from "@/lib/use-social"
import Sheet, { Field, inputClass, primaryButton, SectionHeader, tintButton } from "./sheet"

interface MatesViewProps {
  mates: Mate[]
  social: SocialApi
  addOpen: boolean
  onCloseAdd: () => void
  onOpenAdd: () => void
  onRemove: (id: string) => void
  onSaveAlias: (mate: Mate, alias: string) => Promise<void> | void
  onSaveIntegrationPreference: (mate: Mate, enabled: boolean) => Promise<void>
  /** Your subjects, so a ping can name the exact classes you were away for */
  subjects: Subject[]
  scheduleOverrides?: ScheduleOverride[]
  /** Open the weekly recap, only exposed on Saturday from the Ping section. */
  onOpenWrapped: () => void
  showWrappedInPingSection?: boolean
  onToast: (message: string) => void
}

const TINTS = ["bg-ink/10 text-ink"]
const chip = "h-8 px-3 rounded-full whitespace-nowrap bg-secondary text-[13px] font-semibold disabled:opacity-35"
const card = "rounded-2xl bg-card"

const visibleMateName = (mate: Mate) =>
  mate.alias?.trim() ||
  (/^mate[-_ ]+[a-z0-9_-]{4,}$/i.test(mate.name.trim()) ? "Unnamed mate" : mate.name)

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
  if (navigator.share) {
    try {
      await navigator.share({ text, url })
      return
    } catch (error) {
      // User cancellation is normal. Other share failures should still fall back to copying the usable link.
      if (error instanceof Error && error.name === "AbortError") return
    }
  }
  onToast((await copyText(url)) ? "Sharing wasn't available; link copied instead" : "Couldn't share or copy the link. Select it and copy manually.")
}

/* ---------- connect: QR + links ---------- */

function ConnectCard({ social, onToast }: { social: SocialApi; onToast: (m: string) => void }) {
  const [qr, setQr] = useState("")
  const [qrError, setQrError] = useState(false)
  const [invite, setInvite] = useState<{ link: string; expiresAt: number } | null>(null)
  const [busy, setBusy] = useState(false)
  const [tick, setTick] = useState(Date.now())
  const [originChecked, setOriginChecked] = useState(false)
  const [originMessage, setOriginMessage] = useState("")
  const [waitingLong, setWaitingLong] = useState(false)

  // This component also initiates setup when opened, so an idle state cannot leave the card loading forever.
  useEffect(() => {
    if (!social.configured || social.status === "ready" || social.status === "error") {
      setWaitingLong(false)
      return
    }
    if (social.status === "idle" || social.status === "off") social.enable()
    const timer = window.setTimeout(() => setWaitingLong(true), 5000)
    return () => window.clearTimeout(timer)
  }, [social.configured, social.status, social.enable])

  useEffect(() => {
    const result = shareableAppOrigin(window.location.origin, process.env.NEXT_PUBLIC_APP_URL)
    setOriginMessage(result.ok ? "" : result.message)
    setOriginChecked(true)
  }, [])

  useEffect(() => {
    let current = true
    setQr("")
    setQrError(false)
    if (!social.addLink) return () => { current = false }
    QRCode.toDataURL(social.addLink, { margin: 1, width: 480, color: { dark: "#000000", light: "#ffffff" } })
      .then((url) => { if (current) setQr(url) })
      .catch(() => { if (current) { setQr(""); setQrError(true) } })
    return () => { current = false }
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
          turn on Anonymous sign-in, and deploy the rules. If you&apos;re testing on localhost, also set <span className="text-ink">NEXT_PUBLIC_APP_URL</span> to a deployed HTTPS preview running the same Firebase project; localhost links cannot open on another person&apos;s device. Everything else in the app keeps working without it.
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
      <div className={`${card} p-5`} role="status" aria-live="polite">
        <p className="text-[16px] font-semibold">{waitingLong ? "Still connecting to Firebase" : "Connecting to Firebase…"}</p>
        <p className="text-[13px] text-mute mt-1.5 leading-snug">
          {waitingLong
            ? "Local sign-in should finish within a few seconds. If it does not, check the Firebase project keys and local emulator settings; this screen will show the specific error when sign-in fails."
            : "Creating this browser's unique account. Public HTTPS is only needed for links opened on another device, not for sign-in on localhost."}
        </p>
        <button type="button" onClick={social.enable} className="mt-3 h-10 px-4 rounded-xl bg-secondary text-[14px] font-semibold">Retry connection</button>
      </div>
    )
  }


  const left = invite ? Math.max(0, Math.round((invite.expiresAt - tick) / 1000)) : 0
  const expired = invite !== null && left === 0

  const generate = async () => {
    if (!originChecked || originMessage) {
      onToast(originMessage || "Checking this website address. Try again in a moment.")
      return
    }
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
      <p className="text-[13px] text-mute">Your unique friend identity</p>
      <p className="text-[22px] font-bold tracking-tight leading-tight mt-0.5">Connect with friends</p>
      {social.uid && (
        <div className="mt-3 rounded-xl bg-secondary p-3">
          <p className="text-[11px] uppercase tracking-wider text-mute font-semibold">Unique account code</p>
          <p className="mt-1 text-[12px] font-mono break-all select-all" aria-label="Your unique account code">{social.uid}</p>
          <button
            type="button"
            onClick={async () => onToast((await copyText(social.uid as string)) ? "Unique code copied" : "Couldn't copy the code")}
            className="mt-2 h-9 px-3 rounded-lg bg-card text-[13px] font-semibold flex items-center gap-1.5"
          ><Copy weight="bold" className="w-4 h-4" /> Copy code</button>
        </div>
      )}
      <p className="text-[15px] text-mute mt-1 leading-snug">
        Friends scan this code, open your permanent link, or enter your unique account code. You’ll get their request in your inbox. The code identifies the account; display names are only labels.
      </p>

      {originMessage && (
        <div className="mt-3 rounded-2xl bg-warn/10 p-3.5 text-[13px] leading-relaxed" role="status">
          <b className="block mb-1">Configure the recipient-facing website URL</b>
          {originMessage} Set NEXT_PUBLIC_APP_URL to the deployed HTTPS app URL and restart the dev server to create working one-day Ping links while testing locally.
        </div>
      )}
      <div className="mx-auto mt-4 w-[208px] h-[208px] rounded-2xl bg-[#ffffff] p-3 grid place-items-center">
        {originMessage ? <div className="text-center px-3 text-black/70"><p className="text-sm font-semibold">Open the deployed site</p><p className="text-xs mt-1">QR links need a public website address.</p></div> : qr ? <img src={qr} alt="Your permanent friend-connection QR code" width={184} height={184} className="w-full h-full" /> : qrError ? <div className="text-center px-3 text-black/70"><p className="text-sm font-semibold">QR code unavailable</p><p className="text-xs mt-1">Use Share link below instead.</p></div> : <span className="text-black/40 text-sm">Preparing QR…</span>}
      </div>
      <p className="text-[12px] text-mute text-center mt-2">This code is permanent. It never changes.</p>

      <div className="grid grid-cols-2 gap-2.5 mt-4">
        <button
          onClick={() => originMessage ? onToast(originMessage) : void shareOrCopy(`Add me as a proxy-mate, I'm ${social.name}.`, social.addLink, onToast)}
          disabled={!originChecked || !!originMessage || !social.addLink}
          className="h-11 rounded-xl bg-ink text-paper text-[15px] font-semibold flex items-center justify-center gap-2 disabled:opacity-45"
        >
          <ShareNetwork weight="bold" className="w-4 h-4" /> Share link
        </button>
        <button
          onClick={generate}
          disabled={busy || !originChecked || !!originMessage}
          className="h-11 rounded-xl bg-secondary text-[15px] font-semibold flex items-center justify-center gap-2 disabled:opacity-50"
        >
          {busy ? <SpinnerGap weight="bold" className="w-4 h-4 animate-spin" /> : <LinkIcon weight="bold" className="w-4 h-4" />} {busy ? "Creating link…" : "Magic link"}
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
            <button onClick={generate} disabled={busy} className="h-9 px-3 rounded-lg text-[13px] font-semibold text-info ml-auto disabled:opacity-40">
              {busy ? <><SpinnerGap weight="bold" className="w-4 h-4 animate-spin" /> Creating…</> : "New link"}
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

function PingCard({ ping, index, disabled = false, onSend }: { ping: Ping; index: number; disabled?: boolean; onSend: (answers: Record<string, "yes" | "no">) => Promise<void> }) {
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
                disabled={disabled}
                onClick={() => set(i.key, "no")}
                aria-pressed={ans[i.key] === "no"}
                className={`h-9 px-3.5 rounded-full text-[14px] font-semibold transition ${ans[i.key] === "no" ? "bg-bad text-paper" : "bg-card text-mute"}`}
              >
                No
              </button>
              <button
                disabled={disabled}
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
      {disabled && <p className="mt-3 text-[13px] text-mute">In-app Pings require Google sign-in. Sign in with Google to answer this request; WhatsApp Ping links remain available.</p>}
      <div className="flex items-center gap-3 mt-3.5">
        {ping.items.length > 1 && (
          <button
            disabled={disabled}
            onClick={() => setAns(Object.fromEntries(ping.items.map((i) => [i.key, "yes" as const])))}
            className="text-[14px] font-medium text-mute disabled:opacity-40"
          >
            Yes to all
          </button>
        )}
        <button
          disabled={disabled || !complete || busy}
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
      .filter((p) => isAnswered(p) && daysSince(p.date) <= PING_HISTORY_DAYS)
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

export default function MatesView({ mates, social, subjects, scheduleOverrides = [], addOpen, onCloseAdd, onOpenAdd, onRemove, onSaveAlias, onSaveIntegrationPreference, onOpenWrapped, showWrappedInPingSection = false, onToast }: MatesViewProps) {
  const [mateCode, setMateCode] = useState("")
  const [mateAlias, setMateAlias] = useState("")
  const [aliasEditingId, setAliasEditingId] = useState<string | null>(null)
  const [aliasDraft, setAliasDraft] = useState("")
  const [connectingCode, setConnectingCode] = useState(false)
  const [requestAliases, setRequestAliases] = useState<Record<string, string>>({})
  // Removing a mate wipes their favour history (and ends a connection), so it needs a second tap
  const [removing, setRemoving] = useState<Mate | null>(null)
  // The mate you are about to ping
  const [pinging, setPinging] = useState<Mate | null>(null)
  const [directChooserOpen, setDirectChooserOpen] = useState(false)
  const [connectingMateId, setConnectingMateId] = useState<string | null>(null)

  const owed = (m: Mate) => Math.max(0, m.covered - m.repaid)
  const ranked = [...mates].sort((a, b) => owed(b) - owed(a) || b.covered - a.covered || a.name.localeCompare(b.name))
  const totalOwed = mates.reduce((n, m) => n + owed(m), 0)

  const now = new Date()
  const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate()

  const me = social.uid
  // "Connected" means connected under the account that is signed in now, not merely having once been
  const connectedUids = new Set(social.requests.filter((r) => r.status === "accepted").map((r) => r.participants.find((p) => p !== me)))
  const isConnected = (m: Mate) => !!m.uid && connectedUids.has(m.uid)
  const connectedMates = ranked.filter(isConnected)
  const canUseDirectPings = canUseInAppPing({ configured: social.configured, ready: social.status === "ready", anonymous: social.anonymous })
  const incoming = social.requests.filter((r) => r.status === "pending" && r.to === me)
  const outgoing = social.requests.filter((r) => r.status === "pending" && r.from === me)
  const toAnswer = social.received.filter((p) => p.status === "asking" && !isExpired(p))

  // Existing Mate rows may already contain the other account's Firebase UID.
  // Use it to send a real connection request instead of forcing the user to re-copy the code.
  // The recipient still has to accept; this never grants an unconnected account Ping permissions.
  const requestMateConnection = async (mate: Mate) => {
    if (!mate.alias?.trim()) {
      setAliasEditingId(mate.id)
      setAliasDraft("")
      onToast("Add a personal alias for this Mate before connecting.")
      return
    }
    if (!mate.uid) {
      onToast("Connect using your friend's unique account code or link.")
      onOpenAdd()
      return
    }
    if (connectingMateId !== null) return
    setConnectingMateId(mate.id)
    try {
      const result = await social.connectViaUid(mate.uid)
      onToast(result.message)
    } catch (error) {
      const message = error instanceof Error ? error.message : "Couldn't send the connection request. Check the account code and try again."
      onToast(message)
    } finally {
      setConnectingMateId(null)
    }
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    const raw = mateCode.trim()
    const alias = mateAlias.trim().replace(/\s+/g, " ").slice(0, 48)
    if (!raw || !alias || connectingCode) return
    let addUid = raw
    let inviteToken = ""
    try {
      if (/^https?:\/\//i.test(raw)) {
        const parsed = new URL(raw)
        addUid = parsed.searchParams.get("add") || ""
        inviteToken = parsed.searchParams.get("invite") || ""
      }
    } catch { /* treat as a raw code below */ }
    if (!addUid && !inviteToken) {
      onToast("Enter a friend's unique account code, permanent link, or 15-minute invite link.")
      return
    }
    setConnectingCode(true)
    try {
      const result = inviteToken ? await social.connectViaInvite(inviteToken) : await social.connectViaUid(addUid)
      if (result.ok) {
        const mateUid = result.mateUid || addUid
        if (social.uid && mateUid) writeMateAlias(social.uid, mateUid, alias)
        await onSaveAlias({
          id: mateUid,
          uid: mateUid,
          name: result.mateName || "Mate",
          covered: 0,
          repaid: 0,
        }, alias)
        setMateCode("")
        setMateAlias("")
        onCloseAdd()
      }
      onToast(result.message)
    } catch {
      onToast("Couldn't send the connection request. Check the code or link and try again.")
    } finally {
      setConnectingCode(false)
    }
  }

  return (
    <div className="space-y-7 lg:space-y-0 lg:columns-2 lg:gap-x-10 lg:[&>*]:break-inside-avoid lg:[&>*]:mb-7">
      <section className={`${card} p-4 sm:p-5`} data-tour="mates-quick-ping">
        <div className="flex items-start gap-3">
          <span className="w-11 h-11 rounded-2xl bg-good/15 text-good grid place-items-center flex-shrink-0"><ShareNetwork weight="bold" className="w-5 h-5" /></span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-[17px] font-bold">Quick WhatsApp Ping</h2>
              <InfoTip label="About Quick WhatsApp Ping">
                Create a one-time link that expires after 24 hours. The recipient answers Yes or No, and you review the result before it changes your attendance. In-app Pings require Google sign-in and an accepted Mate connection.
              </InfoTip>
            </div>
            <div className="mt-3 grid grid-cols-1 min-[360px]:grid-cols-2 gap-2">
              <button
                onClick={() => setPinging({ id: "__general__", name: "", covered: 0, repaid: 0 })}
                className="grid min-h-12 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center justify-center gap-2 rounded-2xl bg-ink px-3 py-3 text-left text-[14px] font-semibold leading-tight text-paper transition hover:opacity-90"
              >
                <ShareNetwork className="h-5 w-5" />
                <span className="min-w-0">WhatsApp Ping<span className="mt-0.5 block text-[11px] font-medium opacity-75">One-time link · 24h</span></span>
              </button>
              {canUseDirectPings && connectedMates.length > 0 && (
                <button onClick={() => setDirectChooserOpen(true)} className="grid min-h-12 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center justify-center gap-2 rounded-2xl bg-secondary px-3 py-3 text-left text-[14px] font-semibold leading-tight">
                  <ChatCircleDots className="h-5 w-5" />
                  <span className="min-w-0">In-app Ping<span className="mt-0.5 block text-[11px] font-medium text-mute">Connected mates</span></span>
                </button>
              )}
              {social.configured && social.anonymous && (
                <button type="button" disabled title="Sign in with Google to enable direct Pings" className="grid min-h-12 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-2xl bg-secondary/70 px-3 py-3 text-left text-[13px] font-semibold text-mute disabled:opacity-70">
                  <LockKey className="h-5 w-5" /><span className="min-w-0">In-app Ping<span className="mt-0.5 block text-[11px] font-medium">Google sign-in required</span></span>
                </button>
              )}
              {canUseDirectPings && connectedMates.length === 0 && (
                <button type="button" disabled title="Connect with a friend and wait for them to accept first" className="grid min-h-12 w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 rounded-2xl bg-secondary/70 px-3 py-3 text-left text-[13px] font-semibold text-mute disabled:opacity-70">
                  <LockKey className="h-5 w-5" /><span className="min-w-0">In-app Ping<span className="mt-0.5 block text-[11px] font-medium">Connect a friend first</span></span>
                </button>
              )}
            </div>
            {(social.configured && social.anonymous) || (canUseDirectPings && connectedMates.length === 0) ? (
              <p className="mt-2 text-[12px] leading-snug text-mute">
                {social.configured && social.anonymous
                  ? "Sign in with Google and connect with a friend to enable in-app Pings. WhatsApp links remain available."
                  : "Connect with a friend and wait for them to accept to enable in-app Pings."}
              </p>
            ) : null}
          </div>
        </div>
        <p className="text-[12px] text-mute leading-relaxed mt-3">A Yes response can update the selected attendance records; in-app Pings also update the connected Mate&apos;s favour count.</p>
        {showWrappedInPingSection && (
          <div className="mt-4 rounded-2xl border border-ink/[0.07] bg-secondary/70 p-3.5 flex items-center gap-3">
            <span className="w-10 h-10 rounded-xl bg-card grid place-items-center text-[20px] flex-shrink-0" aria-hidden>✦</span>
            <div className="min-w-0 flex-1">
              <p className="text-[10px] uppercase tracking-[0.12em] font-extrabold text-mute">Saturday · Weekly wrapped</p>
              <p className="text-[14px] font-bold mt-0.5">Your week, in review</p>
              <p className="text-[12px] text-mute leading-snug mt-0.5">See your attendance highlights and the people who helped.</p>
            </div>
            <button onClick={onOpenWrapped} className="h-9 px-3 rounded-full bg-ink text-paper text-[12px] font-bold flex-shrink-0">Open</button>
          </div>
        )}
      </section>
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
                disabled={social.anonymous && social.configured}
                onSend={(answers) => social.answerPing(p.id, answers).then((r) => onToast(r.message))}
              />
            ))}
          </ul>
          <p className="text-[13px] text-mute px-1 mt-2 leading-snug">
            A Yes response marks the selected class present on the sender&apos;s attendance record.
          </p>
        </section>
      )}

      {/* Inbox */}
      {incoming.length > 0 && (
        <section>
          <SectionHeader>Requests</SectionHeader>
          <ul className={`${card} overflow-hidden divide-y divide-ink/[0.08]`}>
            {incoming.map((r, i) => (
              <li key={r.id} className="flex flex-wrap items-center gap-3 px-4 py-3.5">
                <Avatar name={r.fromName} i={i} size={42} />
                <div className="min-w-0 flex-1">
                  <p className="text-[16px] font-semibold truncate leading-snug">{r.fromName}</p>
                  <p className="text-[12px] text-mute leading-snug">wants to be your proxy-mate</p>
                </div>
                <button
                  onClick={() => void social.respond(r.id, "declined").then(() => onToast("Request declined."))}
                  aria-label={`Decline ${r.fromName}`}
                  className="h-10 rounded-full bg-bad/15 px-4 text-[13px] font-semibold text-bad"
                >
                  Decline
                </button>
                <div className="w-full basis-full">
                  <label className="mb-1 block text-[12px] font-semibold text-mute" htmlFor={`request-alias-${r.id}`}>Your alias for this mate (required)</label>
                  <input
                    id={`request-alias-${r.id}`}
                    required
                    maxLength={48}
                    value={requestAliases[r.id] ?? ""}
                    onChange={(e) => setRequestAliases((prev) => ({ ...prev, [r.id]: e.target.value }))}
                    placeholder={`e.g. ${r.fromName} from college`}
                    className={inputClass}
                  />
                </div>
                <button
                  disabled={!(requestAliases[r.id] ?? "").trim()}
                  onClick={async () => {
                    const alias = (requestAliases[r.id] ?? "").trim().replace(/\s+/g, " ").slice(0, 48)
                    if (!alias || !social.uid) return
                    try {
                      await social.respond(r.id, "accepted")
                      writeMateAlias(social.uid, r.from, alias)
                      await onSaveAlias({ id: r.from, uid: r.from, name: r.fromName, covered: 0, repaid: 0 }, alias)
                      setRequestAliases((prev) => { const next = { ...prev }; delete next[r.id]; return next })
                      onToast(`Connected with ${alias}`)
                    } catch {
                      onToast("Couldn't accept this request. Try again.")
                    }
                  }}
                  aria-label={`Accept ${r.fromName}`}
                  className="min-h-11 w-full rounded-xl bg-good px-4 text-[14px] font-bold text-paper disabled:opacity-40"
                >
                  <Check weight="bold" className="mr-1 inline h-4 w-4" /> Accept connection
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* Month-end */}
      <div className="rounded-2xl bg-card p-4" data-tour="mates-favour-balance">
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
                  <Avatar name={visibleMateName(m)} i={i} />
                  <div className="min-w-0 flex-1">
                    <p className="text-[17px] font-semibold truncate leading-snug">
                      {visibleMateName(m)}
                      {isConnected(m) && <span className="ml-2 align-middle text-[10px] font-bold tracking-wide text-mute bg-ink/10 rounded px-1.5 py-0.5">CONNECTED</span>}
                      {m.uid && !isConnected(m) && <span className="ml-2 align-middle text-[10px] font-bold tracking-wide text-mute bg-ink/10 rounded px-1.5 py-0.5" title="Not connected under the account you are signed in with">NOT CONNECTED</span>}
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
                <div className="flex flex-wrap items-center gap-1.5 mt-3.5">
                  <button onClick={() => setPinging(m)} title={canSendInAppPing({ configured: social.configured, ready: social.status === "ready", anonymous: social.anonymous, connected: isConnected(m) }) ? "Send an in-app Ping or a WhatsApp link" : "Create a 24-hour WhatsApp Ping link; Google sign-in and an accepted connection enable in-app Pings"} className={chip}>
                    {canSendInAppPing({ configured: social.configured, ready: social.status === "ready", anonymous: social.anonymous, connected: isConnected(m) }) ? "In-app Ping" : "WhatsApp Ping"}
                  </button>
                  {m.uid && !isConnected(m) && social.configured && (
                    <button
                      type="button"
                      onClick={() => void requestMateConnection(m)}
                      disabled={social.status !== "ready" || connectingMateId !== null}
                      title="Send a connection request to this account. They must accept before an in-app Ping can be sent."
                      className={`${chip} disabled:opacity-45`}
                    >
                      {connectingMateId === m.id ? "Sending…" : "Connect"}
                    </button>
                  )}
                  <button onClick={() => setRemoving(m)} className="ml-auto text-[13px] text-mute hover:text-bad pl-1">
                    Remove
                  </button>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => { setAliasEditingId(aliasEditingId === m.id ? null : m.id); setAliasDraft(m.alias?.trim() || "") }}
                    className={chip}
                  >
                    {m.alias?.trim() ? "Edit alias" : "Set alias"}
                  </button>
                  <label className="flex min-h-10 flex-1 items-center gap-2 rounded-full bg-secondary px-3 py-1.5 text-[12px] font-semibold">
                    <input
                      type="checkbox"
                      checked={!!m.autoIntegrateResponses}
                      onChange={async (e) => {
                        try {
                          await onSaveIntegrationPreference(m, e.target.checked)
                          onToast(e.target.checked ? `Future replies from ${visibleMateName(m)} will integrate automatically.` : "Approval will be required for future replies again.")
                        } catch {
                          onToast("Couldn't save the preference. Please try again.")
                        }
                      }}
                      className="h-4 w-4 flex-shrink-0 accent-current"
                    />
                    <span className="min-w-0">Auto-integrate replies</span>
                    <InfoTip label={`About automatic integration for ${visibleMateName(m)}`}>
                      When enabled, future replies from this Mate can update your attendance without a separate approval. Leave it off to review every answer first. One-time WhatsApp links always ask.
                    </InfoTip>
                  </label>
                </div>
                {aliasEditingId === m.id && (
                  <form
                    className="mt-3 flex flex-col gap-2 rounded-2xl bg-secondary p-3 sm:flex-row"
                    onSubmit={async (e) => {
                      e.preventDefault()
                      const clean = aliasDraft.trim().replace(/\s+/g, " ").slice(0, 48)
                      if (!clean) return
                      try {
                        await onSaveAlias(m, clean)
                        setAliasEditingId(null)
                        setAliasDraft("")
                        onToast("Mate alias saved.")
                      } catch {
                        onToast("Couldn't save the alias. Please try again.")
                      }
                    }}
                  >
                    <input
                      required
                      maxLength={48}
                      value={aliasDraft}
                      onChange={(e) => setAliasDraft(e.target.value)}
                      aria-label={`Alias for ${visibleMateName(m)}`}
                      placeholder="Name only you see"
                      className={`${inputClass} min-w-0 flex-1`}
                    />
                    <div className="flex gap-2 sm:flex-shrink-0">
                      <button type="button" onClick={() => { setAliasEditingId(null); setAliasDraft("") }} className="h-10 flex-1 rounded-xl bg-card px-3 text-[13px] font-semibold sm:flex-none">Cancel</button>
                      <button type="submit" disabled={!aliasDraft.trim()} className="h-10 flex-1 rounded-xl bg-ink px-3 text-[13px] font-semibold text-paper disabled:opacity-45 sm:flex-none">Save alias</button>
                    </div>
                  </form>
                )}
                {m.uid && !isConnected(m) && (
                  <p className="text-[12px] text-mute mt-2">In-app Ping unlocks after this account accepts your connection request. Google sign-in is also required.</p>
                )}
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
        Send an in-app Ping to an accepted connection, or create a one-time WhatsApp response link for anyone else. An in-app Yes marks the selected class present and records a favour. A response-link Yes can update the selected attendance record; favour tracking is available only for connected Mates.
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

      <Sheet open={directChooserOpen} onClose={() => setDirectChooserOpen(false)} title="Send an in-app Ping">
        <p className="text-[14px] text-mute leading-snug mb-4">Choose a connected friend. They&apos;ll receive the request inside Attendance Tracker.</p>
        <ul className="space-y-2">
          {connectedMates.map((mate) => (
            <li key={mate.id}>
              <button type="button" onClick={() => { setDirectChooserOpen(false); setPinging(mate) }} className="w-full flex items-center gap-3 rounded-2xl bg-secondary px-3.5 py-3 text-left">
                <Avatar name={visibleMateName(mate)} size={40} />
                <span className="min-w-0 flex-1"><span className="block font-semibold truncate">{visibleMateName(mate)}</span><span className="block text-[12px] text-mute">Connected account</span></span>
                <ChatCircleDots className="w-5 h-5" />
              </button>
            </li>
          ))}
        </ul>
        {connectedMates.length === 0 && <button type="button" onClick={() => { setDirectChooserOpen(false); onOpenAdd() }} className={`${primaryButton} mt-3`}>Connect with a friend</button>}
      </Sheet>

      <PingSheet
        open={pinging !== null}
        onClose={() => setPinging(null)}
        mate={pinging && !isConnected(pinging) ? { ...pinging, uid: undefined } : pinging}
        displayName={pinging ? visibleMateName(pinging) : undefined}
        subjects={subjects}
        scheduleOverrides={scheduleOverrides}
        waiting={pinging && pinging.id !== "__general__" ? social.sent.filter((p) => p.status === "asking" && !isExpired(p) && (pinging.uid ? p.to === pinging.uid : !p.to && p.toName.trim().toLowerCase() === pinging.name.trim().toLowerCase())) : []}
        onAsk={(m, date, items) => social.sendPing({ uid: m.uid as string, name: m.name }, date, items)}
        canDirect={!!pinging && pinging.id !== "__general__" && canSendInAppPing({ configured: social.configured, ready: social.status === "ready", anonymous: social.anonymous, connected: isConnected(pinging) })}
        canChooseDirectMate={canUseDirectPings && connectedMates.length > 0}
        onChooseDirectMate={() => { setPinging(null); setDirectChooserOpen(true) }}
        onCreateSharePing={(toName, date, items) => social.createSharePing(toName, date, items)}
        onToast={onToast}
      />

      <Sheet open={addOpen} onClose={onCloseAdd} title="Connect with a Mate">
        <form onSubmit={submit} className="space-y-3">
          <Field label="Your alias for this mate">
            <input autoFocus required value={mateAlias} onChange={(e) => setMateAlias(e.target.value)} placeholder="e.g. Aditya from anatomy lab" maxLength={48} className={inputClass} autoCorrect="off" />
          </Field>
          <Field label="Unique account code or link">
            <input required value={mateCode} onChange={(e) => setMateCode(e.target.value)} placeholder="Paste code or friend link" className={inputClass} autoCapitalize="none" autoCorrect="off" spellCheck={false} />
          </Field>
          <p className="text-[13px] text-mute leading-snug">The alias is visible only to you. Use the full account code, permanent QR/link, or one-time invite link to identify the right person. They must accept before in-app Pings are enabled.</p>
          <button type="submit" disabled={!mateCode.trim() || !mateAlias.trim() || connectingCode} className={`${primaryButton} disabled:opacity-50`}>
            {connectingCode ? "Sending request…" : "Send connection request"}
          </button>
        </form>
      </Sheet>
    </div>
  )
}
