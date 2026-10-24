"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import Link from "next/link"
import { getAuth, onAuthStateChanged } from "firebase/auth"
import { ArrowClockwise, DownloadSimple, SignIn } from "@phosphor-icons/react"
import { app } from "@/lib/firebase"
import { confirmSwitch, signInWithGoogle } from "@/lib/account"
import { getDeveloperProductLinkEvents, LINK_EVENT_LIMIT, type ProductLinkEvent, type ProductLinkSource } from "@/lib/link-analytics"
import { getDeveloperProductUsageEvents, USAGE_EVENT_LIMIT, type ProductUsageEvent, type UsageEventName, type UsageScreen } from "@/lib/usage-analytics"
import { buildLinkRows, computeLinkMetrics, computeUsageCore, eventCoverage, localDayKey, median, startOfLocalWeek, uniqueUsersWithin, windowIsIncomplete } from "@/lib/analytics-metrics"

const DEVELOPER_EMAIL = (process.env.NEXT_PUBLIC_DEVELOPER_EMAIL || "adityavw2006@gmail.com").toLowerCase()
type RangeKey = "24h" | "7d" | "30d" | "90d"
type SourceKey = "all" | ProductLinkSource
type TrendBucket = { label: string; start: number; end: number; created: number; opened: number; completed: number; events: number }
type UsageTrendBucket = { label: string; start: number; end: number; users: Set<string>; sessions: Set<string>; actions: number }
const RANGE_MS: Record<RangeKey, number> = { "24h": 24 * 60 * 60 * 1000, "7d": 7 * 24 * 60 * 60 * 1000, "30d": 30 * 24 * 60 * 60 * 1000, "90d": 90 * 24 * 60 * 60 * 1000 }
const RANGE_LABEL: Record<RangeKey, string> = { "24h": "Last 24 hours", "7d": "Last 7 days", "30d": "Last 30 days", "90d": "Last 90 days" }
const csvQ = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`
const timestampMs = (v: ProductLinkEvent["createdAt"]): number => {
  if (v && typeof v === "object" && "toDate" in v && typeof v.toDate === "function") return v.toDate().getTime()
  if (v instanceof Date) return v.getTime()
  return 0
}
const dateText = (ms: number) => ms ? new Date(ms).toLocaleString() : "—"
const dateShort = (ms: number) => new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" })
const timeShort = (ms: number) => new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
const percent = (n: number, d: number) => d > 0 ? `${Math.round((n / d) * 100)}%` : "—"
const compactDuration = (ms: number) => {
  if (!Number.isFinite(ms) || ms < 0) return "—"
  const minutes = Math.round(ms / 60000)
  if (minutes < 60) return `${minutes} min`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 48) return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  return `${days}d ${hours % 24}h`
}
const sourceName = (source: ProductLinkSource) => source === "mate-invite" ? "Mate invite" : "WhatsApp Ping"
const eventName = (kind: ProductLinkEvent["kind"]) => ({ created: "Created", opened: "Opened", used: "Invite used", answered: "Ping answered" })[kind]
const usageEventName = (kind: UsageEventName) => ({ app_open: "App opens", screen_view: "Main screen views", settings_open: "Settings opens", attendance_mark: "Attendance marks", attendance_clear: "Attendance clears", scan_checkin: "Scan check-ins", subject_create: "Subjects added", subject_update: "Subjects edited", subject_delete: "Subjects deleted", task_create: "Tasks added", task_update: "Tasks edited", task_complete: "Tasks completed", task_reopen: "Tasks reopened", task_delete: "Tasks deleted" })[kind]
const usageScreenName = (screen: ProductUsageEvent["screen"]) => ({ today: "Today", subjects: "Subjects", calendar: "Calendar", mates: "Mates", settings: "Settings", scanner: "Scan check-in" })[screen]
const isCompletion = (e: ProductLinkEvent) => e.kind === "used" || e.kind === "answered"

export default function DeveloperAnalytics() {
  const [user, setUser] = useState<ReturnType<typeof getAuth>["currentUser"]>(null)
  const [authReady, setAuthReady] = useState(false)
  const [events, setEvents] = useState<ProductLinkEvent[]>([])
  const [usageEvents, setUsageEvents] = useState<ProductUsageEvent[]>([])
  const [linksTruncated, setLinksTruncated] = useState(false)
  const [usageTruncated, setUsageTruncated] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState("")
  const [usageError, setUsageError] = useState("")
  const [filter, setFilter] = useState("")
  const [range, setRange] = useState<RangeKey>("30d")
  const [source, setSource] = useState<SourceKey>("all")
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<"overview" | "links" | "events" | "usage" | "insights" | "visitors">("overview")
  const auth = getAuth(app)
  const isAdmin = Boolean(user && !user.isAnonymous && user.emailVerified && user.email?.toLowerCase() === DEVELOPER_EMAIL)
  const needsSignIn = authReady && (!user || user.isAnonymous)

  const refresh = useCallback(async () => {
    if (!isAdmin) {
      setEvents([])
      setUsageEvents([])
      setUsageError("")
      setLoading(false)
      return
    }
    setLoading(true)
    setError("")
    setUsageError("")
    try {
      const [linkResult, usageResult] = await Promise.allSettled([getDeveloperProductLinkEvents(), getDeveloperProductUsageEvents()])
      if (linkResult.status === "rejected") throw linkResult.reason
      setEvents(linkResult.value.events)
      setLinksTruncated(linkResult.value.truncated)
      if (usageResult.status === "fulfilled") {
        setUsageEvents(usageResult.value.events)
        setUsageTruncated(usageResult.value.truncated)
      } else {
        setUsageEvents([])
        setUsageTruncated(false)
        setUsageError(usageResult.reason instanceof Error ? usageResult.reason.message : "Usage analytics could not be read. Publish the latest Firestore rules, then refresh.")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load link analytics. Check that Firestore rules were published to the correct Firebase project.")
    } finally {
      setLoading(false)
    }
  }, [isAdmin])

  useEffect(() => onAuthStateChanged(auth, (next) => {
    setUser(next)
    setAuthReady(true)
  }), [auth])

  useEffect(() => {
    if (!authReady) return
    const t = window.setTimeout(() => { void refresh() }, 0)
    return () => window.clearTimeout(t)
  }, [authReady, refresh])

  const signIn = async () => {
    setBusy(true)
    setError("")
    try {
      const r = await signInWithGoogle()
      if (r.kind === "error") setError(r.message)
      if (r.kind === "confirm") {
        const problem = await confirmSwitch(r.plan)
        if (problem) setError(problem)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed.")
    } finally {
      setBusy(false)
    }
  }

  const scope = useMemo(() => {
    const cutoff = Date.now() - RANGE_MS[range]
    return events.filter((e) => {
      const at = timestampMs(e.createdAt)
      return at > 0 && at >= cutoff && (source === "all" || e.source === source)
    })
  }, [events, range, source])

  const rows = useMemo(() => buildLinkRows(scope), [scope])

  const visibleRows = useMemo(() => {
    const q = filter.trim().toLowerCase()
    if (!q) return rows
    return rows.filter((r) => [r.fromName, r.recipientName, r.ownerUid, r.linkId, sourceName(r.source)].some((v) => v.toLowerCase().includes(q)))
  }, [rows, filter])

  const metrics = useMemo(() => computeLinkMetrics(rows, scope), [rows, scope])

  const trend = useMemo<TrendBucket[]>(() => {
    const duration = RANGE_MS[range]
    const count = range === "24h" ? 12 : range === "7d" ? 7 : range === "30d" ? 10 : 13
    const now = Date.now()
    const start = now - duration
    const step = duration / count
    const buckets: TrendBucket[] = Array.from({ length: count }, (_, i) => {
      const begin = start + i * step
      const end = i === count - 1 ? now : begin + step
      const label = range === "24h" ? timeShort(begin) : dateShort(begin)
      return { label, start: begin, end, created: 0, opened: 0, completed: 0, events: 0 }
    })
    for (const e of scope) {
      const at = timestampMs(e.createdAt)
      const idx = Math.min(count - 1, Math.max(0, Math.floor((at - start) / step)))
      const bucket = buckets[idx]
      if (!bucket || at < start || at > now) continue
      bucket.events += 1
      if (e.kind === "created") bucket.created += 1
      if (e.kind === "opened") bucket.opened += 1
      if (isCompletion(e)) bucket.completed += 1
    }
    return buckets
  }, [scope, range])

  const kindCounts = useMemo(() => {
    const map = new Map<ProductLinkEvent["kind"], number>([["created", 0], ["opened", 0], ["used", 0], ["answered", 0]])
    for (const e of scope) map.set(e.kind, (map.get(e.kind) || 0) + 1)
    return [...map.entries()]
  }, [scope])

  const usageScope = useMemo(() => {
    const cutoff = Date.now() - RANGE_MS[range]
    return usageEvents.filter((e) => {
      const at = timestampMs(e.createdAt)
      return at > 0 && at >= cutoff
    })
  }, [usageEvents, range])

  const usageMetrics = useMemo(() => {
    const now = Date.now()
    const core = computeUsageCore(usageScope)
    const eventCounts = new Map<UsageEventName, number>()
    for (const e of usageScope) eventCounts.set(e.event, (eventCounts.get(e.event) || 0) + 1)
    const screenCounts = new Map<ProductUsageEvent["screen"], number>()
    for (const e of usageScope) {
      if (e.event === "screen_view" || e.event === "settings_open") {
        screenCounts.set(e.screen, (screenCounts.get(e.screen) || 0) + 1)
      }
    }
    const actions = [...eventCounts.entries()]
      .filter(([event]) => !["app_open", "screen_view", "settings_open"].includes(event))
      .sort((a, b) => b[1] - a[1])
    const screenPopularity = [...screenCounts.entries()].sort((a, b) => b[1] - a[1])
    const featureGroups = [
      { label: "Attendance logging", matches: (e: ProductUsageEvent) => e.event === "attendance_mark" || e.event === "attendance_clear" },
      { label: "QR / NFC check-in", matches: (e: ProductUsageEvent) => e.event === "scan_checkin" },
      { label: "Subject management", matches: (e: ProductUsageEvent) => ["subject_create", "subject_update", "subject_delete"].includes(e.event) },
      { label: "Tasks and deadlines", matches: (e: ProductUsageEvent) => ["task_create", "task_update", "task_complete", "task_reopen", "task_delete"].includes(e.event) },
      { label: "Mates screen visits", matches: (e: ProductUsageEvent) => e.event === "screen_view" && e.screen === "mates" },
      { label: "Settings visits", matches: (e: ProductUsageEvent) => e.event === "settings_open" },
    ]
    const featureAdoption = featureGroups.map((group) => {
      const matching = usageScope.filter(group.matches)
      return { label: group.label, users: new Set(matching.map((e) => e.actorUid)).size, events: matching.length }
    })
    const weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    const weekStats = weekdays.map((label) => ({ label, events: 0, users: new Set<string>() }))
    const hourStats = Array.from({ length: 24 }, (_, hour) => ({ hour, events: 0, users: new Set<string>() }))
    for (const e of usageScope) {
      const at = timestampMs(e.createdAt)
      const date = new Date(at)
      const weekdayIndex = (date.getDay() + 6) % 7
      weekStats[weekdayIndex].events += 1
      weekStats[weekdayIndex].users.add(e.actorUid)
      hourStats[date.getHours()].events += 1
      hourStats[date.getHours()].users.add(e.actorUid)
    }
    return {
      dau: uniqueUsersWithin(usageEvents, RANGE_MS["24h"], now),
      wau: uniqueUsersWithin(usageEvents, RANGE_MS["7d"], now),
      mau: uniqueUsersWithin(usageEvents, RANGE_MS["30d"], now),
      activeUsers: core.activeUsers,
      sessions: core.sessions,
      repeatUsers: core.repeatUsers,
      appOpens: eventCounts.get("app_open") || 0,
      screenViews: (eventCounts.get("screen_view") || 0) + (eventCounts.get("settings_open") || 0),
      attendanceActions: (eventCounts.get("attendance_mark") || 0) + (eventCounts.get("attendance_clear") || 0),
      subjectActions: ["subject_create", "subject_update", "subject_delete"].reduce((n, k) => n + (eventCounts.get(k as UsageEventName) || 0), 0),
      taskActions: ["task_create", "task_update", "task_complete", "task_reopen", "task_delete"].reduce((n, k) => n + (eventCounts.get(k as UsageEventName) || 0), 0),
      scanActions: eventCounts.get("scan_checkin") || 0,
      actionCount: actions.reduce((n, [, count]) => n + count, 0),
      eventCounts,
      screenPopularity,
      featureAdoption,
      weekStats,
      hourStats,
      actions,
    }
  }, [usageEvents, usageScope])

  const usageTrend = useMemo<UsageTrendBucket[]>(() => {
    const duration = RANGE_MS[range]
    const count = range === "24h" ? 12 : range === "7d" ? 7 : range === "30d" ? 10 : 13
    const now = Date.now()
    const start = now - duration
    const step = duration / count
    const buckets: UsageTrendBucket[] = Array.from({ length: count }, (_, i) => {
      const begin = start + i * step
      return { label: range === "24h" ? timeShort(begin) : dateShort(begin), start: begin, end: i === count - 1 ? now : begin + step, users: new Set<string>(), sessions: new Set<string>(), actions: 0 }
    })
    const baseEvents = usageEvents.filter((e) => {
      const at = timestampMs(e.createdAt)
      return at > 0 && at >= start && at <= now
    })
    for (const e of baseEvents) {
      const at = timestampMs(e.createdAt)
      const idx = Math.min(count - 1, Math.max(0, Math.floor((at - start) / step)))
      const bucket = buckets[idx]
      if (!bucket) continue
      bucket.users.add(e.actorUid)
      bucket.sessions.add(e.sessionId)
      if (!["app_open", "screen_view", "settings_open"].includes(e.event)) bucket.actions += 1
    }
    return buckets
  }, [usageEvents, range])


  const deepInsights = useMemo(() => {
    const dayMs = 24 * 60 * 60 * 1000
    const now = Date.now()
    const actionEvents = new Set<UsageEventName>([
      "attendance_mark", "attendance_clear", "scan_checkin",
      "subject_create", "subject_update", "subject_delete",
      "task_create", "task_update", "task_complete", "task_reopen", "task_delete",
    ])
    const datedScope = usageScope
      .map((event) => ({ event, at: timestampMs(event.createdAt) }))
      .filter((item) => item.at > 0 && item.at <= now)

    const users = new Map<string, {
      actions: number
      events: number
      sessions: Set<string>
      days: Set<string>
      screens: Set<UsageScreen>
    }>()
    const sessions = new Map<string, {
      times: number[]
      hasOpen: boolean
      hasScreen: boolean
      hasAction: boolean
    }>()
    const screenSequences = new Map<string, Array<{ at: number; screen: UsageScreen }>>()
    const timesByUser = new Map<string, number[]>()
    const actionTimesByUser = new Map<string, number[]>()

    for (const item of datedScope) {
      const e = item.event
      const sessionKey = e.actorUid + "::" + e.sessionId
      const row = users.get(e.actorUid) || {
        actions: 0, events: 0, sessions: new Set<string>(), days: new Set<string>(), screens: new Set<UsageScreen>(),
      }
      row.events += 1
      row.sessions.add(sessionKey)
      row.days.add(localDayKey(item.at))
      if (e.event === "screen_view" || e.event === "settings_open") row.screens.add(e.screen)
      if (actionEvents.has(e.event)) row.actions += 1
      users.set(e.actorUid, row)

      const session = sessions.get(sessionKey) || { times: [] as number[], hasOpen: false, hasScreen: false, hasAction: false }
      session.times.push(item.at)
      if (e.event === "app_open") session.hasOpen = true
      if (e.event === "screen_view" || e.event === "settings_open") {
        session.hasScreen = true
        const sequence = screenSequences.get(sessionKey) || []
        sequence.push({ at: item.at, screen: e.screen })
        screenSequences.set(sessionKey, sequence)
      }
      if (actionEvents.has(e.event)) session.hasAction = true
      sessions.set(sessionKey, session)
    }

    for (const e of usageEvents) {
      const at = timestampMs(e.createdAt)
      if (!at || at > now) continue
      const times = timesByUser.get(e.actorUid) || []
      times.push(at)
      timesByUser.set(e.actorUid, times)
      if (actionEvents.has(e.event)) {
        const actions = actionTimesByUser.get(e.actorUid) || []
        actions.push(at)
        actionTimesByUser.set(e.actorUid, actions)
      }
    }
    for (const times of timesByUser.values()) times.sort((a, b) => a - b)
    for (const times of actionTimesByUser.values()) times.sort((a, b) => a - b)

    const currentActionCount = datedScope.filter((item) => actionEvents.has(item.event.event)).length
    const actionCounts = [...users.values()].map((u) => u.actions).sort((a, b) => a - b)
    const medianActionsPerUser = median(actionCounts) ?? 0
    const sessionRows = [...sessions.values()]
    const startedSessions = sessionRows.filter((session) => session.hasOpen).length
    const browsedSessions = sessionRows.filter((session) => session.hasOpen && session.hasScreen).length
    const activatedSessions = sessionRows.filter((session) => session.hasOpen && session.hasScreen && session.hasAction).length
    const durations = sessionRows
      .filter((session) => session.times.length >= 2)
      .map((session) => Math.max(...session.times) - Math.min(...session.times))
      .filter((duration) => duration >= 0 && duration <= 24 * 60 * 60 * 1000)
      .sort((a, b) => a - b)
    const medianSessionMs = median(durations)

    const segments = [
      { label: "Browsing only", hint: "0 feature actions", matches: (n: number) => n === 0 },
      { label: "Light", hint: "1–2 feature actions", matches: (n: number) => n >= 1 && n <= 2 },
      { label: "Regular", hint: "3–9 feature actions", matches: (n: number) => n >= 3 && n <= 9 },
      { label: "Power", hint: "10+ feature actions", matches: (n: number) => n >= 10 },
    ].map((segment) => ({
      label: segment.label,
      hint: segment.hint,
      users: actionCounts.filter(segment.matches).length,
    }))

    const transitionCounts = new Map<string, number>()
    for (const sequence of screenSequences.values()) {
      sequence.sort((a, b) => a.at - b.at)
      for (let i = 1; i < sequence.length; i++) {
        const previous = sequence[i - 1]
        const next = sequence[i]
        if (!previous || !next || previous.screen === next.screen) continue
        const label = usageScreenName(previous.screen) + " → " + usageScreenName(next.screen)
        transitionCounts.set(label, (transitionCounts.get(label) || 0) + 1)
      }
    }
    const topTransitions = [...transitionCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)

    const firstSeen = new Map<string, number>()
    for (const [uid, times] of timesByUser.entries()) {
      if (times.length) firstSeen.set(uid, times[0]!)
    }
    const retentionFor = (uids: string[], days: number) => {
      const eligible = uids.filter((uid) => {
        const first = firstSeen.get(uid)
        return first !== undefined && now >= first + (days + 1) * dayMs
      })
      const returned = eligible.filter((uid) => {
        const first = firstSeen.get(uid)!
        return (timesByUser.get(uid) || []).some((at) => at >= first + days * dayMs && at < first + (days + 1) * dayMs)
      }).length
      return { eligible: eligible.length, returned, rate: eligible.length ? Math.round(returned / eligible.length * 100) : null }
    }
    const currentWeek = startOfLocalWeek(now)
    // Weeks are stepped through the calendar, not by 7 x 24 hours, so a clock change never moves a week's edge
    const weekStartsBack = (n: number) => { const d = new Date(currentWeek); d.setDate(d.getDate() - n * 7); return d.getTime() }
    const cohorts = Array.from({ length: 8 }, (_, i) => weekStartsBack(7 - i)).map((start) => {
      const end = (() => { const d = new Date(start); d.setDate(d.getDate() + 7); return d.getTime() })()
      const uids = [...firstSeen.entries()]
        .filter(([, first]) => first >= start && first < end)
        .map(([uid]) => uid)
      const endLabel = new Date(end - 1).toLocaleDateString(undefined, { month: "short", day: "numeric" })
      const startLabel = new Date(start).toLocaleDateString(undefined, { month: "short", day: "numeric" })
      return {
        start,
        label: startLabel + "–" + endLabel,
        users: uids.length,
        d1: retentionFor(uids, 1),
        d7: retentionFor(uids, 7),
        d30: retentionFor(uids, 30),
      }
    }).filter((cohort) => cohort.users > 0)

    const matureActivationUsers = [...firstSeen.entries()].filter(([, first]) => now >= first + 7 * dayMs)
    const activatedUsers = matureActivationUsers.filter(([uid, first]) =>
      (actionTimesByUser.get(uid) || []).some((at) => at >= first && at < first + 7 * dayMs),
    )
    const activationTimes = matureActivationUsers
      .map(([uid, first]) => {
        const firstAction = (actionTimesByUser.get(uid) || []).find((at) => at >= first && at < first + 7 * dayMs)
        return firstAction === undefined ? null : firstAction - first
      })
      .filter((duration): duration is number => duration !== null && duration >= 0)
      .sort((a, b) => a - b)

    const duration = RANGE_MS[range]
    const comparisonAvailable = duration < RANGE_MS["90d"]
    const previousStart = now - 2 * duration
    const previousEnd = now - duration
    const prior = usageEvents
      .map((event) => ({ event, at: timestampMs(event.createdAt) }))
      .filter((item) => item.at >= previousStart && item.at < previousEnd && item.at > 0)
    const priorUsers = new Set(prior.map((item) => item.event.actorUid))
    const priorSessions = new Set(prior.map((item) => item.event.actorUid + "::" + item.event.sessionId))
    const priorActions = prior.filter((item) => actionEvents.has(item.event.event)).length
    const change = (current: number, previous: number) => previous > 0 ? Math.round((current - previous) / previous * 100) : null

    return {
      activeUsers: users.size,
      currentEvents: datedScope.length,
      currentActionCount,
      sessions: sessions.size,
      avgActionsPerUser: users.size ? Math.round(currentActionCount / users.size * 10) / 10 : 0,
      medianActionsPerUser,
      avgSessionsPerUser: users.size ? Math.round([...users.values()].reduce((sum, user) => sum + user.sessions.size, 0) / users.size * 10) / 10 : 0,
      avgEventsPerSession: sessions.size ? Math.round(datedScope.length / sessions.size * 10) / 10 : 0,
      medianSessionMs,
      startedSessions,
      browsedSessions,
      activatedSessions,
      browseRate: startedSessions ? Math.round(browsedSessions / startedSessions * 100) : null,
      sessionActivationRate: browsedSessions ? Math.round(activatedSessions / browsedSessions * 100) : null,
      segments,
      topTransitions,
      cohorts,
      activationEligible: matureActivationUsers.length,
      activationCount: activatedUsers.length,
      activationRate: matureActivationUsers.length ? Math.round(activatedUsers.length / matureActivationUsers.length * 100) : null,
      medianTimeToActivateMs: median(activationTimes),
      comparisonAvailable,
      previousUsers: priorUsers.size,
      previousSessions: priorSessions.size,
      previousActions: priorActions,
      userChange: change(users.size, priorUsers.size),
      sessionChange: change(sessions.size, priorSessions.size),
      actionChange: change(currentActionCount, priorActions),
      maxSegment: Math.max(1, ...segments.map((segment) => segment.users)),
      maxTransition: Math.max(1, ...topTransitions.map(([, count]) => count)),
      maxCohortUsers: Math.max(1, ...cohorts.map((cohort) => cohort.users)),
    }
  }, [usageEvents, usageScope, range])


  const visitorInsights = useMemo(() => {
    const now = Date.now()
    const cutoff = now - RANGE_MS[range]
    const firstSeenByBrowser = new Map<string, number>()
    for (const event of usageEvents) {
      if (!event.visitorId) continue
      const at = timestampMs(event.createdAt)
      if (!at || at > now) continue
      const first = firstSeenByBrowser.get(event.visitorId)
      if (first === undefined || at < first) firstSeenByBrowser.set(event.visitorId, at)
    }
    const actionEvents = new Set<UsageEventName>([
      "attendance_mark", "attendance_clear", "scan_checkin",
      "subject_create", "subject_update", "subject_delete",
      "task_create", "task_update", "task_complete", "task_reopen", "task_delete",
    ])
    const sessionMap = new Map<string, {
      openedAt: number
      visitorId?: string
      deviceType?: string
      browserFamily?: string
      screenSet: Set<string>
      hasAction: boolean
      hasOpen: boolean
    }>()
    for (const event of usageScope) {
      const at = timestampMs(event.createdAt)
      if (!at || at > now) continue
      const key = event.actorUid + "::" + event.sessionId
      const row = sessionMap.get(key) || {
        openedAt: 0,
        screenSet: new Set<string>(),
        hasAction: false,
        hasOpen: false,
      }
      if (event.event === "app_open") {
        row.hasOpen = true
        if (!row.openedAt || at < row.openedAt) row.openedAt = at
      }
      if (event.visitorId) row.visitorId = event.visitorId
      if (event.deviceType) row.deviceType = event.deviceType
      if (event.browserFamily) row.browserFamily = event.browserFamily
      if (event.event === "screen_view" || event.event === "settings_open") row.screenSet.add(event.screen)
      if (actionEvents.has(event.event)) row.hasAction = true
      sessionMap.set(key, row)
    }
    const visits = [...sessionMap.values()].filter((session) => session.hasOpen && session.openedAt >= cutoff)
    const knownVisitors = new Set(visits.map((session) => session.visitorId).filter((id): id is string => Boolean(id)))
    let newVisitors = 0
    let returningVisitors = 0
    let unknownAgeVisitors = 0
    for (const visitorId of knownVisitors) {
      const first = firstSeenByBrowser.get(visitorId)
      if (first === undefined) unknownAgeVisitors += 1
      else if (first >= cutoff) newVisitors += 1
      else returningVisitors += 1
    }
    const bounced = visits.filter((session) => !session.hasAction && session.screenSet.size <= 1).length
    const interacted = visits.filter((session) => session.hasAction).length
    const dist = (key: "deviceType" | "browserFamily") => {
      const counts = new Map<string, number>()
      for (const session of visits) {
        const label = session[key] || "Legacy / unknown"
        counts.set(label, (counts.get(label) || 0) + 1)
      }
      return [...counts.entries()].sort((a, b) => b[1] - a[1])
    }
    const trend = usageTrend.map((bucket) => {
      const bucketVisits = visits.filter((session) => session.openedAt >= bucket.start && session.openedAt < bucket.end)
      return {
        label: bucket.label,
        start: bucket.start,
        visits: bucketVisits.length,
        visitors: new Set(bucketVisits.map((session) => session.visitorId).filter(Boolean)).size,
        bounced: bucketVisits.filter((session) => !session.hasAction && session.screenSet.size <= 1).length,
      }
    })
    const visitorTotal = newVisitors + returningVisitors
    return {
      visits: visits.length,
      uniqueBrowsers: knownVisitors.size,
      newVisitors,
      returningVisitors,
      unknownAgeVisitors,
      newVisitorRate: visitorTotal ? Math.round(newVisitors / visitorTotal * 100) : null,
      bounceCount: bounced,
      bounceRate: visits.length ? Math.round(bounced / visits.length * 100) : null,
      interactedSessions: interacted,
      deviceMix: dist("deviceType"),
      browserMix: dist("browserFamily"),
      legacyVisits: visits.filter((session) => !session.visitorId || !session.deviceType || !session.browserFamily).length,
      trend,
      maxVisits: Math.max(1, ...trend.map((bucket) => bucket.visits)),
      maxDeviceVisits: Math.max(1, ...dist("deviceType").map((pair) => pair[1])),
      maxBrowserVisits: Math.max(1, ...dist("browserFamily").map((pair) => pair[1])),
    }
  }, [usageEvents, usageScope, usageTrend, range])

  const usageCoverage = useMemo(() => eventCoverage(usageEvents.map((e) => timestampMs(e.createdAt)), usageTruncated), [usageEvents, usageTruncated])
  const linkCoverage = useMemo(() => eventCoverage(events.map((e) => timestampMs(e.createdAt)), linksTruncated), [events, linksTruncated])
  // Nothing is shown as complete when it isn't: a window that reaches back past the oldest loaded event is too low
  const windowStart = Date.now() - RANGE_MS[range]
  const incompleteNotes = [
    windowIsIncomplete(usageCoverage, windowStart) && `usage events: only the newest ${USAGE_EVENT_LIMIT.toLocaleString()} are loaded (back to ${dateShort(usageCoverage.completeSinceMs!)})`,
    windowIsIncomplete(linkCoverage, windowStart) && `link events: only the newest ${LINK_EVENT_LIMIT.toLocaleString()} are loaded (back to ${dateShort(linkCoverage.completeSinceMs!)})`,
  ].filter(Boolean) as string[]
  const retentionUnreliable = usageCoverage.truncated
  const maxUsageUsers = Math.max(1, ...usageTrend.map((b) => b.users.size))
  const maxScreenCount = Math.max(1, ...usageMetrics.screenPopularity.map(([, count]) => count))
  const maxUsageActionCount = Math.max(1, ...usageMetrics.actions.map(([, count]) => count))

  const exportUsageEvents = () => exportFile("attendance-tracker-app-usage.csv", [
    ["Occurred at", "Event", "Screen", "Pseudonymous account ID", "Tab session ID", "Random browser ID", "Coarse device type", "Browser family"],
    ...usageScope.slice().sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt)).map((e) => [dateText(timestampMs(e.createdAt)), usageEventName(e.event), usageScreenName(e.screen), e.actorUid, e.sessionId, e.visitorId || "", e.deviceType || "", e.browserFamily || ""]),
  ])

  const exportFile = (filename: string, lines: unknown[][]) => {
    const csv = lines.map((line) => line.map(csvQ).join(",")).join("\r\n")
    const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }))
    const a = document.createElement("a")
    a.href = url
    a.download = filename
    a.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const exportLinks = () => exportFile("attendance-tracker-link-analytics.csv", [
    ["Link type", "Created at", "Sender name", "Sender account ID", "Recipient name", "Open events", "Opened at", "Invite used", "Ping answered", "Minutes to completion", "Link reference"],
    ...visibleRows.map((r) => [sourceName(r.source), dateText(r.createdAtMs), r.fromName, r.ownerUid, r.recipientName, r.opens, dateText(r.openedAtMs), r.used ? "Yes" : "No", r.answered ? "Yes" : "No", r.completedAtMs && r.createdAtMs ? Math.round((r.completedAtMs - r.createdAtMs) / 60000) : "", r.linkId]),
  ])

  const exportEvents = () => exportFile("attendance-tracker-raw-events.csv", [
    ["Occurred at", "Event", "Source", "Link reference", "Sender name", "Sender account ID", "Recipient name"],
    ...scope.slice().sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt)).map((e) => [dateText(timestampMs(e.createdAt)), eventName(e.kind), sourceName(e.source), e.linkId, e.fromName, e.ownerUid, e.recipientName]),
  ])

  const maxTrend = Math.max(1, ...trend.flatMap((b) => [b.created, b.opened, b.completed]))
  const maxKind = Math.max(1, ...kindCounts.map(([, n]) => n))
  const topSenders = metrics.senders.slice(0, 8)
  const statusLabel = !authReady ? "Checking saved sign-in…" : isAdmin ? "Developer access active" : user?.isAnonymous ? "Anonymous app session" : user ? "Different account signed in" : "Not signed in"

  return (
    <main className="min-h-screen bg-background text-foreground p-4 sm:p-8">
      <div className="max-w-7xl mx-auto space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs uppercase tracking-widest text-mute">College Tracker · Developer tools</p>
            <h1 className="text-3xl font-bold">Product analytics</h1>
            <p className="text-sm text-mute mt-1">Link acquisition, engagement, completion funnels and usage trends.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/developer-feedback" className="rounded-xl bg-secondary px-4 py-2 text-sm font-semibold">Feedback insights ↗</Link>
            <Link href="/" className="rounded-xl bg-secondary px-4 py-2 text-sm font-semibold">Open app</Link>
          </div>
        </header>

        <section className="rounded-2xl bg-card p-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className="font-semibold text-sm">{statusLabel}</p>
            <p className="text-xs text-mute mt-1">{!authReady ? "Checking Firebase sign-in…" : !user ? "No signed-in account was restored." : user.isAnonymous ? "An anonymous app session is active." : isAdmin ? "Developer account verified." : "A Google account is signed in, but it is not authorized for this page."}</p>
            <p className="text-xs text-mute mt-1">This is a private, developer-only dashboard. Regular app users cannot access it.</p>
          </div>
          {isAdmin && <span className="rounded-full bg-good/15 text-good px-3 py-1 text-xs font-semibold">Authorized</span>}
        </section>

        {needsSignIn && <section className="rounded-2xl bg-card p-5 space-y-3">
          <p className="font-semibold">Developer-only access</p>
          <p className="text-sm text-mute">This page is for the app developer only. Signing in with your own Google account will not grant access unless you are using the developer’s authorized account. Regular Attendance Tracker users cannot use this dashboard.</p>
          <button disabled={busy} onClick={() => void signIn()} className="rounded-xl bg-ink text-paper px-4 py-3 font-semibold inline-flex items-center gap-2 disabled:opacity-50"><SignIn size={18}/>{busy ? "Signing in…" : "Sign in with developer account"}</button>
          <Link href="/?openSettings=sync" className="block text-sm underline text-mute">Having trouble? Open sign-in in app Settings.</Link>
        </section>}

        {authReady && user && !user.isAnonymous && !isAdmin && <section className="rounded-2xl bg-card p-5 space-y-2">
          <p className="font-semibold">Developer-only page — this sign-in will not work for regular users</p>
          <p className="text-sm text-mute">Your current Google account is not authorized for the developer dashboard. Signing in again with this same account will not grant access. Only the app developer’s authorized account can open these analytics. To protect synced app data, use Settings → Sync account to change accounts safely if needed.</p>
          <Link href="/?openSettings=sync" className="inline-block text-sm underline text-mute">Open app account settings</Link>
        </section>}

        {error && <p role="alert" className="rounded-xl bg-bad/10 text-bad p-3 text-sm break-words">{error}</p>}

        {isAdmin && (incompleteNotes.length > 0 || retentionUnreliable) && <p role="status" className="rounded-xl bg-amber-500/15 p-3 text-sm leading-relaxed text-foreground">
          <b>These numbers are incomplete for the selected range.</b>{" "}
          {incompleteNotes.length > 0 ? `Counts are too low because ${incompleteNotes.join("; ")}. Choose a shorter range for exact figures.` : ""}
          {retentionUnreliable ? " Users' \"first seen\" dates, new-versus-returning and retention figures are unreliable while events are cut off." : ""}
        </p>}

        {isAdmin && <>
          <section className="rounded-2xl bg-card p-4 flex flex-wrap items-end justify-between gap-4">
            <div>
              <p className="font-semibold">Analysis window</p>
              <p className="text-xs text-mute mt-1">Metrics below follow this date window and link-type filter.</p>
            </div>
            <div className="flex flex-wrap gap-3">
              <label className="text-xs text-mute grid gap-1">Date range
                <select value={range} onChange={(e) => setRange(e.target.value as RangeKey)} className="rounded-xl bg-secondary text-foreground px-3 py-2.5 text-sm">
                  {Object.entries(RANGE_LABEL).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                </select>
              </label>
              <label className="text-xs text-mute grid gap-1">Link type
                <select value={source} onChange={(e) => setSource(e.target.value as SourceKey)} className="rounded-xl bg-secondary text-foreground px-3 py-2.5 text-sm">
                  <option value="all">All link types</option>
                  <option value="mate-invite">Mate invites</option>
                  <option value="share-ping">WhatsApp Pings</option>
                </select>
              </label>
              <button onClick={() => void refresh()} disabled={loading} className="rounded-xl bg-secondary px-3 py-2.5 text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50"><ArrowClockwise size={16}/>{loading ? "Refreshing…" : "Refresh data"}</button>
            </div>
          </section>

          <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
            {[
              ["Events", metrics.eventCount, "Recorded actions"],
              ["Links created", metrics.created, "Distinct links in range"],
              ["Open events", metrics.opens, "May repeat by session"],
              ["Opened links", metrics.openedLinks, `${metrics.overallOpenRate} of created links`],
              ["Completed links", metrics.used + metrics.answered, `${metrics.overallCompletionRate} completion rate`],
              ["Unique sharers", metrics.sharers, `${metrics.repeatSharers} repeat sharers`],
            ].map(([label, value, hint]) => <article key={String(label)} className="rounded-2xl bg-card p-4 min-w-0">
              <p className="text-xs text-mute">{label}</p><p className="text-2xl sm:text-3xl font-bold mt-1 tabular-nums">{value}</p><p className="text-[11px] text-mute mt-1">{hint}</p>
            </article>)}
          </section>

          {loading ? <section className="rounded-2xl bg-card p-8 text-center text-sm text-mute">Loading analytics from Firestore…</section> : <>
            <nav className="flex flex-wrap gap-2" aria-label="Analytics views">
              {([["overview", "Overview"], ["visitors", "Visits & devices"], ["usage", "App usage"], ["insights", "Retention & engagement"], ["links", "Link performance"], ["events", "Event explorer"]] as const).map(([key, label]) => <button key={key} onClick={() => setTab(key)} className={`rounded-xl px-4 py-2 text-sm font-semibold ${tab === key ? "bg-ink text-paper" : "bg-secondary"}`} aria-pressed={tab === key}>{label}</button>)}
            </nav>

            {tab === "overview" && <>
              <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <article className="rounded-2xl bg-card p-4 xl:col-span-2">
                  <div className="flex items-start justify-between gap-3"><div><h2 className="font-bold">Activity trend</h2><p className="text-xs text-mute mt-1">Created links, opens and completed links across the selected period.</p></div><span className="text-xs text-mute">{trend.length} time buckets</span></div>
                  <div className="flex flex-wrap gap-4 text-xs text-mute mt-4">
                    <span className="inline-flex items-center gap-2"><i className="w-2.5 h-2.5 rounded-sm bg-ink" />Created</span>
                    <span className="inline-flex items-center gap-2"><i className="w-2.5 h-2.5 rounded-sm bg-info" />Opened</span>
                    <span className="inline-flex items-center gap-2"><i className="w-2.5 h-2.5 rounded-sm bg-good" />Completed</span>
                  </div>
                  <div className="grid gap-2 mt-3" style={{ gridTemplateColumns: `repeat(${trend.length}, minmax(0, 1fr))` }}>
                    {trend.map((b) => <div key={b.start} className="min-w-0">
                      <div className="h-36 rounded-lg bg-secondary/60 flex items-end justify-center gap-0.5 px-0.5 pt-2" title={`${b.label}: ${b.created} created, ${b.opened} opened, ${b.completed} completed; ${b.events} events total`}>
                        <div className="w-1/4 min-w-[2px] rounded-t bg-ink" style={{ height: `${Math.max(2, b.created / maxTrend * 100)}%` }} />
                        <div className="w-1/4 min-w-[2px] rounded-t bg-info" style={{ height: `${Math.max(2, b.opened / maxTrend * 100)}%` }} />
                        <div className="w-1/4 min-w-[2px] rounded-t bg-good" style={{ height: `${Math.max(2, b.completed / maxTrend * 100)}%` }} />
                      </div>
                      <p className="text-[9px] sm:text-[10px] text-mute truncate text-center mt-1">{b.label}</p>
                    </div>)}
                  </div>
                  {scope.length === 0 && <p className="text-sm text-mute text-center py-3">No recorded events in this date window.</p>}
                </article>

                <article className="rounded-2xl bg-card p-4 space-y-4">
                  <div><h2 className="font-bold">Conversion funnels</h2><p className="text-xs text-mute mt-1">Distinct links at each stage, using events seen in the selected window.</p></div>
                  {source !== "share-ping" && <Funnel title="Mate invites" total={metrics.invites} opened={rows.filter((r) => r.source === "mate-invite" && r.created && r.opens > 0).length} completed={metrics.used} completionLabel="Used" />}
                  {source !== "mate-invite" && <Funnel title="WhatsApp Pings" total={metrics.pings} opened={rows.filter((r) => r.source === "share-ping" && r.created && r.opens > 0).length} completed={metrics.answered} completionLabel="Answered" />}
                  {metrics.created === 0 && <p className="text-sm text-mute">Create some test links to start populating funnel metrics.</p>}
                </article>
              </section>

              <section className="grid grid-cols-1 xl:grid-cols-3 gap-4">
                <article className="rounded-2xl bg-card p-4 space-y-3">
                  <h2 className="font-bold">Engagement quality</h2>
                  <MetricLine label="Overall open rate" value={metrics.overallOpenRate} hint="Created links with at least one recorded open" />
                  {source !== "share-ping" && <><MetricLine label="Invite open rate" value={metrics.inviteOpenRate} hint={`${metrics.invites} mate invites created`} /><MetricLine label="Invite use rate" value={metrics.inviteUseRate} hint={`${metrics.used} recorded invite uses`} /></>}
                  {source !== "mate-invite" && <><MetricLine label="Ping open rate" value={metrics.pingOpenRate} hint={`${metrics.pings} Pings created`} /><MetricLine label="Ping answer rate" value={metrics.pingAnswerRate} hint={`${metrics.answered} recorded answers`} /></>}
                  <MetricLine label="Avg. opens per opened link" value={metrics.avgOpens.toFixed(1)} hint="Open counts are approximate and session-deduplicated" />
                </article>

                <article className="rounded-2xl bg-card p-4 space-y-3">
                  <h2 className="font-bold">Event mix</h2>
                  {kindCounts.map(([kind, count]) => <div key={kind} className="space-y-1.5">
                    <div className="flex justify-between gap-2 text-sm"><span>{eventName(kind)}</span><b className="tabular-nums">{count}</b></div>
                    <div className="h-2 rounded-full bg-secondary overflow-hidden"><div className="h-full rounded-full bg-ink" style={{ width: `${count / maxKind * 100}%` }} /></div>
                  </div>)}
                  <p className="text-[11px] text-mute">Completed means an invite was used or a Ping received an answer. Counts represent recorded events, not all page views.</p>
                </article>

                <article className="rounded-2xl bg-card p-4 space-y-3">
                  <h2 className="font-bold">Time to completion</h2>
                  <div className="rounded-xl bg-secondary p-3"><p className="text-xs text-mute">Average</p><p className="text-2xl font-bold mt-1">{metrics.averageCompletionMs == null ? "—" : compactDuration(metrics.averageCompletionMs)}</p></div>
                  <div className="rounded-xl bg-secondary p-3"><p className="text-xs text-mute">Median</p><p className="text-2xl font-bold mt-1">{metrics.medianCompletionMs == null ? "—" : compactDuration(metrics.medianCompletionMs)}</p></div>
                  <p className="text-[11px] text-mute">Calculated only for links with both a recorded creation and a completion event available in the selected window.</p>
                </article>
              </section>

              <section className="rounded-2xl bg-card p-4">
                <div className="flex flex-wrap justify-between gap-2 items-end"><div><h2 className="font-bold">Most active sharers</h2><p className="text-xs text-mute mt-1">Ranked by links created in this date window.</p></div><span className="text-xs text-mute">{metrics.senders.length} unique accounts</span></div>
                {topSenders.length === 0 ? <p className="text-sm text-mute py-6 text-center">No sharing activity recorded in this period.</p> : <div className="overflow-x-auto mt-3"><table className="w-full min-w-[620px] text-left text-sm"><thead><tr className="border-b border-ink/10 text-xs text-mute"><th className="py-2 pr-3">Sender</th><th className="py-2 pr-3">Links</th><th className="py-2 pr-3">Open events</th><th className="py-2 pr-3">Completions</th><th>Completion rate</th></tr></thead><tbody>{topSenders.map((s) => <tr key={s.uid} className="border-b border-ink/[0.06]"><td className="py-3 pr-3"><p className="font-semibold">{s.name}</p><p className="text-[10px] text-mute break-all">{s.uid}</p></td><td className="py-3 pr-3 tabular-nums">{s.links}</td><td className="py-3 pr-3 tabular-nums">{s.opens}</td><td className="py-3 pr-3 tabular-nums">{s.completed}</td><td>{percent(s.completed, s.links)}</td></tr>)}</tbody></table></div>}
              </section>
            </>}

            {tab === "visitors" && <>
              {usageError ? <section className="rounded-2xl bg-card p-6 space-y-2">
                <h2 className="text-lg font-bold">Visit analytics cannot be loaded</h2>
                <p className="text-sm text-mute">{usageError}</p>
              </section> : usageEvents.length === 0 ? <section className="rounded-2xl bg-card p-6 space-y-2">
                <h2 className="text-lg font-bold">Waiting for opted-in visits</h2>
                <p className="text-sm text-mute leading-relaxed">Visits, coarse device/browser categories and bounce-like sessions are recorded only when a user accepts the separate optional analytics setting. Nothing is backfilled from activity before opt-in.</p>
              </section> : <>
                <section className="rounded-2xl bg-secondary p-4 text-xs text-mute leading-relaxed">
                  <p><b className="text-ink">Privacy & definitions:</b> these numbers cover consenting users only, not every public website visit. “New browser” means the random first-party browser ID was first observed in the selected range; cleared site data or another browser looks new. “Bounce-like” means a visit with no feature action and no more than one recorded screen. This is a practical SPA engagement proxy, not a conventional page-view bounce rate. {visitorInsights.legacyVisits > 0 ? "Some visits have no device/browser metadata yet. If new visits continue showing as legacy/unknown, publish the latest " : "If device/browser categories do not start appearing after this deployment, publish the latest "}<a className="underline underline-offset-2 text-ink" href="https://raw.githubusercontent.com/LongJumpingWolf/attendance-tracker-2k26/main/firestore.rules" target="_blank" rel="noreferrer">Firestore rules file</a> to permit the new allowlisted fields, then refresh.</p>
                </section>
                <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                  {[
                    ["Visits", visitorInsights.visits, "Opted-in app-open sessions"],
                    ["Unique browsers", visitorInsights.uniqueBrowsers, "Random browser IDs seen"],
                    ["New browsers", visitorInsights.newVisitors, visitorInsights.newVisitorRate === null ? "Rate unavailable" : visitorInsights.newVisitorRate + "% of known browsers"],
                    ["Returning browsers", visitorInsights.returningVisitors, "Seen before this range"],
                    ["Bounce-like rate", visitorInsights.bounceRate === null ? "—" : visitorInsights.bounceRate + "%", visitorInsights.bounceCount + " single-screen, no-action visits"],
                    ["Engaged visits", visitorInsights.interactedSessions, "At least one feature action"],
                  ].map(([label, value, hint]) => <article key={String(label)} className="rounded-2xl bg-card p-4 min-w-0">
                    <p className="text-xs text-mute">{label}</p><p className="text-2xl sm:text-3xl font-bold mt-1 tabular-nums">{value}</p><p className="text-[11px] text-mute mt-1">{hint}</p>
                  </article>)}
                </section>
                <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <article className="rounded-2xl bg-card p-4">
                    <h2 className="font-bold">Visits over time</h2>
                    <p className="text-xs text-mute mt-1">App-open sessions by interval in {RANGE_LABEL[range].toLowerCase()}.</p>
                    <div className="grid gap-2 mt-4" style={{ gridTemplateColumns: "repeat(" + visitorInsights.trend.length + ", minmax(0, 1fr))" }}>
                      {visitorInsights.trend.map((bucket) => <div key={bucket.start} className="min-w-0">
                        <div className="h-32 rounded-lg bg-secondary/60 flex items-end justify-center px-0.5 pt-2" title={bucket.label + ": " + bucket.visits + " visits, " + bucket.visitors + " known browsers, " + bucket.bounced + " bounce-like"}>
                          <div className="w-full max-w-5 rounded-t bg-ink" style={{ height: Math.max(2, bucket.visits / visitorInsights.maxVisits * 100) + "%" }} />
                        </div>
                        <p className="text-[9px] sm:text-[10px] text-mute truncate text-center mt-1">{bucket.label}</p>
                        <p className="text-[10px] text-center tabular-nums">{bucket.visits}</p>
                      </div>)}
                    </div>
                  </article>
                  <article className="rounded-2xl bg-card p-4 space-y-3">
                    <h2 className="font-bold">New vs returning browsers</h2>
                    <p className="text-xs text-mute">First-seen status is based on available opted-in event history.</p>
                    <div className="flex h-4 overflow-hidden rounded-full bg-secondary">
                      <div className="bg-ink" style={{ width: (visitorInsights.uniqueBrowsers ? visitorInsights.newVisitors / visitorInsights.uniqueBrowsers * 100 : 0) + "%" }} />
                      <div className="bg-blue-500" style={{ width: (visitorInsights.uniqueBrowsers ? visitorInsights.returningVisitors / visitorInsights.uniqueBrowsers * 100 : 0) + "%" }} />
                    </div>
                    <MetricLine label="New" value={String(visitorInsights.newVisitors)} hint="First observed in selected range" />
                    <MetricLine label="Returning" value={String(visitorInsights.returningVisitors)} hint="Observed before selected range" />
                    {visitorInsights.unknownAgeVisitors > 0 && <MetricLine label="Age unknown" value={String(visitorInsights.unknownAgeVisitors)} hint="Insufficient first-seen history" />}
                  </article>
                </section>
                <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <article className="rounded-2xl bg-card p-4 space-y-3">
                    <h2 className="font-bold">Visits by device type</h2>
                    <p className="text-xs text-mute">Coarse classification only; no screen size or hardware fingerprint is saved.</p>
                    {visitorInsights.deviceMix.map(([label, count]) => <div key={label} className="space-y-1.5">
                      <div className="flex justify-between gap-2 text-sm"><span>{label === "phone_tablet" ? "Phone / tablet" : label === "desktop" ? "Desktop" : "Legacy / unknown"}</span><b className="tabular-nums">{count} · {percent(count, visitorInsights.visits)}</b></div>
                      <div className="h-2 rounded-full bg-secondary overflow-hidden"><div className="h-full rounded-full bg-ink" style={{ width: (count / visitorInsights.maxDeviceVisits * 100) + "%" }} /></div>
                    </div>)}
                    {visitorInsights.deviceMix.length === 0 && <p className="text-sm text-mute">No device breakdown in this range yet.</p>}
                  </article>
                  <article className="rounded-2xl bg-card p-4 space-y-3">
                    <h2 className="font-bold">Visits by browser</h2>
                    <p className="text-xs text-mute">Browser family only; the raw user-agent string is not retained.</p>
                    {visitorInsights.browserMix.map(([label, count]) => <div key={label} className="space-y-1.5">
                      <div className="flex justify-between gap-2 text-sm"><span>{label}</span><b className="tabular-nums">{count} · {percent(count, visitorInsights.visits)}</b></div>
                      <div className="h-2 rounded-full bg-secondary overflow-hidden"><div className="h-full rounded-full bg-ink" style={{ width: (count / visitorInsights.maxBrowserVisits * 100) + "%" }} /></div>
                    </div>)}
                    {visitorInsights.browserMix.length === 0 && <p className="text-sm text-mute">No browser breakdown in this range yet.</p>}
                  </article>
                </section>
              </>}
            </>}
            {tab === "usage" && <>
              {usageError ? <section className="rounded-2xl bg-card p-6 space-y-2">
                <h2 className="text-lg font-bold">App-usage analytics cannot be loaded</h2>
                <p className="text-sm text-mute leading-relaxed">The link analytics dashboard can still work, but app-usage reads need the latest Firestore security rules. Open the <a className="underline" href="https://raw.githubusercontent.com/LongJumpingWolf/attendance-tracker-2k26/main/firestore.rules" target="_blank" rel="noreferrer">current rules file</a>, replace the full Firestore Rules editor contents, publish only after Firebase accepts the rules without errors, then refresh this dashboard.</p>
                <p role="alert" className="text-xs text-bad break-words">{usageError}</p>
              </section> : usageScope.length === 0 ? <section className="rounded-2xl bg-card p-6 space-y-2">
                <h2 className="text-lg font-bold">No app-usage events yet</h2>
                <p className="text-sm text-mute leading-relaxed">These metrics begin only after individual users opt in through the privacy notice. There is no backfill of earlier app activity. Turn on the optional setting in the app under Settings → Tips, privacy &amp; terms, then use the app normally.</p>
              </section> : <>
                <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                  {[
                    ["Active users", usageMetrics.activeUsers, RANGE_LABEL[range]],
                    ["Active in 24h", usageMetrics.dau, "Distinct account IDs"],
                    ["Active in 7d", usageMetrics.wau, "Distinct account IDs"],
                    ["Active in 30d", usageMetrics.mau, "Distinct account IDs"],
                    ["Tab sessions", usageMetrics.sessions, "Random session IDs"],
                    ["Repeat users", usageMetrics.repeatUsers, "Active on 2+ dates in range"],
                  ].map(([label, value, hint]) => <article key={String(label)} className="rounded-2xl bg-card p-4 min-w-0">
                    <p className="text-xs text-mute">{label}</p><p className="text-2xl sm:text-3xl font-bold mt-1 tabular-nums">{value}</p><p className="text-[11px] text-mute mt-1">{hint}</p>
                  </article>)}
                </section>
                <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
                  {[
                    ["App opens", usageMetrics.appOpens],
                    ["Screen visits", usageMetrics.screenViews],
                    ["Attendance actions", usageMetrics.attendanceActions],
                    ["Feature actions", usageMetrics.actionCount],
                  ].map(([label, value]) => <article key={String(label)} className="rounded-2xl bg-card p-4"><p className="text-xs text-mute">{label}</p><p className="text-xl font-bold mt-1 tabular-nums">{value}</p></article>)}
                </section>
                <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <article className="rounded-2xl bg-card p-4">
                    <h2 className="font-bold">Active-user trend</h2>
                    <p className="text-xs text-mute mt-1">Unique pseudonymous account IDs per bucket. This is app usage, not attendance performance.</p>
                    <div className="grid gap-2 mt-4" style={{ gridTemplateColumns: `repeat(${usageTrend.length}, minmax(0, 1fr))` }}>
                      {usageTrend.map((b) => <div key={b.start} className="min-w-0">
                        <div className="h-32 rounded-lg bg-secondary/60 flex items-end justify-center px-0.5 pt-2" title={`${b.label}: ${b.users.size} active accounts, ${b.sessions.size} sessions, ${b.actions} feature actions`}>
                          <div className="w-full max-w-5 rounded-t bg-ink" style={{ height: `${Math.max(2, b.users.size / maxUsageUsers * 100)}%` }} />
                        </div>
                        <p className="text-[9px] sm:text-[10px] text-mute truncate text-center mt-1">{b.label}</p>
                        <p className="text-[10px] text-center tabular-nums">{b.users.size}</p>
                      </div>)}
                    </div>
                  </article>
                  <article className="rounded-2xl bg-card p-4 space-y-3">
                    <h2 className="font-bold">Most visited screens</h2>
                    <p className="text-xs text-mute">Recorded main-screen visits and explicit Settings opens.</p>
                    {usageMetrics.screenPopularity.length === 0 ? <p className="text-sm text-mute py-4">No screen visits in this period.</p> : usageMetrics.screenPopularity.map(([screen, count]) => <div key={screen} className="space-y-1.5">
                      <div className="flex justify-between gap-2 text-sm"><span>{usageScreenName(screen)}</span><b className="tabular-nums">{count}</b></div>
                      <div className="h-2 rounded-full bg-secondary overflow-hidden"><div className="h-full rounded-full bg-ink" style={{ width: `${count / maxScreenCount * 100}%` }} /></div>
                    </div>)}
                    <p className="text-[11px] text-mute">Screen visits are recorded only after opt-in, and only when the screen changes (plus Settings opens).</p>
                  </article>
                </section>
                <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <article className="rounded-2xl bg-card p-4 space-y-3">
                    <div><h2 className="font-bold">Feature adoption by account</h2><p className="text-xs text-mute mt-1">Distinct opted-in account IDs using each feature in the selected period, alongside event counts.</p></div>
                    {usageMetrics.featureAdoption.map((feature) => <div key={feature.label} className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-3 border-b border-ink/[0.06] pb-2 last:border-0">
                      <div><p className="text-sm font-semibold">{feature.label}</p><p className="text-[11px] text-mute">{percent(feature.users, usageMetrics.activeUsers)} of active accounts</p></div>
                      <div className="text-right"><p className="text-sm font-bold tabular-nums">{feature.users}</p><p className="text-[10px] text-mute">accounts</p></div>
                      <div className="text-right"><p className="text-sm font-bold tabular-nums">{feature.events}</p><p className="text-[10px] text-mute">events</p></div>
                    </div>)}
                  </article>
                  <article className="rounded-2xl bg-card p-4 space-y-4">
                    <div><h2 className="font-bold">Usage by weekday</h2><p className="text-xs text-mute mt-1">Events and active account IDs by the dashboard viewer’s local timezone.</p></div>
                    {(() => {
                      const max = Math.max(1, ...usageMetrics.weekStats.map((d) => d.events))
                      return <div className="space-y-2">{usageMetrics.weekStats.map((d) => <div key={d.label} className="grid grid-cols-[34px_minmax(0,1fr)_42px] items-center gap-2">
                        <span className="text-xs text-mute">{d.label}</span>
                        <div className="h-2.5 rounded-full bg-secondary overflow-hidden"><div className="h-full rounded-full bg-ink" style={{ width: `${d.events / max * 100}%` }} /></div>
                        <span className="text-xs text-right tabular-nums">{d.events}</span>
                      </div>)}</div>
                    })()}
                    <div className="pt-2 border-t border-ink/[0.06]"><h3 className="text-sm font-semibold">Hourly activity</h3><p className="text-[11px] text-mute mt-1">Use the bars to spot broad active periods; no individual actions or class times are shown.</p>
                      {(() => {
                        const max = Math.max(1, ...usageMetrics.hourStats.map((d) => d.events))
                        return <div className="grid grid-cols-12 gap-1 mt-3">{usageMetrics.hourStats.map((d) => <div key={d.hour} title={`${String(d.hour).padStart(2, "0")}:00 — ${d.events} events from ${d.users.size} accounts`} className="min-w-0">
                          <div className="h-16 rounded bg-secondary flex items-end overflow-hidden"><div className="w-full rounded-t bg-ink" style={{ height: `${d.events ? Math.max(3, d.events / max * 100) : 0}%` }} /></div>
                          <p className="text-[8px] text-mute text-center mt-1">{d.hour % 3 === 0 ? String(d.hour).padStart(2, "0") : ""}</p>
                        </div>)}</div>
                      })()}
                    </div>
                  </article>
                </section>

                <section className="rounded-2xl bg-card p-4 space-y-3">
                  <div className="flex flex-wrap justify-between gap-2"><div><h2 className="font-bold">Feature action volume</h2><p className="text-xs text-mute mt-1">Which broad actions happen most often, without logging the subjects, class dates, task titles or attendance values.</p></div><button onClick={exportUsageEvents} className="rounded-xl bg-secondary px-3 py-2 text-sm font-semibold inline-flex items-center gap-2"><DownloadSimple size={16}/>Export usage CSV</button></div>
                  {usageMetrics.actions.length === 0 ? <p className="text-sm text-mute py-4">No feature-action events in this period yet.</p> : <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-3">
                    {usageMetrics.actions.map(([event, count]) => <div key={event} className="space-y-1.5">
                      <div className="flex justify-between gap-2 text-sm"><span>{usageEventName(event)}</span><b className="tabular-nums">{count}</b></div>
                      <div className="h-2 rounded-full bg-secondary overflow-hidden"><div className="h-full rounded-full bg-ink" style={{ width: `${count / maxUsageActionCount * 100}%` }} /></div>
                    </div>)}
                  </div>}
                </section>
              </>}
              <section className="rounded-2xl bg-secondary p-4 text-xs text-mute leading-relaxed space-y-1">
                <p><b className="text-ink">Opt-in and scope:</b> only users who separately enable app-usage analytics contribute. It records pseudonymous Firebase account IDs, random tab-session IDs, broad event labels, screen category and server timestamp. It does not log subject or task titles, attendance values, attendance dates, or notes.</p>
                <p><b className="text-ink">Interpretation:</b> active users are distinct account IDs with at least one recorded opted-in event in the named period. A single person may have more than one account ID across browsers or sign-in changes. Metrics can undercount because the dashboard loads at most 3,000 recent usage events and has no pre-opt-in history.</p>
                <p><b className="text-ink">Retention:</b> usage events older than 90 days are removed when analytics loads. Exported CSVs include pseudonymous account and session IDs; store and delete exports responsibly.</p>
              </section>
            </>}

            {tab === "insights" && <>
              {usageError ? <section className="rounded-2xl bg-card p-6 space-y-2">
                <h2 className="text-lg font-bold">Advanced analytics cannot be loaded</h2>
                <p className="text-sm text-mute">Usage insights need readable product-usage events. Check the published Firestore rules and refresh.</p>
                <p role="alert" className="text-xs text-bad break-words">{usageError}</p>
              </section> : usageEvents.length === 0 ? <section className="rounded-2xl bg-card p-6 space-y-2">
                <h2 className="text-lg font-bold">Waiting for opted-in usage data</h2>
                <p className="text-sm text-mute">These views are calculated from existing, optional, high-level usage events; they do not add new tracking or reconstruct pre-consent activity.</p>
              </section> : <>
                <section className="rounded-2xl bg-secondary p-4 text-xs text-mute leading-relaxed">
                  <p><b className="text-ink">How to read this page:</b> retention uses first-observed activity in the currently loaded sample and is not a guaranteed lifetime cohort. D1, D7 and D30 mean activity in the 24–48 hour, 7–8 day and 30–31 day windows after first observed activity. The data loader keeps at most 3,000 recent events and removes events older than 90 days, so sparse or small cohorts should be interpreted cautiously.</p>
                </section>

                <section className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
                  {[
                    ["Active accounts", deepInsights.activeUsers, RANGE_LABEL[range]],
                    ["Feature actions", deepInsights.currentActionCount, "In selected window"],
                    ["Sessions", deepInsights.sessions, "Account + random tab ID"],
                    ["Actions / account", deepInsights.avgActionsPerUser, "Mean in selected window"],
                    ["Sessions / account", deepInsights.avgSessionsPerUser, "Mean in selected window"],
                    ["Median actions", deepInsights.medianActionsPerUser, "Per active account"],
                  ].map(([label, value, hint]) => <article key={String(label)} className="rounded-2xl bg-card p-4 min-w-0">
                    <p className="text-xs text-mute">{label}</p><p className="text-2xl font-bold mt-1 tabular-nums">{value}</p><p className="text-[11px] text-mute mt-1">{hint}</p>
                  </article>)}
                </section>

                <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <article className="rounded-2xl bg-card p-4 space-y-4">
                    <div><h2 className="font-bold">Session activation funnel</h2><p className="text-xs text-mute mt-1">Same-session progression from opening the app to browsing a screen and performing a feature action.</p></div>
                    {[
                      { label: "Started app sessions", count: deepInsights.startedSessions, rate: null as number | null },
                      { label: "Opened a screen", count: deepInsights.browsedSessions, rate: deepInsights.browseRate },
                      { label: "Performed an action", count: deepInsights.activatedSessions, rate: deepInsights.sessionActivationRate },
                    ].map((stage) => <div key={stage.label} className="space-y-1.5">
                      <div className="flex justify-between gap-3 items-baseline"><span className="text-sm font-semibold">{stage.label}</span><span className="text-sm tabular-nums font-bold">{stage.count}{stage.rate === null ? "" : " · " + stage.rate + "%"}</span></div>
                      <div className="h-3 rounded-full bg-secondary overflow-hidden"><div className="h-full rounded-full bg-ink" style={{ width: (deepInsights.startedSessions ? Math.min(100, stage.count / deepInsights.startedSessions * 100) : 0) + "%" }} /></div>
                    </div>)}
                    <div className="border-t border-ink/[0.06] pt-3 grid grid-cols-2 gap-3">
                      <div><p className="text-xs text-mute">Events / session</p><p className="text-xl font-bold tabular-nums">{deepInsights.avgEventsPerSession}</p></div>
                      <div><p className="text-xs text-mute">Median observed session span</p><p className="text-xl font-bold">{deepInsights.medianSessionMs === null ? "—" : compactDuration(deepInsights.medianSessionMs)}</p></div>
                    </div>
                  </article>

                  <article className="rounded-2xl bg-card p-4 space-y-3">
                    <div><h2 className="font-bold">Engagement segments</h2><p className="text-xs text-mute mt-1">Accounts grouped by feature-action volume in the selected period; “browsing only” means no feature action was recorded.</p></div>
                    {deepInsights.segments.map((segment) => <div key={segment.label} className="space-y-1.5">
                      <div className="flex justify-between gap-3 text-sm"><span><b>{segment.label}</b> <span className="text-xs text-mute">({segment.hint})</span></span><span className="tabular-nums">{segment.users} · {percent(segment.users, deepInsights.activeUsers)}</span></div>
                      <div className="h-2.5 rounded-full bg-secondary overflow-hidden"><div className="h-full rounded-full bg-ink" style={{ width: (segment.users / deepInsights.maxSegment * 100) + "%" }} /></div>
                    </div>)}
                    <p className="text-[11px] text-mute">Segments describe observed usage volume, not user quality or attendance performance.</p>
                  </article>
                </section>

                <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <article className="rounded-2xl bg-card p-4 space-y-3">
                    <div><h2 className="font-bold">Retention by first-observed week</h2><p className="text-xs text-mute mt-1">Only users with a fully elapsed measurement window contribute to each denominator.</p></div>
                    {deepInsights.cohorts.length === 0 ? <p className="py-4 text-sm text-mute">No first-observed cohorts in the loaded usage sample.</p> : <div className="overflow-x-auto">
                      <table className="w-full min-w-[650px] text-left text-sm">
                        <thead><tr className="border-b border-ink/10 text-xs text-mute"><th className="py-2 pr-3">First seen</th><th className="py-2 pr-3">Accounts</th><th className="py-2 pr-3">D1 retained</th><th className="py-2 pr-3">D7 retained</th><th className="py-2">D30 retained</th></tr></thead>
                        <tbody>{deepInsights.cohorts.map((cohort) => <tr key={cohort.start} className="border-b border-ink/[0.06] last:border-0">
                          <td className="py-2 pr-3 whitespace-nowrap">{cohort.label}</td>
                          <td className="py-2 pr-3 tabular-nums">{cohort.users}</td>
                          <td className="py-2 pr-3 tabular-nums">{cohort.d1.eligible ? cohort.d1.rate + "% (" + cohort.d1.returned + "/" + cohort.d1.eligible + ")" : "—"}</td>
                          <td className="py-2 pr-3 tabular-nums">{cohort.d7.eligible ? cohort.d7.rate + "% (" + cohort.d7.returned + "/" + cohort.d7.eligible + ")" : "—"}</td>
                          <td className="py-2 tabular-nums">{cohort.d30.eligible ? cohort.d30.rate + "% (" + cohort.d30.returned + "/" + cohort.d30.eligible + ")" : "—"}</td>
                        </tr>)}</tbody>
                      </table>
                    </div>}
                    <p className="text-[11px] text-mute">A dash means the cohort is too recent for that window, or no accounts are eligible.</p>
                  </article>

                  <article className="rounded-2xl bg-card p-4 space-y-4">
                    <div><h2 className="font-bold">First-week activation</h2><p className="text-xs text-mute mt-1">Accounts that recorded at least one feature action within 7 days of first-observed activity.</p></div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="rounded-xl bg-secondary p-3"><p className="text-xs text-mute">Eligible accounts</p><p className="text-2xl font-bold tabular-nums">{deepInsights.activationEligible}</p></div>
                      <div className="rounded-xl bg-secondary p-3"><p className="text-xs text-mute">Activated</p><p className="text-2xl font-bold tabular-nums">{deepInsights.activationCount}</p></div>
                    </div>
                    <div className="flex justify-between gap-3 items-baseline"><span className="text-sm font-semibold">Activation rate</span><span className="text-xl font-bold tabular-nums">{deepInsights.activationRate === null ? "—" : deepInsights.activationRate + "%"}</span></div>
                    <div className="h-3 rounded-full bg-secondary overflow-hidden"><div className="h-full rounded-full bg-ink" style={{ width: (deepInsights.activationRate === null ? 0 : deepInsights.activationRate) + "%" }} /></div>
                    <div className="border-t border-ink/[0.06] pt-3"><p className="text-xs text-mute">Median time to first feature action</p><p className="text-xl font-bold mt-1">{deepInsights.medianTimeToActivateMs === null ? "—" : compactDuration(deepInsights.medianTimeToActivateMs)}</p></div>
                  </article>
                </section>

                <section className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                  <article className="rounded-2xl bg-card p-4 space-y-3">
                    <div><h2 className="font-bold">Most common screen transitions</h2><p className="text-xs text-mute mt-1">Consecutive recorded screen changes within the same tab session.</p></div>
                    {deepInsights.topTransitions.length === 0 ? <p className="py-4 text-sm text-mute">Not enough screen transitions have been recorded yet.</p> : deepInsights.topTransitions.map(([label, count]) => <div key={label} className="space-y-1.5">
                      <div className="flex justify-between gap-3 text-sm"><span>{label}</span><b className="tabular-nums">{count}</b></div>
                      <div className="h-2 rounded-full bg-secondary overflow-hidden"><div className="h-full rounded-full bg-ink" style={{ width: (count / deepInsights.maxTransition * 100) + "%" }} /></div>
                    </div>)}
                  </article>

                  <article className="rounded-2xl bg-card p-4 space-y-4">
                    <div><h2 className="font-bold">Previous-period comparison</h2><p className="text-xs text-mute mt-1">Current selected window compared with the immediately preceding window of equal length.</p></div>
                    {!deepInsights.comparisonAvailable ? <p className="text-sm text-mute">Unavailable for the 90-day range because analytics retention is limited to 90 days.</p> : <>
                      {[
                        { label: "Active accounts", current: deepInsights.activeUsers, previous: deepInsights.previousUsers, change: deepInsights.userChange },
                        { label: "Feature actions", current: deepInsights.currentActionCount, previous: deepInsights.previousActions, change: deepInsights.actionChange },
                        { label: "Sessions", current: deepInsights.sessions, previous: deepInsights.previousSessions, change: deepInsights.sessionChange },
                      ].map((metric) => <div key={metric.label} className="flex items-center justify-between gap-3 border-b border-ink/[0.06] pb-3 last:border-0">
                        <div><p className="text-sm font-semibold">{metric.label}</p><p className="text-xs text-mute">Previous window: {metric.previous}</p></div>
                        <div className="text-right"><p className="text-lg font-bold tabular-nums">{metric.current}</p><p className="text-xs text-mute">{metric.change === null ? "No non-zero baseline" : (metric.change > 0 ? "+" : "") + metric.change + "% vs previous"}</p></div>
                      </div>)}
                    </>}
                  </article>
                </section>
              </>}
            </>}

            {tab === "links" && <>
              <section className="rounded-2xl bg-card p-4 space-y-3">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div><h2 className="font-bold">Link performance explorer</h2><p className="text-xs text-mute mt-1">Search by sender, recipient, account ID, link type or link reference.</p></div>
                  <button onClick={exportLinks} className="rounded-xl bg-secondary px-3 py-2 text-sm font-semibold inline-flex items-center gap-2"><DownloadSimple size={16}/>Export links CSV</button>
                </div>
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter sender, recipient, account ID, type…" className="w-full rounded-xl bg-secondary px-3 py-3 text-sm" />
                <p className="text-xs text-mute">{visibleRows.length} matching link records · {rows.length} in selected window.</p>
                {visibleRows.length === 0 ? <p className="py-8 text-center text-sm text-mute">No matching links in this period.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[900px] text-left text-sm"><thead><tr className="border-b border-ink/10 text-xs text-mute"><th className="py-3 pr-3">Created / seen</th><th className="py-3 pr-3">Type</th><th className="py-3 pr-3">Sender / account</th><th className="py-3 pr-3">Shared with</th><th className="py-3 pr-3">Open events</th><th className="py-3 pr-3">Opened</th><th className="py-3 pr-3">Completion</th><th>Reference</th></tr></thead><tbody>{visibleRows.map((r) => <tr key={r.key} className="border-b border-ink/[0.06]"><td className="py-3 pr-3 whitespace-nowrap">{dateText(r.createdAtMs)}</td><td className="py-3 pr-3">{sourceName(r.source)}</td><td className="py-3 pr-3"><p className="font-semibold">{r.fromName}</p><p className="text-[10px] text-mute break-all">{r.ownerUid}</p></td><td className="py-3 pr-3">{r.recipientName || "Name not supplied"}</td><td className="py-3 pr-3 tabular-nums">{r.opens}</td><td className="py-3 pr-3 whitespace-nowrap">{dateText(r.openedAtMs)}</td><td className="py-3 pr-3">{r.source === "mate-invite" ? (r.used ? "Used" : "Not used") : (r.answered ? "Answered" : "Not answered")}{r.completedAtMs > 0 && r.createdAtMs > 0 && <p className="text-[10px] text-mute">{compactDuration(r.completedAtMs - r.createdAtMs)}</p>}</td><td className="font-mono text-xs">{r.linkId.slice(0, 12)}…</td></tr>)}</tbody></table></div>}
              </section>
            </>}

            {tab === "events" && <>
              <section className="rounded-2xl bg-card p-4 space-y-3">
                <div className="flex flex-wrap items-end justify-between gap-3">
                  <div><h2 className="font-bold">Recorded event explorer</h2><p className="text-xs text-mute mt-1">Inspect exactly which events exist in the event log; no inferred page views are added.</p></div>
                  <button onClick={exportEvents} className="rounded-xl bg-secondary px-3 py-2 text-sm font-semibold inline-flex items-center gap-2"><DownloadSimple size={16}/>Export raw events CSV</button>
                </div>
                <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter sender, recipient, account ID, type…" className="w-full rounded-xl bg-secondary px-3 py-3 text-sm" />
                {(() => {
                  const q = filter.trim().toLowerCase()
                  const list = scope.filter((e) => !q || [e.fromName, e.recipientName, e.ownerUid, e.linkId, e.source, e.kind].some((v) => String(v || "").toLowerCase().includes(q))).slice().sort((a, b) => timestampMs(b.createdAt) - timestampMs(a.createdAt))
                  return <>
                    <p className="text-xs text-mute">Showing {Math.min(list.length, 300)} of {list.length} matching events from {scope.length} events in scope.</p>
                    {list.length === 0 ? <p className="py-8 text-center text-sm text-mute">No matching events in this period.</p> : <div className="overflow-x-auto max-h-[620px] overflow-y-auto"><table className="w-full min-w-[800px] text-left text-sm"><thead className="sticky top-0 bg-card"><tr className="border-b border-ink/10 text-xs text-mute"><th className="py-3 pr-3">Occurred at</th><th className="py-3 pr-3">Event</th><th className="py-3 pr-3">Source</th><th className="py-3 pr-3">Sender</th><th className="py-3 pr-3">Recipient</th><th>Link reference</th></tr></thead><tbody>{list.slice(0, 300).map((e) => <tr key={e.id} className="border-b border-ink/[0.06]"><td className="py-3 pr-3 whitespace-nowrap">{dateText(timestampMs(e.createdAt))}</td><td className="py-3 pr-3">{eventName(e.kind)}</td><td className="py-3 pr-3">{sourceName(e.source)}</td><td className="py-3 pr-3"><p>{e.fromName || "Unknown"}</p><p className="text-[10px] text-mute break-all">{e.ownerUid}</p></td><td className="py-3 pr-3">{e.recipientName || "—"}</td><td className="font-mono text-xs">{e.linkId.slice(0, 12)}…</td></tr>)}</tbody></table></div>}
                  </>
                })()}
              </section>
            </>}
          </>}

          <section className="rounded-2xl bg-secondary p-4 text-xs text-mute leading-relaxed space-y-1">
            <p><b className="text-ink">Data coverage:</b> link activity only includes instrumented Mate invite and WhatsApp Ping events. This is not a full app-wide usage or attendance dashboard; private attendance records are not centrally collected for analytics.</p>
            <p><b className="text-ink">Sampling and retention:</b> the dashboard loads at most the 2,000 newest retained events. Events older than 90 days are removed when the dashboard loads. Rates are based on recorded events and may undercount opens because session opens are deduplicated where possible.</p>
            <p><b className="text-ink">Privacy:</b> the event log includes account IDs and the display names attached to links. CSV exports contain these values; store and delete exports responsibly. No IP addresses, precise location, or device/browser fingerprints are intentionally recorded.</p>
          </section>
        </>}
      </div>
    </main>
  )
}

function MetricLine({ label, value, hint }: { label: string; value: string; hint: string }) {
  return <div className="border-b border-ink/[0.06] pb-3 last:border-0 last:pb-0"><div className="flex justify-between gap-3 text-sm"><span>{label}</span><b className="tabular-nums">{value}</b></div><p className="text-[11px] text-mute mt-1">{hint}</p></div>
}

function Funnel({ title, total, opened, completed, completionLabel }: { title: string; total: number; opened: number; completed: number; completionLabel: string }) {
  const safeTotal = Math.max(1, total)
  const stages = [
    { label: "Created", value: total },
    { label: "Opened", value: opened },
    { label: completionLabel, value: completed },
  ]
  return <div className="space-y-3 border-t border-ink/[0.06] pt-3 first:border-0 first:pt-0">
    <div className="flex justify-between gap-2"><p className="text-sm font-semibold">{title}</p><span className="text-xs text-mute">{total} created</span></div>
    {stages.map((stage) => <div key={stage.label} className="space-y-1">
      <div className="flex justify-between text-xs gap-2"><span>{stage.label}</span><span className="tabular-nums">{stage.value} · {percent(stage.value, total)}</span></div>
      <div className="h-2 rounded-full bg-secondary overflow-hidden"><div className="h-full rounded-full bg-ink" style={{ width: `${Math.min(100, stage.value / safeTotal * 100)}%` }}/></div>
    </div>)}
  </div>
}
