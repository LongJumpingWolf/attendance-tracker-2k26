"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { FriendRequest, Ping, PingItem } from "./types"
import {
  socialConfigured,
  ensureSignedIn,
  saveProfile,
  getProfileName,
  watchRequests,
  watchPings,
  savePushToken,
  sendRequest,
  respondToRequest,
  removeRequest,
  createInvite,
  readInvite,
  magicLink,
} from "./social"
import { localDate } from "./attendance"
import { MAX_PING_ITEMS, PING_HISTORY_DAYS, daysSince, msOf } from "./pings"
import { requestNotificationPermission } from "./notifications"
import { requestFCMToken } from "./firebase"
import { attempt } from "./ping-send"
import { app, db } from "./firebase"
import { getAuth } from "firebase/auth"
import { followIdentity } from "./social-session"
import { announceProfile, completeCarry } from "./identity"
import { answerPing as answerPingOnServer, createPing, finalizePing as finalizeOnServer, leasePing as leaseOnServer, removePing, LEASE_MS } from "./ping-server"
import { forget, idFor, logicalKey } from "./ping-id"
import { deviceId } from "./device"

/** Register this device for ping alerts. Only when notifications are allowed (or asked for), and never fatal. */
async function registerPingAlerts(uid: string, ask: boolean): Promise<boolean> {
  try {
    if (typeof Notification === "undefined") return false
    if (Notification.permission !== "granted" && !(ask && (await requestNotificationPermission()))) return false
    const token = await requestFCMToken()
    if (!token) return false
    await savePushToken(uid, token)
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
  /** Ask a connected mate whether they marked you present in these classes (from your own subject list) */
  sendPing: (to: { uid: string; name: string }, date: string, items: PingInput[]) => Promise<ConnectResult>
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
  const configured = true
  const [status, setStatus] = useState<SocialApi["status"]>(mockMode ? "idle" : "idle")
  const [error, setError] = useState("")
  const [uid, setUid] = useState<string | null>(null)
  const [anonymous, setAnonymous] = useState(true)
  const [name, setNameState] = useState("")
  const [requests, setRequests] = useState<FriendRequest[]>([])
  const [remotePings, setRemotePings] = useState<Ping[]>([])
  // Made-up pings from the settings simulator: saved on this device only and never sent anywhere
  const [demoPings, setDemoPings] = useState<Ping[]>([])
  const [demoLoaded, setDemoLoaded] = useState(false)
  const started = useRef(false)
  const stopFollowing = useRef<(() => void) | null>(null)
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
    const signIn = () =>
      ensureSignedIn()
        .then(() => localStorage.setItem("socialOn", "1"))
        .catch((e: Error) => {
          setError(e.message.includes("admin-restricted") || e.message.includes("operation-not-allowed")
            ? "Anonymous sign-in is switched off in your Firebase project."
            : e.message)
          setStatus("error")
        })
    if (started.current) {
      // Already following the account. If it signed out meanwhile, a visit here gives this browser a fresh account.
      if (me.current.uid === null) void signIn()
      return
    }
    started.current = true
    setStatus("connecting")
    // Whoever is signed in is who the mates, Pings and alerts belong to. When that changes (Google sign-in on a device
    // that already had a profile, signing out) everything follows: the listeners move, the old account's data leaves
    // the screen, and this device's alerts are registered for the new one.
    stopFollowing.current = followIdentity(
      { auth: getAuth(app), db },
      {
        onIdentity: (newUid, anon) => {
          setUid(newUid)
          setAnonymous(anon)
          if (!newUid) {
            setStatus("idle")
            return
          }
          const saved = localStorage.getItem(NAME_KEY) || ""
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
      stopFollowing.current?.()
    },
    [],
  )

  useEffect(() => {
    if (mockMode) {
      setStatus("ready")
      return
    }
    if (configured && localStorage.getItem("socialOn") === "1") enable()
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

    if (me.current.uid) await saveProfile(me.current.uid, clean)
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
          await respondToRequest(existing.id, "accepted")
          return { ok: true, message: `Connected with ${other}.` }
        }
        return { ok: true, message: `Your request to ${other} is already waiting.` }
      }
      await removeRequest(existing.id)
    }

    const targetName = knownName ?? (await getProfileName(targetUid))
    if (!targetName) return { ok: false, message: "That code isn't valid." }
    await sendRequest({ uid: myUid, name: myName }, { uid: targetUid, name: targetName })
    return { ok: true, message: `Request sent to ${targetName}.` }
  }, [mockMode])

  const connectViaUid = useCallback((target: string) => connect(target), [connect])

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

      const invite = await readInvite(token)
      if (!invite) return { ok: false, message: "That link isn't valid." }
      if (invite.expired) return { ok: false, message: "That link has expired. Ask for a new one." }
      return connect(invite.owner, invite.ownerName)
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
    return respondToRequest(id, next)
  }, [mockMode])

  const cancel = useCallback((id: string) => {
    if (mockMode) {
      const stored = readMockStore()
      const updated = stored.requests.filter((r) => r.id !== id)
      writeMockStore({ ...stored, requests: updated })
      setRequests(updated)
      return Promise.resolve()
    }
    return removeRequest(id)
  }, [mockMode])

  const makeInvite = useCallback(async () => {
    const { uid: myUid, name: myName } = me.current
    if (!myUid || !myName) return null

    if (mockMode) {
      const token = `invite-${makeId().slice(0, 10)}`
      const expiresAt = Date.now() + 15 * 60_000
      const stored = readMockStore()
      const invites = { ...stored.invites, [token]: { owner: myUid, ownerName: myName, expiresAt } }
      writeMockStore({ ...stored, invites })
      return { link: `${window.location.origin}/?invite=${token}`, expiresAt }
    }

    const { token, expiresAt } = await createInvite(myUid, myName, 15)
    return { link: magicLink(token), expiresAt }
  }, [mockMode])

  // One send per request at a time: a second tap on the same request joins the first instead of starting another
  const sending = useRef(new Map<string, Promise<ConnectResult>>())

  const sendPing = useCallback(
    async (to: { uid: string; name: string }, date: string, items: PingInput[]): Promise<ConnectResult> => {
      const { uid: myUid, name: myName } = me.current
      if (!myUid || !myName) return { ok: false, message: "Enter your name first." }
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
        const r = await attempt(() => createPing(db, { id, from: { uid: myUid, name: myName }, to, date, items: asked, requestId: requestId as string }))
        if (!r.ok) return { ok: false, message: r.message } // the id is kept, so trying again cannot make a second Ping
        forget(key)
        // First ping is the natural moment to ask: the reply will arrive as an alert
        void registerPingAlerts(myUid, true)
        return done
      })().finally(() => sending.current.delete(key))
      sending.current.set(key, run)
      return run
    },
    [mockMode],
  )

  const answerPing = useCallback(
    async (id: string, answers: Record<string, "yes" | "no">) => {
      const cur = pingsRef.current.find((p) => p.id === id)
      if (!cur) return { ok: false, message: "That Ping isn't available any more." }
      const items = cur.items.map((i) => ({ ...i, answer: answers[i.key] ?? ("no" as const) }))
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
      const r = await attempt(() => answerPingOnServer(db, id, items))
      return r.ok ? done : { ok: false, message: r.message }
    },
    [mockMode],
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
      if (mockMode) {
        const cur = readMockPings()
        if (!free(cur.find((p) => p.id === id))) return false
        const updated = cur.map(take)
        writeMockPings(updated)
        setRemotePings(updated)
        return true
      }
      return leaseOnServer(db, id, dev)
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
      if (mockMode) {
        const updated = readMockPings().map(done)
        writeMockPings(updated)
        setRemotePings(updated)
        return
      }
      await finalizeOnServer(db, id)
    },
    [mockMode],
  )

  const cancelPing = useCallback(
    async (id: string) => {
      if (id.startsWith("demo-")) {
        setDemoPings((prev) => prev.filter((p) => p.id !== id))
        return
      }
      if (mockMode) {
        const kept = readMockPings().filter((p) => p.id !== id)
        writeMockPings(kept)
        setRemotePings(kept)
        return
      }
      await removePing(db, id)
    },
    [mockMode],
  )

  // Keep history short: pings you sent that are older than a month are deleted
  useEffect(() => {
    if (mockMode || !uid) return
    for (const p of remotePings) if (p.from === uid && daysSince(p.date) > PING_HISTORY_DAYS) removePing(db, p.id).catch(() => {})
  }, [remotePings, uid, mockMode])

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

  pingsRef.current = [...demoPings, ...remotePings]
  const sent = [...demoPings.filter((p) => p.from === DEMO_ME), ...remotePings.filter((p) => uid !== null && p.from === uid)]
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
    addLink: uid ? `${window.location.origin}/?add=${uid}` : "",
    enable,
    setName,
    respond,
    cancel,
    makeInvite,
    connectViaUid,
    connectViaInvite,
    sendPing,
    cancelPing,
    answerPing,
    enableAlerts,
    leasePing,
    finalizePing,
    simulateReply,
    simulateIncoming,
  }
}
