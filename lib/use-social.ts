"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { FriendRequest, Ping, PingItem } from "./types"
import { socialConfigured, ensureSignedIn } from "./social"
import { describeSocialAuthError } from "./social-auth-errors"
import { getDomainBackend, LEASE_MS } from "./backend"
import { localDate } from "./attendance"
import { MAX_PING_ITEMS, PING_HISTORY_DAYS, SHARE_PING_TTL_MS, answerItems, daysSince, isExpired, msOf } from "./pings"
import { requestNotificationPermission } from "./notifications"
import { requestFCMToken } from "./firebase"
import { attempt } from "./ping-send"
import { app, db } from "./firebase"
import { collection, deleteDoc, doc, onSnapshot, query, runTransaction, serverTimestamp, setDoc, Timestamp, updateDoc, where } from "firebase/firestore"
import { getAuth } from "firebase/auth"
import { followIdentity } from "./social-session"
import { announceProfile, completeCarry } from "./identity"
import { forget, idFor, logicalKey } from "./ping-id"
import { deviceId } from "./device"
import { shareableAppOrigin } from "./share-ping-link"
import { recordProductLinkEvent } from "./link-analytics"

/** Register this device for ping alerts. Only when notifications are allowed (or asked for), and never fatal. */
async function registerPingAlerts(uid: string, ask: boolean): Promise<boolean> {
  try {
    if (typeof Notification === "undefined") return false
    if (Notification.permission !== "granted" && !(ask && (await requestNotificationPermission()))) return false
    const token = await requestFCMToken()
    if (!token) return false
    await getDomainBackend("push").pushTokens.save(uid, token)
    return true
  } catch {
    return false /* alerts are a bonus: the Ping still shows when the app is opened */
  }
}

/** A class to ask about, before an answer exists */
export type PingInput = Omit<PingItem, "answer">

export interface ConnectResult {
  ok: boolean
  message: string
}

/** Everything the Mates screen needs. Also implemented by a mock in the design preview. */
export interface SocialApi {
  configured: boolean
  status: "off" | "idle" | "connecting" | "ready" | "error"
  error: string
  uid: string | null
  /** Signed in only as this browser's own anonymous account (not with Google), so mates stay on this browser */
  anonymous: boolean
  name: string
  requests: FriendRequest[]
  /** Pings you sent, asking a mate whether they marked you present */
  sent: Ping[]
  /** Pings mates sent you, asking whether you marked them present */
  received: Ping[]
  /** Permanent link (the QR code carries the same link). Empty until signed in. */
  addLink: string
  enable: () => void
  setName: (name: string) => Promise<void>
  respond: (id: string, status: "accepted" | "declined") => Promise<void>
  cancel: (id: string) => Promise<void>
  makeInvite: () => Promise<{ link: string; expiresAt: number } | null>
  connectViaUid: (uid: string) => Promise<ConnectResult>
  connectViaInvite: (token: string) => Promise<ConnectResult>
  trackInviteOpen: (token: string) => Promise<void>
  /** Ask a connected mate whether they marked you present in these classes (from your own subject list) */
  sendPing: (to: { uid: string; name: string }, date: string, items: PingInput[]) => Promise<ConnectResult>
  /** Create a token-protected response link to share by WhatsApp or another direct-message app. */
  createSharePing: (toName: string, date: string, items: PingInput[]) => Promise<{ ok: boolean; message: string; link?: string }>
  /** Take back a ping you sent (it disappears from the mate's list too) */
  cancelPing: (id: string) => Promise<void>
  /** Answer a ping a mate sent you: item key -> yes / no. `ok` is true only once the server has it. */
  answerPing: (id: string, answers: Record<string, "yes" | "no">) => Promise<ConnectResult>
  /** Ask this device to receive Ping alerts (asks for notification permission). Call it from a tap. */
  enableAlerts: () => Promise<boolean>
  /** Take the lease on an answered ping so this device can apply it. True only for the one device that holds it. */
  leasePing: (id: string) => Promise<boolean>
  /** The answer has been applied and saved here: mark the ping processed, for good */
  finalizePing: (id: string) => Promise<void>
  /** Dummy trigger: a mate has answered a ping you sent (local only, nothing is sent) */
  simulateReply: (mateName: string, items: PingInput[], answer: "yes" | "no") => void
  /** Dummy trigger: a mate is asking you whether you marked them present (local only) */
  simulateIncoming: (mateName: string, items: PingInput[]) => void
}

const NAME_KEY = "displayName"
const MOCK_KEY = "mock-social-store"
const MOCK_PINGS_KEY = "mock-pings"
const DEMO_PINGS_KEY = "demo-pings"
/** Stand-in ids for the two sides of a simulated ping */
const DEMO_ME = "demo-me"
const DEMO_MATE = "demo-mate"

type SharePingDoc = {
  ownerUid: string
  fromName?: string
  recipientName?: string
  date: string
  items: Array<{ key: string; subjectId: string; name: string; t?: string; substituted?: boolean; answer?: "yes" | "no" | null }>
  status: "asking" | "answered" | "processed" | "cancelled"
  createdAt?: { toMillis?: () => number } | number
  respondedAt?: { toMillis?: () => number } | number
  claimedBy?: string
  claimedAt?: { toMillis?: () => number } | number
  expiresAt?: { toMillis?: () => number } | number
}

const asMillis = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (value && typeof value === "object" && "toMillis" in value && typeof (value as { toMillis?: unknown }).toMillis === "function") {
    return (value as { toMillis: () => number }).toMillis()
  }
  return undefined
}

function mapSharePing(id: string, raw: SharePingDoc): Ping {
  return {
    id: `share-${id}`,
    from: raw.ownerUid,
    to: `share-recipient:${id}`,
    fromName: raw.fromName || "Attendance Tracker user",
    toName: raw.recipientName || "WhatsApp recipient",
    participants: [raw.ownerUid, `share-recipient:${id}`],
    date: raw.date,
    items: (raw.items || []).map((item) => ({
      key: item.key,
      subjectId: item.subjectId,
      name: item.name,
      ...(item.t ? { t: item.t } : {}),
      ...(item.substituted === true ? { substituted: true } : {}),
      answer: item.answer === "yes" || item.answer === "no" ? item.answer : null,
    })),
    status: raw.status,
    ...(asMillis(raw.createdAt) !== undefined ? { createdAt: asMillis(raw.createdAt) } : {}),
    ...(asMillis(raw.expiresAt) !== undefined ? { expiresAt: asMillis(raw.expiresAt) } : {}),
    ...(asMillis(raw.respondedAt) !== undefined ? { respondedAt: asMillis(raw.respondedAt) } : {}),
    ...(raw.claimedBy ? { claimedBy: raw.claimedBy } : {}),
    ...(asMillis(raw.claimedAt) !== undefined ? { claimedAt: asMillis(raw.claimedAt) } : {}),
    shareLink: true,
  }
}

const makeId = () =>
  typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`

function readMockStore() {
  if (typeof window === "undefined") {
    return { uid: null as string | null, name: "", requests: [] as FriendRequest[], invites: {} as Record<string, { owner: string; ownerName: string; expiresAt: number }> }
  }

  try {
    const raw = localStorage.getItem(MOCK_KEY)
    if (!raw) {
      return { uid: null, name: "", requests: [], invites: {} }
    }
    return JSON.parse(raw) as {
      uid: string | null
      name: string
      requests: FriendRequest[]
      invites: Record<string, { owner: string; ownerName: string; expiresAt: number }>
    }
  } catch {
    return { uid: null, name: "", requests: [], invites: {} }
  }
}

function writeMockStore(next: ReturnType<typeof readMockStore>) {
  if (typeof window !== "undefined") {
    localStorage.setItem(MOCK_KEY, JSON.stringify(next))
  }
}

function readMockPings(): Ping[] {
  try {
    const raw = typeof window === "undefined" ? null : localStorage.getItem(MOCK_PINGS_KEY)
    return raw ? (JSON.parse(raw) as Ping[]) : []
  } catch {
    return []
  }
}

const writeMockPings = (pings: Ping[]) => {
  if (typeof window !== "undefined") localStorage.setItem(MOCK_PINGS_KEY, JSON.stringify(pings))
}

function generateDummyRequests(myUid: string, myName: string): FriendRequest[] {
  const friends = [
    { uid: "friend-ava-001", name: "Ava" },
    { uid: "friend-zoe-002", name: "Zoe" },
    { uid: "friend-ryan-003", name: "Ryan" },
  ]

  return friends.map((friend, index) => ({
    id: `req-${friend.uid}-${index}`,
    from: friend.uid,
    to: myUid,
    fromName: friend.name,
    toName: myName || "You",
    participants: [friend.uid, myUid],
    status: index === 0 ? "pending" : "accepted",
  }))
}

export function useSocial(onNotice?: (message: string) => void): SocialApi {
  const noticeRef = useRef(onNotice)
  noticeRef.current = onNotice
  const mockMode = !socialConfigured()
  // Never advertise mock/local IDs as real friend links. This flag controls connection links and inbound link handling.
  const configured = !mockMode
  const [status, setStatus] = useState<SocialApi["status"]>(mockMode ? "idle" : "idle")
  const statusRef = useRef(status)
  statusRef.current = status
  const [error, setError] = useState("")
  const [uid, setUid] = useState<string | null>(null)
  const [anonymous, setAnonymous] = useState(true)
  const [name, setNameState] = useState("")
  const [requests, setRequests] = useState<FriendRequest[]>([])
  const [remotePings, setRemotePings] = useState<Ping[]>([])
  const [sharePings, setSharePings] = useState<Ping[]>([])
  // Made-up pings from the settings simulator: saved on this device only and never sent anywhere
  const [demoPings, setDemoPings] = useState<Ping[]>([])
  const [demoLoaded, setDemoLoaded] = useState(false)
  const started = useRef(false)
  const stopFollowing = useRef<(() => void) | null>(null)
  const authWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pingsRef = useRef<Ping[]>([])

  const me = useRef({ uid: null as string | null, name: "" })
  const reqs = useRef<FriendRequest[]>([])
  me.current = { uid, name }
  reqs.current = requests

  useEffect(() => {
    if (!mockMode) {
      setStatus("idle")
      return
    }

    const stored = readMockStore()
    const initialUid = stored.uid ?? `mock-${makeId()}`
    const initialName = stored.name || "You"
    const initialRequests = stored.requests.length ? stored.requests : generateDummyRequests(initialUid, initialName)

    if (!stored.uid || !stored.name) {
      const next = { ...stored, uid: initialUid, name: initialName, requests: initialRequests }
      writeMockStore(next)
    }

    setUid(initialUid)
    setNameState(initialName)
    setRequests(initialRequests)
    setRemotePings(readMockPings())
    setStatus("ready")
  }, [mockMode])

  useEffect(() => {
    try {
      const raw = localStorage.getItem(DEMO_PINGS_KEY)
      if (raw) setDemoPings(JSON.parse(raw) as Ping[])
    } catch {
      /* ignore a corrupt value */
    }
    setDemoLoaded(true)
  }, [])

  useEffect(() => {
    if (demoLoaded) localStorage.setItem(DEMO_PINGS_KEY, JSON.stringify(demoPings))
  }, [demoPings, demoLoaded])

  const enable = useCallback(() => {
    if (mockMode) {
      const stored = readMockStore()
      const currentUid = stored.uid ?? `mock-${makeId()}`
      const currentName = stored.name || "You"
      const nextRequests = stored.requests.length ? stored.requests : generateDummyRequests(currentUid, currentName)
      writeMockStore({ ...stored, uid: currentUid, name: currentName, requests: nextRequests })
      setUid(currentUid)
      setNameState(currentName)
      setRequests(nextRequests)
      setStatus("ready")
      return
    }

    if (!configured) return
    const signIn = () => {
      setError("")
      setStatus("connecting")
      return ensureSignedIn()
        .then((user) => {
          try { localStorage.setItem("socialOn", "1") } catch { /* storage may be unavailable in private browsers */ }
          // Do not rely exclusively on the auth observer: Next.js Strict Mode can run an effect cleanup
          // immediately after setup in development. The sign-in promise itself is authoritative.
          setUid(user.uid)
          setAnonymous(user.isAnonymous)
          let saved = ""
          try { saved = localStorage.getItem(NAME_KEY) || "" } catch { /* private browsing */ }
          if (!saved) {
            saved = `Mate-${user.uid.slice(-8).toUpperCase()}`
            try { localStorage.setItem(NAME_KEY, saved) } catch { /* private browsing */ }
          }
          setNameState(saved)
          setError("")
          if (authWatchdog.current) clearTimeout(authWatchdog.current)
          authWatchdog.current = null
          setStatus("ready")
          void announceProfile(db, user.uid, saved).catch((e: unknown) => setError(describeSocialAuthError(e)))
        })
        .catch((e: unknown) => {
          if (authWatchdog.current) clearTimeout(authWatchdog.current)
          authWatchdog.current = null
          setError(describeSocialAuthError(e))
          setStatus("error")
        })
    }
    if (started.current) {
      if (me.current.uid !== null) return
      // During an ordinary connection attempt, let the existing listener finish. On an explicit retry after timeout,
      // detach and rebuild the auth listener rather than leaving the same stuck listener in place.
      if (statusRef.current !== "error") {
        if (!authWatchdog.current) authWatchdog.current = setTimeout(() => {
          setError("Firebase sign-in is taking too long. Check your internet connection, confirm this app uses the expected Firebase project, then try again.")
          setStatus("error")
          authWatchdog.current = null
        }, 12000)
        void signIn()
        return
      }
      stopFollowing.current?.()
      stopFollowing.current = null
      started.current = false
    }
    started.current = true
    setStatus("connecting")
    authWatchdog.current = setTimeout(() => {
      setError("Firebase sign-in is taking too long. Check your internet connection, confirm this app uses the expected Firebase project, then try again.")
      setStatus("error")
      authWatchdog.current = null
    }, 12000)
    // Whoever is signed in is who the mates, Pings and alerts belong to. When that changes (Google sign-in on a device
    // that already had a profile, signing out) everything follows: the listeners move, the old account's data leaves
    // the screen, and this device's alerts are registered for the new one.
    stopFollowing.current = followIdentity(
      { auth: getAuth(app), db },
      {
        onAuthMode: (_sameUid, anon) => setAnonymous(anon),
        onIdentity: (newUid, anon) => {
          setAnonymous(anon)
          if (!newUid) {
            // An initial null is normal while Firebase restores auth before anonymous sign-in completes.
            // Do not clear a UID/status already obtained by the sign-in promise; only clear it if an existing
            // signed-in session was actually removed (for example, explicit sign-out/account change).
            if (me.current.uid !== null) {
              setUid(null)
              setNameState("")
              setRequests([])
              setRemotePings([])
              setSharePings([])
              setStatus("idle")
            } else {
              setStatus((current) => current === "connecting" || current === "error" || current === "ready" ? current : "idle")
            }
            return
          }
          setUid(newUid)
          if (authWatchdog.current) clearTimeout(authWatchdog.current)
          authWatchdog.current = null
          // A display label is generated from the account ID; identity is the full Firebase UID, never the label.
          // This removes the name-entry blocker and avoids treating names as unique identifiers.
          let saved = ""
          try { saved = localStorage.getItem(NAME_KEY) || "" } catch { /* private browsing */ }
          if (!saved) {
            saved = `Mate-${newUid.slice(-8).toUpperCase()}`
            try { localStorage.setItem(NAME_KEY, saved) } catch { /* private browsing */ }
          }
          setNameState(saved)
          setError("")
          void announceProfile(db, newUid, saved)
          void registerPingAlerts(newUid, false)
          // Mates carried over from an account this device left are asked to reconnect (see lib/identity.ts)
          void completeCarry(db, newUid, saved).then((n) => {
            if (n > 0) noticeRef.current?.(`Asked ${n} ${n === 1 ? "mate" : "mates"} to reconnect with your account.`)
          })
          setStatus("ready")
        },
        onRequests: setRequests,
        onPings: setRemotePings,
        onError: (e) => setError(e.message),
      },
    )
    void signIn()
  }, [configured, mockMode])

  useEffect(
    () => () => {
      if (authWatchdog.current) clearTimeout(authWatchdog.current)
      authWatchdog.current = null
      stopFollowing.current?.()
      stopFollowing.current = null
      // Reset the latch: React Strict Mode runs setup -> cleanup -> setup during local development.
      started.current = false
    },
    [],
  )

  // Share-link replies belong only to the sender. Query is owner-scoped so Firestore rules can prove the caller's access.
  useEffect(() => {
    if (mockMode || !uid) {
      setSharePings([])
      return
    }
    const q = query(collection(db, "sharePings"), where("ownerUid", "==", uid))
    return onSnapshot(q, (snapshot) => {
      setSharePings(snapshot.docs.map((entry) => mapSharePing(entry.id, entry.data() as SharePingDoc)))
    }, (e) => setError(e.message))
  }, [mockMode, uid])

  useEffect(() => {
    if (mockMode) {
      setStatus("ready")
      return
    }
    try {
      if (configured && localStorage.getItem("socialOn") === "1") enable()
    } catch {
      // The user can still enable friend connections using the visible control if local storage is unavailable.
    }
  }, [configured, enable, mockMode])

  const setName = useCallback(async (next: string) => {
    const clean = next.trim().slice(0, 40)
    if (!clean) return
    localStorage.setItem(NAME_KEY, clean)
    setNameState(clean)

    if (mockMode) {
      const stored = readMockStore()
      const updated = { ...stored, name: clean }
      writeMockStore(updated)
      setRequests((prev) => prev.map((r) => (r.to === me.current.uid ? { ...r, toName: clean } : r)))
      return
    }

    if (me.current.uid) await getDomainBackend("social").profiles.save(me.current.uid, clean)
  }, [mockMode])

  const connect = useCallback(async (targetUid: string, knownName?: string): Promise<ConnectResult> => {
    const { uid: myUid, name: myName } = me.current
    if (!myUid || !myName) return { ok: false, message: "Enter your name first." }
    if (targetUid === myUid) return { ok: false, message: "That's your own code." }

    if (mockMode) {
      const stored = readMockStore()
      const codeStub = targetUid.startsWith("mock-") || targetUid.startsWith("friend-") ? targetUid : `friend-${targetUid}`
      const existing = stored.requests.find((r) => r.participants.includes(targetUid) || r.participants.includes(codeStub))
      if (existing) {
        if (existing.status === "accepted") return { ok: true, message: `You're already connected with ${existing.fromName}.` }
        if (existing.status === "pending") {
          if (existing.to === myUid) {
            const updated = stored.requests.map((r) =>
              r.id === existing.id ? { ...r, status: "accepted" as const } : r,
            )
            writeMockStore({ ...stored, requests: updated })
            setRequests(updated)
            return { ok: true, message: `Connected with ${existing.fromName}.` }
          }
          return { ok: true, message: `Your request to ${existing.fromName} is already waiting.` }
        }
      }

      const targetName = knownName ?? `Friend ${String(targetUid).slice(-4) || "new"}`
      const request: FriendRequest = {
        id: makeId(),
        from: myUid,
        to: targetUid,
        fromName: myName,
        toName: targetName,
        participants: [myUid, targetUid],
        status: "pending",
      }

      const next = [request, ...stored.requests]
      writeMockStore({ ...stored, requests: next })
      setRequests(next)
      return { ok: true, message: `Request sent to ${targetName}.` }
    }

    const existing = reqs.current.find((r) => r.participants.includes(targetUid))
    if (existing) {
      const other = existing.from === myUid ? existing.toName : existing.fromName
      if (existing.status === "accepted") return { ok: true, message: `You're already connected with ${other}.` }
      if (existing.status === "pending") {
        if (existing.to === myUid) {
          await getDomainBackend("social").connections.respond(existing.id, "accepted")
          return { ok: true, message: `Connected with ${other}.` }
        }
        return { ok: true, message: `Your request to ${other} is already waiting.` }
      }
      await getDomainBackend("social").connections.remove(existing.id)
    }

    const targetName = knownName ?? (await getDomainBackend("social").profiles.getName(targetUid))
    if (!targetName) return { ok: false, message: "That code isn't valid." }
    await getDomainBackend("social").connections.send({ uid: myUid, name: myName }, { uid: targetUid, name: targetName })
    return { ok: true, message: `Request sent to ${targetName}.` }
  }, [mockMode])

  const connectViaUid = useCallback((target: string) => connect(target), [connect])

  const trackInviteOpen = useCallback(async (token: string) => {
    if (mockMode || !token) return
    try {
      await ensureSignedIn()
      const invite = await getDomainBackend("social").invites.read(token)
      if (!invite) return
      void recordProductLinkEvent({ source: "mate-invite", linkId: token, kind: "opened", ownerUid: invite.owner, fromName: invite.ownerName, recipientName: me.current.name || "" })
    } catch { /* never block invite/sign-in on analytics */ }
  }, [mockMode])

  const connectViaInvite = useCallback(
    async (token: string): Promise<ConnectResult> => {
      if (mockMode) {
        const stored = readMockStore()
        const invite = stored.invites[token]
        const ownerName = invite?.ownerName ?? `Friend ${token.slice(-4) || "new"}`
        const ownerId = invite?.owner ?? `friend-${token.slice(-6) || makeId().slice(-6)}`
        const request: FriendRequest = {
          id: makeId(),
          from: ownerId,
          to: me.current.uid ?? stored.uid ?? `mock-${makeId()}`,
          fromName: ownerName,
          toName: me.current.name || stored.name || "You",
          participants: [ownerId, me.current.uid ?? stored.uid ?? `mock-${makeId()}`],
          status: "pending",
        }

        const next = [request, ...stored.requests]
        writeMockStore({ ...stored, requests: next })
        setRequests(next)
        return { ok: true, message: `Invite accepted for ${ownerName}.` }
      }

      const invite = await getDomainBackend("social").invites.read(token)
      if (!invite) return { ok: false, message: "That link isn't valid." }
      if (invite.expired) return { ok: false, message: "That link has expired. Ask for a new one." }
      const result = await connect(invite.owner, invite.ownerName)
      if (result.ok) void recordProductLinkEvent({ source: "mate-invite", linkId: token, kind: "used", ownerUid: invite.owner, fromName: invite.ownerName, recipientName: me.current.name || "" })
      return result
    },
    [connect, mockMode],
  )

  const respond = useCallback((id: string, next: "accepted" | "declined") => {
    if (mockMode) {
      const stored = readMockStore()
      const updated = stored.requests.map((r) => (r.id === id ? { ...r, status: next } : r))
      writeMockStore({ ...stored, requests: updated })
      setRequests(updated)
      return Promise.resolve()
    }
    return getDomainBackend("social").connections.respond(id, next)
  }, [mockMode])

  const cancel = useCallback((id: string) => {
    if (mockMode) {
      const stored = readMockStore()
      const updated = stored.requests.filter((r) => r.id !== id)
      writeMockStore({ ...stored, requests: updated })
      setRequests(updated)
      return Promise.resolve()
    }
    return getDomainBackend("social").connections.remove(id)
  }, [mockMode])

  const makeInvite = useCallback(async () => {
    const { uid: myUid, name: myName } = me.current
    if (!myUid || !myName || typeof window === "undefined") return null
    const publicOrigin = shareableAppOrigin(window.location.origin, process.env.NEXT_PUBLIC_APP_URL)
    if (!publicOrigin.ok) return null // localhost links only open on the sender's own device

    if (mockMode) {
      const token = `invite-${makeId().slice(0, 10)}`
      const expiresAt = Date.now() + 15 * 60_000
      const stored = readMockStore()
      const invites = { ...stored.invites, [token]: { owner: myUid, ownerName: myName, expiresAt } }
      writeMockStore({ ...stored, invites })
      return { link: `${publicOrigin.origin}/?invite=${token}`, expiresAt }
    }

    const { token, expiresAt } = await getDomainBackend("social").invites.create(myUid, myName, 15)
    void recordProductLinkEvent({ source: "mate-invite", linkId: token, kind: "created", ownerUid: myUid, fromName: myName, recipientName: "" })
    return { link: `${publicOrigin.origin}/?invite=${token}`, expiresAt }
  }, [mockMode])

  // One send per request at a time: a second tap on the same request joins the first instead of starting another
  const sending = useRef(new Map<string, Promise<ConnectResult>>())

  const sendPing = useCallback(
    async (to: { uid: string; name: string }, date: string, items: PingInput[]): Promise<ConnectResult> => {
      const { uid: myUid, name: myName } = me.current
      if (anonymous && !mockMode) return { ok: false, message: "In-app Pings require Google sign-in. You can still create a WhatsApp Ping link with anonymous sign-in." }
      if (!myUid || !myName) return { ok: false, message: "Your account is still connecting. Try again in a moment." }
      if (items.length === 0) return { ok: false, message: "Pick a class first." }
      if (items.length > MAX_PING_ITEMS) return { ok: false, message: `A Ping can ask about up to ${MAX_PING_ITEMS} classes at a time.` }
      const asked: PingItem[] = items.map((i) => ({ key: i.key, subjectId: i.subjectId, name: i.name.slice(0, 60), ...(i.t ? { t: i.t } : {}), answer: null }))
      // Pings only go to accepted mates, and name the connection so the server rules can check it
      const requestId = reqs.current.find((r) => r.status === "accepted" && r.participants.includes(to.uid))?.id
      if (!requestId && !mockMode) return { ok: false, message: `You're not connected with ${to.name} yet.` }

      const key = logicalKey(myUid, to.uid, date, asked.map((i) => i.key))
      const running = sending.current.get(key)
      if (running) return running

      const run = (async (): Promise<ConnectResult> => {
        // The same request always gets the same id until the send is confirmed, so any retry (after a timeout, a reload,
        // a dropped connection) can only ever resolve to the one Ping
        const id = idFor(key)
        const done = { ok: true, message: `Asked ${to.name}. You'll see their answer here as soon as they reply.` }
        if (mockMode) {
          // No second device to receive it, so the mock only records it (once per id, like the server)
          const have = readMockPings()
          if (!have.some((p) => p.id === id)) {
            const ping: Ping = { id, from: myUid, to: to.uid, fromName: myName, toName: to.name, participants: [myUid, to.uid], ...(requestId ? { requestId } : {}), date, items: asked, status: "asking", createdAt: Date.now() }
            writeMockPings([ping, ...have])
            setRemotePings([ping, ...have])
          }
          forget(key)
          return done
        }
        // Offline returns at once and sends nothing; a write the server hasn't confirmed is reported as not confirmed
        const r = await attempt(() => getDomainBackend("ping").pings.create({ id, from: { uid: myUid, name: myName }, to, date, items: asked, requestId: requestId as string }))
        if (!r.ok) return { ok: false, message: r.message } // the id is kept, so trying again cannot make a second Ping
        forget(key)
        // First ping is the natural moment to ask: the reply will arrive as an alert
        void registerPingAlerts(myUid, true)
        return done
      })().finally(() => sending.current.delete(key))
      sending.current.set(key, run)
      return run
    },
    [mockMode, anonymous],
  )

  const createSharePing = useCallback(async (toName: string, date: string, items: PingInput[]) => {
    if (mockMode) return { ok: false, message: "This preview has no Firebase configuration (.env.local is intentionally not included in the feature ZIP). Restore your original project's local environment configuration, restart the dev server, and use the public HTTPS website for recipient links." }
    const shareOrigin = typeof window !== "undefined" ? shareableAppOrigin(window.location.origin, process.env.NEXT_PUBLIC_APP_URL) : { ok: false as const, message: "Open Attendance Tracker in a browser to create a Ping link." }
    if (!shareOrigin.ok) return { ok: false, message: shareOrigin.message }
    let { uid: myUid, name: myName } = me.current
    if (!myUid) {
      try {
        const user = await ensureSignedIn()
        myUid = user.uid
        myName = myName || (typeof localStorage !== "undefined" ? localStorage.getItem(NAME_KEY) || "" : "")
        setUid(user.uid)
        setAnonymous(user.isAnonymous)
        setNameState(myName)
        if (typeof localStorage !== "undefined") localStorage.setItem("socialOn", "1")
        // Start the existing account listeners on-demand so the sender receives the answer even when they use
        // general WhatsApp Ping without having connected a Mate first.
        enable()
      } catch (e) {
        const detail = e instanceof Error ? e.message : "Firebase sign-in failed."
        return { ok: false, message: /operation-not-allowed|admin-restricted/i.test(detail)
          ? "Firebase Anonymous sign-in is disabled. Enable it in Firebase Authentication, then try again."
          : `Could not sign in to Firebase: ${detail}` }
      }
    }
    const senderName = myName?.trim() || "Attendance Tracker user"
    if (!items.length) return { ok: false, message: "Pick at least one class first." }
    if (items.length > MAX_PING_ITEMS) return { ok: false, message: `A Ping can ask about up to ${MAX_PING_ITEMS} classes at a time.` }
    try {
      // The random 256-bit document ID is the bearer capability in the URL. No raw token or extra SQL table is needed.
      // Public clients may GET this exact ID and submit one answer; Firestore rules prevent listing or editing anything else.
      if (!globalThis.crypto?.getRandomValues) return { ok: false, message: "This browser cannot create a secure link. Try an up-to-date browser over HTTPS." }
      const bytes = new Uint8Array(32)
      globalThis.crypto.getRandomValues(bytes)
      const id = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
      const now = Date.now()
      const asked = items.map((item) => ({ key: item.key, subjectId: item.subjectId, name: item.name.slice(0, 60), ...(item.t ? { t: item.t } : {}), ...(item.substituted ? { substituted: true } : {}), answer: null }))
      const fromName = senderName.slice(0, 40)
      const recipientName = toName.trim().slice(0, 40)
      await setDoc(doc(db, "sharePings", id), {
        ownerUid: myUid,
        fromName,
        recipientName,
        date,
        items: asked,
        status: "asking",
        createdAt: serverTimestamp(),
        expiresAt: Timestamp.fromMillis(now + SHARE_PING_TTL_MS),
        purgeAt: Timestamp.fromMillis(now + SHARE_PING_TTL_MS + 30 * 24 * 60 * 60 * 1000),
      })
      void recordProductLinkEvent({ source: "share-ping", linkId: id, kind: "created", ownerUid: myUid, fromName, recipientName })
      const link = `${shareOrigin.origin}/ping/${id}`
      return { ok: true, message: "Secure Ping link created.", link }
    } catch (e) {
      const detail = e instanceof Error ? e.message : "Could not create a secure Ping link."
      const message = /permission-denied|insufficient permissions/i.test(detail)
        ? "Firebase rejected the Ping request. Deploy the updated Firestore rules for sharePings to the correct project, then retry."
        : /network|offline|unavailable/i.test(detail)
          ? "Firebase could not be reached. Check the internet connection and try again."
          : `${detail} Check that the Firebase keys match the project and Anonymous sign-in is enabled.`
      return { ok: false, message }
    }
  }, [mockMode, enable])

  const answerPing = useCallback(
    async (id: string, answers: Record<string, "yes" | "no">) => {
      if (anonymous && !mockMode && !id.startsWith("share-")) return { ok: false, message: "In-app Pings require Google sign-in. Sign in with Google to answer a mate's in-app Ping." }
      const cur = pingsRef.current.find((p) => p.id === id)
      if (!cur) return { ok: false, message: "That Ping isn't available any more." }
      const validation = answerItems(cur.items, answers)
      if (!validation.ok) return { ok: false, message: "Please choose Yes or No for every class before sending your answer." }
      const items = validation.items
      const apply = (p: Ping): Ping => (p.id === id ? { ...p, items, status: "answered", respondedAt: Date.now() } : p)
      const done = { ok: true, message: `Sent your answer to ${cur.fromName}` }
      if (id.startsWith("demo-")) {
        setDemoPings((prev) => prev.map(apply))
        return done
      }
      if (mockMode) {
        const updated = readMockPings().map(apply)
        writeMockPings(updated)
        setRemotePings(updated)
        return done
      }
      const r = await attempt(() => getDomainBackend("ping").pings.answer(id, items))
      return r.ok ? done : { ok: false, message: r.message }
    },
    [mockMode, anonymous],
  )

  const enableAlerts = useCallback(async () => {
    const { uid: myUid } = me.current
    return myUid && !mockMode ? registerPingAlerts(myUid, true) : false
  }, [mockMode])

  const leasePing = useCallback(
    async (id: string) => {
      const dev = deviceId()
      const free = (p?: Ping) => {
        if (!p || p.status !== "answered") return false
        const at = msOf(p.claimedAt)
        return !(at !== null && Date.now() - at < LEASE_MS && p.claimedBy !== dev)
      }
      const take = (p: Ping): Ping => (p.id === id ? { ...p, claimedBy: dev, claimedAt: Date.now() } : p)
      if (id.startsWith("demo-")) {
        const ok = free(pingsRef.current.find((p) => p.id === id))
        if (ok) setDemoPings((prev) => prev.map(take))
        return ok
      }
      if (id.startsWith("share-")) {
        if (mockMode || !me.current.uid) return false
        const ref = doc(db, "sharePings", id.slice("share-".length))
        return runTransaction(db, async (tx) => {
          const snap = await tx.get(ref)
          if (!snap.exists()) return false
          const raw = snap.data() as SharePingDoc
          if (raw.ownerUid !== me.current.uid || raw.status !== "answered") return false
          const oldAt = asMillis(raw.claimedAt) ?? 0
          if (raw.claimedBy && raw.claimedBy !== dev && Date.now() - oldAt < LEASE_MS) return false
          tx.update(ref, { claimedBy: dev, claimedAt: serverTimestamp() })
          return true
        })
      }
      if (mockMode) {
        const cur = readMockPings()
        if (!free(cur.find((p) => p.id === id))) return false
        const updated = cur.map(take)
        writeMockPings(updated)
        setRemotePings(updated)
        return true
      }
      return getDomainBackend("ping").pings.lease(id, dev)
    },
    [mockMode],
  )

  const finalizePing = useCallback(
    async (id: string) => {
      const done = (p: Ping): Ping => (p.id === id ? { ...p, status: "processed" } : p)
      if (id.startsWith("demo-")) {
        setDemoPings((prev) => prev.map(done))
        return
      }
      if (id.startsWith("share-")) {
        if (mockMode || !me.current.uid) return
        const ref = doc(db, "sharePings", id.slice("share-".length))
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(ref)
          if (!snap.exists()) return
          const raw = snap.data() as SharePingDoc
          if (raw.ownerUid === me.current.uid && raw.status === "answered") tx.update(ref, { status: "processed", processedAt: serverTimestamp() })
        })
        return
      }
      if (mockMode) {
        const updated = readMockPings().map(done)
        writeMockPings(updated)
        setRemotePings(updated)
        return
      }
      await getDomainBackend("ping").pings.finalize(id)
    },
    [mockMode],
  )

  const cancelPing = useCallback(
    async (id: string) => {
      if (id.startsWith("demo-")) {
        setDemoPings((prev) => prev.filter((p) => p.id !== id))
        return
      }
      if (id.startsWith("share-")) {
        if (mockMode || !me.current.uid) return
        const ref = doc(db, "sharePings", id.slice("share-".length))
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(ref)
          if (!snap.exists()) return
          const raw = snap.data() as SharePingDoc
          if (raw.ownerUid === me.current.uid && raw.status === "asking") tx.update(ref, { status: "cancelled" })
        })
        return
      }
      if (mockMode) {
        const kept = readMockPings().filter((p) => p.id !== id)
        writeMockPings(kept)
        setRemotePings(kept)
        return
      }
      await getDomainBackend("ping").pings.remove(id)
    },
    [mockMode],
  )

  // Keep history short. Share-link rows can be removed by their owner after processing/cancellation;
  // an unanswered link is deleted only after expiry, and an answered row is retained until processed.
  useEffect(() => {
    if (mockMode || !uid) return
    for (const p of remotePings) if (p.from === uid && daysSince(p.date) > PING_HISTORY_DAYS) getDomainBackend("ping").pings.remove(p.id).catch(() => {})
    for (const p of sharePings) {
      const old = daysSince(p.date) > PING_HISTORY_DAYS
      if (!old || p.from !== uid || !(p.status === "processed" || p.status === "cancelled" || (p.status === "asking" && isExpired(p)))) continue
      deleteDoc(doc(db, "sharePings", p.id.slice("share-".length))).catch(() => {})
    }
  }, [remotePings, sharePings, uid, mockMode])

  const simulateReply = useCallback((mateName: string, items: PingInput[], answer: "yes" | "no") => {
    const ping: Ping = {
      id: `demo-${makeId()}`,
      from: DEMO_ME,
      to: DEMO_MATE,
      fromName: me.current.name || "You",
      toName: mateName,
      participants: [DEMO_ME, DEMO_MATE],
      date: localDate(),
      items: items.map((i) => ({ ...i, answer })),
      status: "answered",
    }
    setDemoPings((prev) => [ping, ...prev])
  }, [])

  const simulateIncoming = useCallback((mateName: string, items: PingInput[]) => {
    const ping: Ping = {
      id: `demo-${makeId()}`,
      from: DEMO_MATE,
      to: DEMO_ME,
      fromName: mateName,
      toName: me.current.name || "You",
      participants: [DEMO_MATE, DEMO_ME],
      date: localDate(),
      items: items.map((i) => ({ ...i, answer: null })),
      status: "asking",
    }
    setDemoPings((prev) => [ping, ...prev])
  }, [])

  pingsRef.current = [...demoPings, ...remotePings, ...sharePings]
  const sent = [...demoPings.filter((p) => p.from === DEMO_ME), ...remotePings.filter((p) => uid !== null && p.from === uid), ...sharePings.filter((p) => uid !== null && p.from === uid)]
  const received = [...demoPings.filter((p) => p.to === DEMO_ME), ...remotePings.filter((p) => uid !== null && p.to === uid)]

  return {
    configured,
    status,
    error,
    uid,
    anonymous,
    name,
    requests,
    sent,
    received,
    addLink: uid && configured && typeof window !== "undefined" ? (() => {
      const origin = shareableAppOrigin(window.location.origin, process.env.NEXT_PUBLIC_APP_URL)
      return origin.ok ? `${origin.origin}/?add=${uid}` : ""
    })() : "",
    enable,
    setName,
    respond,
    cancel,
    makeInvite,
    connectViaUid,
    connectViaInvite,
    trackInviteOpen,
    sendPing,
    createSharePing,
    cancelPing,
    answerPing,
    enableAlerts,
    leasePing,
    finalizePing,
    simulateReply,
    simulateIncoming,
  }
}
