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
  sendPingDoc,
  answerPingDoc,
  removePingDoc,
  sendRequest,
  respondToRequest,
  removeRequest,
  createInvite,
  readInvite,
  magicLink,
} from "./social"
import { localDate } from "./attendance"
import { PING_HISTORY_DAYS, daysSince } from "./pings"

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
  /** Answer a ping a mate sent you: item key -> yes / no */
  answerPing: (id: string, answers: Record<string, "yes" | "no">) => Promise<void>
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

export function useSocial(): SocialApi {
  const mockMode = !socialConfigured()
  const configured = true
  const [status, setStatus] = useState<SocialApi["status"]>(mockMode ? "idle" : "idle")
  const [error, setError] = useState("")
  const [uid, setUid] = useState<string | null>(null)
  const [name, setNameState] = useState("")
  const [requests, setRequests] = useState<FriendRequest[]>([])
  const [remotePings, setRemotePings] = useState<Ping[]>([])
  // Made-up pings from the settings simulator: saved on this device only and never sent anywhere
  const [demoPings, setDemoPings] = useState<Ping[]>([])
  const [demoLoaded, setDemoLoaded] = useState(false)
  const started = useRef(false)
  const unsub = useRef<(() => void) | null>(null)
  const unsubPings = useRef<(() => void) | null>(null)
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

    if (!configured || started.current) return
    started.current = true
    setStatus("connecting")
    ensureSignedIn()
      .then((user) => {
        setUid(user.uid)
        const saved = localStorage.getItem(NAME_KEY) || ""
        setNameState(saved)
        if (saved) saveProfile(user.uid, saved).catch(() => {})
        unsub.current = watchRequests(user.uid, setRequests, (e) => setError(e.message))
        unsubPings.current = watchPings(user.uid, setRemotePings, (e) => setError(e.message))
        localStorage.setItem("socialOn", "1")
        setStatus("ready")
      })
      .catch((e: Error) => {
        started.current = false
        setError(e.message.includes("admin-restricted") || e.message.includes("operation-not-allowed")
          ? "Anonymous sign-in is switched off in your Firebase project."
          : e.message)
        setStatus("error")
      })
  }, [configured, mockMode])

  useEffect(
    () => () => {
      unsub.current?.()
      unsubPings.current?.()
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

  const sendPing = useCallback(
    async (to: { uid: string; name: string }, date: string, items: PingInput[]): Promise<ConnectResult> => {
      const { uid: myUid, name: myName } = me.current
      if (!myUid || !myName) return { ok: false, message: "Enter your name first." }
      const asked: PingItem[] = items.map((i) => ({ key: i.key, subjectId: i.subjectId, name: i.name.slice(0, 60), ...(i.t ? { t: i.t } : {}), answer: null }))
      // Pings only go to accepted mates, and name the connection so the server rules can check it
      const requestId = reqs.current.find((r) => r.status === "accepted" && r.participants.includes(to.uid))?.id
      if (!requestId && !mockMode) return { ok: false, message: `You're not connected with ${to.name} yet.` }
      const done = { ok: true, message: `Asked ${to.name}. You'll get a bubble when they reply.` }
      if (mockMode) {
        // No second device to receive it, so the mock only records it
        const ping: Ping = { id: makeId(), from: myUid, to: to.uid, fromName: myName, toName: to.name, participants: [myUid, to.uid], ...(requestId ? { requestId } : {}), date, items: asked, status: "asking" }
        const next = [ping, ...readMockPings()]
        writeMockPings(next)
        setRemotePings(next)
        return done
      }
      try {
        await sendPingDoc({ uid: myUid, name: myName }, to, date, asked, requestId as string)
        return done
      } catch {
        return { ok: false, message: "Couldn't send that. Try again." }
      }
    },
    [mockMode],
  )

  const answerPing = useCallback(
    async (id: string, answers: Record<string, "yes" | "no">) => {
      const cur = pingsRef.current.find((p) => p.id === id)
      if (!cur) return
      const items = cur.items.map((i) => ({ ...i, answer: answers[i.key] ?? ("no" as const) }))
      const apply = (p: Ping): Ping => (p.id === id ? { ...p, items, status: "answered" } : p)
      if (id.startsWith("demo-")) {
        setDemoPings((prev) => prev.map(apply))
        return
      }
      if (mockMode) {
        const updated = readMockPings().map(apply)
        writeMockPings(updated)
        setRemotePings(updated)
        return
      }
      await answerPingDoc(id, items)
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
      await removePingDoc(id)
    },
    [mockMode],
  )

  // Keep history short: pings you sent that are older than a month are deleted
  useEffect(() => {
    if (mockMode || !uid) return
    for (const p of remotePings) if (p.from === uid && daysSince(p.date) > PING_HISTORY_DAYS) removePingDoc(p.id).catch(() => {})
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
    simulateReply,
    simulateIncoming,
  }
}
