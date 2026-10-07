"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import type { SocialApi } from "./use-social"
import type { Ping } from "./types"
import {
  FOCUS_MESSAGES,
  emptyPresented,
  loadPresented,
  nextEvent,
  pendingCount,
  resolveFocus,
  savePresented,
  type PingEvent,
  type Presented,
} from "./ping-presentation"

/** How long a Ping someone asked for by id is waited for before saying it isn't there (the live connection may still be loading) */
const FOCUS_GRACE_MS = 6000

interface Options {
  social: SocialApi
  /** Off while there is nothing real to show over (demo data on screen, data still loading) */
  enabled: boolean
  /** Said to the person when a Ping they asked to open can't be opened */
  onNotice: (message: string) => void
}

/**
 * Decides which Ping to put on screen: a request waiting for my answer, or the answer to one I sent. It reads the
 * live Pings the app already listens to (no extra reads), and remembers on this device what I have finished with, so
 * the same Ping is never shown twice, however it reached me (live, on opening the app, or from a notification).
 */
export function usePingEvents({ social, enabled, onNotice }: Options) {
  const me = social.uid
  const [presented, setPresented] = useState<Presented>(emptyPresented)
  const [ready, setReady] = useState(false)
  const [deferred, setDeferred] = useState<ReadonlySet<string>>(new Set())
  const [focusId, setFocusId] = useState<string | null>(null)
  const [activeId, setActiveId] = useState<string | null>(null)
  const [holding, setHolding] = useState<PingEvent | null>(null) // an answered request, kept up while its confirmation plays
  const [, bump] = useState(0)
  const noticeRef = useRef(onNotice)
  noticeRef.current = onNotice
  const enableSocial = social.enable

  useEffect(() => {
    setPresented(loadPresented())
    setReady(true)
  }, [])

  // A notification opens the app at /?ping=<id>; if the app is already running the worker sends a message instead
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const id = params.get("ping")
    if (id) {
      setFocusId(id.slice(0, 128))
      params.delete("ping")
      const rest = params.toString()
      window.history.replaceState(null, "", window.location.pathname + (rest ? `?${rest}` : ""))
      enableSocial()
    }
    if (!("serviceWorker" in navigator)) return
    const onMessage = (e: MessageEvent) => {
      if (e.data?.type === "open-ping" && typeof e.data.id === "string") {
        setFocusId(e.data.id.slice(0, 128))
        enableSocial()
      }
    }
    navigator.serviceWorker.addEventListener("message", onMessage)
    return () => navigator.serviceWorker.removeEventListener("message", onMessage)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The developer simulators use stand-in ids ("demo-me") for me; read them as me so they exercise the same screens
  const asMe = (p: Ping): Ping =>
    me && p.id.startsWith("demo-")
      ? { ...p, from: p.from === "demo-me" ? me : p.from, to: p.to === "demo-me" ? me : p.to, participants: p.participants.map((x) => (x === "demo-me" ? me : x)) }
      : p
  const pings = [...social.received, ...social.sent].map(asMe)
  const live = enabled && ready ? nextEvent(pings, me, presented, { focusId, activeId, deferred }) : null
  const event = holding ?? live

  // Once a Ping is on screen it stays the one on screen, and an asked-for Ping has been delivered
  const shownId = event?.ping.id ?? null
  useEffect(() => {
    if (shownId && shownId !== activeId) setActiveId(shownId)
    if (shownId && shownId === focusId) setFocusId(null)
  }, [shownId, activeId, focusId])

  // A Ping someone asked to open that can't be opened: say so, once the live data has had a moment to arrive
  const focusCheck = enabled && ready && focusId && me ? resolveFocus(pings, me, focusId, presented) : null
  const unresolved = focusCheck && !focusCheck.ok ? focusCheck.reason : null
  useEffect(() => {
    if (!focusId || !unresolved) return
    const t = setTimeout(() => {
      noticeRef.current(FOCUS_MESSAGES[unresolved])
      setFocusId(null)
    }, unresolved === "missing" ? FOCUS_GRACE_MS : 0)
    return () => clearTimeout(t)
  }, [focusId, unresolved])

  const remember = useCallback((kind: "incoming" | "result", id: string) => {
    setPresented((prev) => {
      const next = { ...prev, [kind]: { ...prev[kind], [id]: Date.now() } }
      savePresented(next)
      return next
    })
  }, [])

  /** Answer the request on screen. Only a confirmed send counts: the request stays pending otherwise. */
  const answer = useCallback(
    async (answers: Record<string, "yes" | "no">) => {
      if (!event || event.kind !== "incoming") return { ok: false, message: "Nothing to answer." }
      // Keep this request on screen from the moment it is sent: the live list drops it as soon as the answer lands,
      // and the confirmation has to play on the same screen. Let go again if the send doesn't go through.
      setHolding(event)
      const r = await social.answerPing(event.ping.id, answers)
      if (r.ok) remember("incoming", event.ping.id)
      else setHolding(null)
      return r
    },
    [event, social, remember],
  )

  /** The confirmation has played: move on to whatever is next */
  const finish = useCallback(() => setHolding(null), [])

  /** "Later": the request stays pending (and shows again the next time the app opens); it just isn't pushed at me again now */
  const later = useCallback(() => {
    if (!event) return
    setDeferred((d) => new Set(d).add(event.ping.id))
    setActiveId(null)
  }, [event])

  /** The answer to my Ping has been seen */
  const acknowledge = useCallback(() => {
    if (!event || event.kind !== "result") return
    remember("result", event.ping.id)
    setActiveId(null)
  }, [event, remember])

  const alertsOffer =
    typeof Notification !== "undefined" && Notification.permission === "default" && !!me && !me.startsWith("mock-") && "serviceWorker" in navigator
  const enableAlerts = useCallback(async () => {
    const ok = await social.enableAlerts()
    bump((n) => n + 1)
    return ok
  }, [social])

  // The persistent "something is waiting" count (the Mates tab badge). Requests put off with "Later" stay counted.
  const pending = enabled && ready ? pendingCount(pings, me, presented) : 0

  return { event, pending, answer, finish, later, acknowledge, alertsOffer, enableAlerts }
}
