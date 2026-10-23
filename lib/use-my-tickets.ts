"use client"

import { useCallback, useEffect, useState } from "react"
import { getAuth, onAuthStateChanged } from "firebase/auth"
import { app, firebaseConfigured } from "./firebase"
import { watchMyTickets, type FeedbackRecord } from "./feedback"
import { byActivity, fixCheckInDue, isFirstReplyUnseen, isFollowUpUnseen, FIX_CHECK_IN_AFTER_MS } from "./feedback-threads"

const ACK_KEY = "ticketAck" // ticket id -> when this device showed the person the developer's first reply
const SNOOZE_KEY = "ticketSnooze" // ticket id -> when the person said "not now" to the fix check-in

const readMap = (key: string): Record<string, number> => {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(key) || "{}")
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, number>) : {}
  } catch {
    return {}
  }
}
const stamp = (key: string, id: string) => {
  try {
    localStorage.setItem(key, JSON.stringify({ ...readMap(key), [id]: Date.now() }))
  } catch {
    /* private browsing: the prompt may come back sooner, never be lost */
  }
}

/**
 * The signed-in person's tickets, live, and what needs their attention:
 *   firstReply  the developer's first answer to something they sent (a full-screen thank-you, once)
 *   followUps   later answers in a conversation (a red dot on Settings, not a pop-up)
 *   fixDue      a bug the developer answered a day or more ago, worth asking "did it work?"
 */
export function useMyTickets() {
  const [uid, setUid] = useState<string | null>(null)
  const [tickets, setTickets] = useState<FeedbackRecord[]>([])
  const [clock, setClock] = useState(0)

  useEffect(() => {
    if (!firebaseConfigured()) return
    return onAuthStateChanged(getAuth(app), (u) => setUid(u && !u.isAnonymous ? u.uid : null))
  }, [])
  useEffect(() => {
    if (!uid) return void setTickets([])
    return watchMyTickets(uid, (rows) => setTickets([...rows].sort(byActivity)))
  }, [uid])
  // A day passing while the app stays open should still bring the check-in
  useEffect(() => {
    const t = setInterval(() => setClock((n) => n + 1), 30 * 60_000)
    return () => clearInterval(t)
  }, [])

  const acknowledge = useCallback((id: string) => {
    stamp(ACK_KEY, id)
    setClock((n) => n + 1)
  }, [])
  const snooze = useCallback((id: string) => {
    stamp(SNOOZE_KEY, id)
    setClock((n) => n + 1)
  }, [])

  const acks = readMap(ACK_KEY)
  const snoozes = readMap(SNOOZE_KEY)
  void clock
  const now = Date.now()
  const firstReply = tickets.find(isFirstReplyUnseen) ?? null
  const followUps = tickets.filter(isFollowUpUnseen)
  const fixDue = tickets.find((t) => fixCheckInDue(t, acks[t.id] ?? null, now) && !(snoozes[t.id] && now - snoozes[t.id] < FIX_CHECK_IN_AFTER_MS)) ?? null

  return { uid, tickets, firstReply, followUps, fixDue, acknowledge, snooze }
}
