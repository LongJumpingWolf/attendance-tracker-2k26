"use client"

import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { GearSix, Plus } from "@phosphor-icons/react"
import { useNotifications } from "@/hooks/use-notifications"
import {
  registerServiceWorker,
  subscribeToPushNotifications,
  sendLocalNotification,
  onMessageListener,
} from "@/lib/notifications"
import { getClientMessaging, getFirebaseVapidKey } from "@/lib/firebase"
import { pushSetupMessage } from "@/lib/push-config"
import type { Subject, Task, Mate, Ping, LogEntry, Holiday, ScheduleOverride } from "@/lib/types"
import {
  getAttendance,
  localDate,
  formatDayMonth,
  entryFor,
  restoreMark,
  markWithUndo,
  withSet,
  daysUntil,
  classesOn,
  markFor,
  toMin,
  type MarkMeta,
  type ClassSlot,
} from "@/lib/attendance"
import { applyImport, type FinalSubject } from "@/lib/timetable-import"
import { lastWeekInfo } from "@/lib/wrapped"
import { dbDel, dbGet, dbSet, protectStorage } from "@/lib/db"
import { newId } from "@/lib/ids"
import { saveRestorePoint } from "@/lib/restore-points"
import { adoptConnections } from "@/lib/identity"
import { liveNames } from "@/lib/profile-name"
import { holidayCancellations, isHolidayCancellation } from "@/lib/holidays"
import { getProfileName } from "@/lib/social"
import { mustWaitToApply } from "@/lib/ping-unapplied"
import { usePingEvents } from "@/lib/use-ping-events"
import { usePingProcessing } from "@/lib/use-ping-processing"
import { applyPingResult, resultIsSaved } from "@/lib/ping-apply"
import PingEventView from "@/components/ping-event"
import { loadSchedule, saveSchedule } from "@/lib/reminders"
import { restoreFrom, resetEverything } from "@/lib/safe-replace"
import { cloudAvailable, cloudGet, cloudPut } from "@/lib/cloud-sync"
import { buildBackup, parseFullBackup } from "@/lib/backup"
import { dataPersisted, resetIsComplete, RESET_DB_KEYS, RESET_LOCAL_KEYS } from "@/lib/replace-verify"
import { BUSY_MESSAGE, setDemoLive, tryAcquire } from "@/lib/operation-lock"
import { useSocial } from "@/lib/use-social"
import { useCloudSync } from "@/hooks/use-cloud-sync"
import BottomNav from "@/components/bottom-nav"
import SubjectSheet, { type SubjectValues } from "@/components/subject-sheet"
import DeadlineSheet, { type DeadlineValues } from "@/components/deadline-sheet"
import Sheet, { tintButton } from "@/components/sheet"
import TodayView, { type Banner } from "@/components/today-view"
import SubjectsView from "@/components/subjects-view"
import SubjectDetail from "@/components/subject-detail"
import ClassChangeSheet from "@/components/class-change-sheet"
import SleepSubjectSheet from "@/components/sleep-subject-sheet"
import CalendarView from "@/components/calendar-view"
import MatesView from "@/components/mates-view"
import MatesAccessGate from "@/components/mates-access-gate"
import SettingsSheet from "@/components/settings-sheet"
import ReconcileSheet from "@/components/reconcile-sheet"
import TimetableImportSheet from "@/components/timetable-import-sheet"
import Onboarding from "@/components/onboarding"
import FirstVisitTour, { type GuidedTab } from "@/components/first-visit-tour"
import ScanCheckIn, { type ScanState } from "@/components/scan-check-in"
import ScanGate from "@/components/scan-gate"
import DemoTour from "@/components/demo-tour"
import { isInAppBrowser, safariUrl, chromeIntentUrl } from "@/lib/in-app"
import { prepareScanReview, scanTargetKey } from "@/lib/scan"
import { buildTestSubjects, isTestSubject } from "@/lib/scan-test"
import WrappedStory from "@/components/wrapped-story"
import UndoToast, { type ToastState } from "@/components/undo-toast"
import TermsGate, { CONSENT_VERSION } from "@/components/terms-gate"
import { recordProductUsageEvent, USAGE_ANALYTICS_KEY } from "@/lib/usage-analytics"
import FeedbackSheet from "@/components/feedback-sheet"
import FeedbackNudge from "@/components/feedback-nudge"
import FeedbackCelebration from "@/components/feedback-celebration"
import TicketsSheet from "@/components/tickets-sheet"
import FixCheckIn from "@/components/fix-check-in"
import { useMyTickets } from "@/lib/use-my-tickets"
import { markTicketSeen, type FeedbackRecord } from "@/lib/feedback"
import { ticketTitle } from "@/lib/feedback-threads"
import { SW_OPTIONS, SW_URL } from "@/lib/sw-config"

type Page = "today" | "subjects" | "calendar" | "mates"

const TITLES: Record<Page, string> = {
  today: "Today",
  subjects: "Subjects",
  calendar: "Calendar",
  mates: "Proxy-mates",
}

const iconButton =
  "w-10 h-10 grid place-items-center rounded-full bg-card text-ink hover:bg-secondary transition"

export default function Home() {
  const [currentPage, setCurrentPage] = useState<Page>("today")
  const [subjects, setSubjects] = useState<Subject[]>([])
  const [tasks, setTasks] = useState<Task[]>([])
  const [mates, setMates] = useState<Mate[]>([])
  const [holidays, setHolidays] = useState<Holiday[]>([])
  const [scheduleOverrides, setScheduleOverrides] = useState<ScheduleOverride[]>([])
  // Optional: treat a holiday as a day without class. The cancelled classes are made for display only (never saved or synced).
  const [holidaysCancel, setHolidaysCancel] = useState(false)
  const effectiveOverrides = useMemo(
    () => (holidaysCancel ? [...scheduleOverrides, ...holidayCancellations(subjects, holidays, scheduleOverrides)] : scheduleOverrides),
    [holidaysCancel, subjects, holidays, scheduleOverrides],
  )
  const [allTags, setAllTags] = useState<string[]>([])
  const [detailId, setDetailId] = useState<string | null>(null)
  const [calendarFocusDate, setCalendarFocusDate] = useState<string | null>(null)
  const [deleteSubjectTarget, setDeleteSubjectTarget] = useState<Subject | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [dateLabel, setDateLabel] = useState("")

  // Overlays
  const [isAddOpen, setIsAddOpen] = useState(false)
  const [editingSubjectId, setEditingSubjectId] = useState<string | null>(null)
  // The deadline being added (task = null) or edited. `date` is where a new one starts.
  const [deadlineEditor, setDeadlineEditor] = useState<{ task: Task | null; date: string } | null>(null)
  // Completing or deleting a deadline asks first
  const [confirmDeadline, setConfirmDeadline] = useState<{ kind: "done" | "delete"; task: Task } | null>(null)
  const [isMateOpen, setIsMateOpen] = useState(false)
  const [isSettingsOpen, setIsSettingsOpen] = useState(false)
  const [settingsStartPanel, setSettingsStartPanel] = useState<"home" | "sync" | "tips-terms">("home")
  const [consentReady, setConsentReady] = useState(false)
  const [consentAccepted, setConsentAccepted] = useState(false)
  const [usageAnalyticsEnabled, setUsageAnalyticsEnabled] = useState(false)
  const [showSyncNudge, setShowSyncNudge] = useState(false)
  const [isOnline, setIsOnline] = useState<boolean | null>(null)
  const [isImportOpen, setIsImportOpen] = useState(false)
  const [scan, setScan] = useState<ScanState | null>(null)
  const scanBefore = useRef<{ id: string; date: string; t: string; prev: LogEntry | null }[]>([]) // every class marked in the last scan confirmation, for Undo
  const [demoActive, setDemoActive] = useState(false)
  const [demoTourOpen, setDemoTourOpen] = useState(false)
  const demoSnapshot = useRef<{ subjects: Subject[]; tasks: Task[]; tags: string[]; mates: Mate[] } | null>(null)
  const scanHandled = useRef(false)
  const [scanGate, setScanGate] = useState(false) // a scan opened inside a scanner app's temporary browser
  const scanMarks = useRef<{ id: string; date: string; t: string; k?: string }[]>([]) // marks made by scanning this visit
  const [isWrappedOpen, setIsWrappedOpen] = useState(false)
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false)
  const [onboardingResolved, setOnboardingResolved] = useState(false)
  const [firstVisitTourPage, setFirstVisitTourPage] = useState<GuidedTab | null>(null)
  const [classActionsTarget, setClassActionsTarget] = useState<import("@/components/class-action-menu").ClassActionTarget | null>(null)
  const [sleepTarget, setSleepTarget] = useState<Subject | null>(null)

  const [toast, setToast] = useState<ToastState | null>(null)
  const [showFeedback, setShowFeedback] = useState(false)
  const [feedbackKind, setFeedbackKind] = useState<"rating" | "bug" | "suggestion">("bug")
  const [showFeedbackNudge, setShowFeedbackNudge] = useState(false)
  // The person's tickets (bug reports, feature requests, rating) and what in them needs attention
  const myTickets = useMyTickets()
  const [showTickets, setShowTickets] = useState(false)
  const [ticketsOpenId, setTicketsOpenId] = useState<string | null>(null)
  const [dismissedReplyIds, setDismissedReplyIds] = useState<Set<string>>(new Set())
  const [previewTicket, setPreviewTicket] = useState<FeedbackRecord | null>(null)
  const myRating = myTickets.tickets.find((t) => t.kind === "rating" && t.id === `rating-${myTickets.uid}`) ?? myTickets.tickets.find((t) => t.kind === "rating") ?? null
  const replyToShow = previewTicket ?? (myTickets.firstReply && !dismissedReplyIds.has(myTickets.firstReply.id) ? myTickets.firstReply : null)

  const { notificationSupported, notificationPermission, isSubscribed, enableNotifications } = useNotifications(subjects, effectiveOverrides)
  const social = useSocial()
  const [pendingLink, setPendingLink] = useState<{ kind: "add" | "invite"; value: string } | null>(null)

  // ---------- load / persist ----------
  // The working copy lives in IndexedDB (lib/db.ts), which also moves over anything an older version left in localStorage.
  // Nothing is written back until this has finished, so an empty screen can never overwrite saved data.
  useEffect(() => {
    let alive = true
    void (async () => {
      const [savedSubjects, savedTasks, savedTags, savedMates, savedHolidays, savedOverrides] = await Promise.all([
        dbGet<Subject[]>("subjects"),
        dbGet<Task[]>("tasks"),
        dbGet<string[]>("tags"),
        dbGet<Mate[]>("mates"),
        dbGet<Holiday[]>("holidays"),
        dbGet<ScheduleOverride[]>("scheduleOverrides"),
      ])
      if (!alive) return
      if (Array.isArray(savedSubjects)) {
        setSubjects(savedSubjects)
        setAllTags(Array.from(new Set(savedSubjects.flatMap((s) => s.tags || []))))
      }
      if (Array.isArray(savedTasks)) setTasks(savedTasks)
      if (Array.isArray(savedTags)) setAllTags(savedTags)
      if (Array.isArray(savedMates)) setMates(savedMates)
      if (Array.isArray(savedHolidays)) setHolidays(savedHolidays)
      if (Array.isArray(savedOverrides)) setScheduleOverrides(savedOverrides)

      // Habit tracker, to-do list and tutorial were removed; drop their leftovers
      try {
        for (const key of ["todos", "binTodos", "binClearDate", "habits", "tutorialSeen"]) localStorage.removeItem(key)
      } catch { /* site data blocked: the app still has to finish loading */ }

      try { setHolidaysCancel(localStorage.getItem("holidaysCancelClasses") === "1") } catch { /* default: holidays are shown, classes stay */ }
      setDateLabel(new Date().toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" }))
      setLoaded(true)
      void protectStorage() // ask the browser not to evict this data when the device runs low on space
    })()
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    try {
      setConsentAccepted(localStorage.getItem(CONSENT_VERSION) === "1")
      setUsageAnalyticsEnabled(localStorage.getItem(USAGE_ANALYTICS_KEY) === "1")
    } catch {
      setConsentAccepted(false)
      setUsageAnalyticsEnabled(false)
    }
    setConsentReady(true)
  }, [])

  // The separate usage-analytics choice is opt-in. This never logs subject names, task titles, values, or dates.
  useEffect(() => {
    if (!loaded || !consentReady || !consentAccepted || !usageAnalyticsEnabled || demoActive) return
    void recordProductUsageEvent("app_open", currentPage)
  }, [loaded, consentReady, consentAccepted, usageAnalyticsEnabled, demoActive, currentPage])

  useEffect(() => {
    if (!loaded || !consentReady || !consentAccepted || !usageAnalyticsEnabled || demoActive) return
    void recordProductUsageEvent("screen_view", currentPage)
  }, [loaded, consentReady, consentAccepted, usageAnalyticsEnabled, demoActive, currentPage])

  useEffect(() => {
    if (!isSettingsOpen || !loaded || !consentReady || !consentAccepted || !usageAnalyticsEnabled || demoActive) return
    void recordProductUsageEvent("settings_open", "settings")
  }, [isSettingsOpen, loaded, consentReady, consentAccepted, usageAnalyticsEnabled, demoActive])

  useEffect(() => {
    const update = () => setIsOnline(navigator.onLine)
    update()
    window.addEventListener("online", update)
    window.addEventListener("offline", update)
    return () => {
      window.removeEventListener("online", update)
      window.removeEventListener("offline", update)
    }
  }, [])

  useEffect(() => {
    // Foreground push messages. Without Firebase env vars this rejects, so never let it surface as an error.
    Promise.resolve(
      onMessageListener((payload) => {
        const { title, body } = payload?.notification ?? {}
        setToast({ id: Date.now(), message: [title, body].filter(Boolean).join(": ") || "New notification" })
      }),
    ).catch(() => console.warn("Push notifications are off: Firebase environment variables are not set."))
  }, [])

  // Only write after the initial load so we never overwrite saved data with empty state. Never while the demo is on
  // screen: demo data lives in memory only, so closing the tab mid-demo leaves your own data exactly as it was.
  useEffect(() => {
    if (loaded && consentReady && consentAccepted && !demoActive) void dbSet("subjects", subjects)
  }, [subjects, loaded, demoActive])
  useEffect(() => {
    if (loaded && consentReady && consentAccepted && !demoActive) void dbSet("tasks", tasks)
  }, [tasks, loaded, demoActive])
  useEffect(() => {
    if (loaded && consentReady && consentAccepted && !demoActive) void dbSet("tags", allTags)
  }, [allTags, loaded, demoActive])
  useEffect(() => {
    if (loaded && consentReady && consentAccepted && !demoActive) void dbSet("mates", mates)
  }, [mates, loaded, demoActive])
  useEffect(() => {
    if (loaded && consentReady && consentAccepted && !demoActive) void dbSet("holidays", holidays)
  }, [holidays, loaded, demoActive])
  useEffect(() => {
    if (loaded && consentReady && consentAccepted && !demoActive) void dbSet("scheduleOverrides", scheduleOverrides)
  }, [scheduleOverrides, loaded, demoActive])

  // ---------- friend connections ----------
  // Preserve a pending friend link through full-page Google sign-in redirects (useful in Safari).
  // This token is session-scoped and is cleared when the connection attempt starts.
  useEffect(() => {
    try {
      const raw = sessionStorage.getItem("attendance-pending-mate-link")
      if (raw) {
        const saved = JSON.parse(raw) as { kind?: unknown; value?: unknown }
        if ((saved.kind === "add" || saved.kind === "invite") && typeof saved.value === "string" && saved.value.length > 0 && saved.value.length <= 2048) {
          setPendingLink({ kind: saved.kind, value: saved.value })
          setCurrentPage("mates")
        } else {
          sessionStorage.removeItem("attendance-pending-mate-link")
        }
      }
    } catch {
      // Storage may be unavailable in private browsing; the current-page flow still works.
    }

    try {
      const raw = sessionStorage.getItem("attendance-pending-mate-link")
      if (raw) {
        const saved = JSON.parse(raw) as { kind?: unknown; value?: unknown }
        if ((saved.kind === "add" || saved.kind === "invite") && typeof saved.value === "string" && saved.value.length > 0 && saved.value.length <= 2048) {
          setPendingLink({ kind: saved.kind, value: saved.value })
          setCurrentPage("mates")
        } else {
          sessionStorage.removeItem("attendance-pending-mate-link")
        }
      }
    } catch { /* session storage may be unavailable */ }

    const p = new URLSearchParams(window.location.search)
    const add = p.get("add")
    const inv = p.get("invite")
    if (add || inv) {
      const link: { kind: "add" | "invite"; value: string } = { kind: add ? "add" : "invite", value: (add || inv) as string }
      setPendingLink(link)
      try { sessionStorage.setItem("attendance-pending-mate-link", JSON.stringify(link)) } catch {}
      window.history.replaceState(null, "", window.location.pathname)
      setCurrentPage("mates")
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Count invite opens only after the visitor accepts the updated privacy notice.
  // The tab-scoped marker prevents double counting the same token when the app rerenders.
  useEffect(() => {
    if (!consentReady || !consentAccepted || pendingLink?.kind !== "invite") return
    const token = pendingLink.value
    let shouldRecord = true
    try {
      const key = `attendance-mate-invite-opened:${token}`
      if (sessionStorage.getItem(key)) shouldRecord = false
      else sessionStorage.setItem(key, "1")
    } catch { /* analytics remains best-effort if storage is unavailable */ }
    if (shouldRecord) void social.trackInviteOpen(token)
  }, [consentReady, consentAccepted, pendingLink, social.trackInviteOpen])

  // Open the normal app Settings → Sync screen from the clean app URL when the invite-page popup fails.
  // The pending friend link remains in sessionStorage and is processed after the account is ready.
  useEffect(() => {
    const url = new URL(window.location.href)
    if (url.searchParams.get("openSettings") !== "sync") return
    setSettingsStartPanel("sync")
    setIsSettingsOpen(true)
    url.searchParams.delete("openSettings")
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`)
  }, [])

  useEffect(() => {
    if (isOnline === true && consentReady && consentAccepted && currentPage === "mates") social.enable()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage, consentReady, consentAccepted, isOnline])

  // Accepted connections appear in the favour ledger
  useEffect(() => {
    if (!loaded || !social.uid) return
    const accepted = social.requests.filter((r) => r.status === "accepted")
    if (accepted.length === 0) return
    // A mate who reconnected under a new account id is the same person: their old row takes the new id and keeps its history
    const connections = accepted.flatMap((r) => {
      const other = r.participants.find((p) => p !== social.uid)
      return other ? [{ uid: other, name: r.from === social.uid ? r.toName : r.fromName }] : []
    })
    setMates((prev) => adoptConnections(prev, connections))
    // The name in a request is a copy from when it was sent (it may be a placeholder or out of date): their profile is the source
    let cancelled = false
    void liveNames(connections.map((c) => c.uid)).then((live) => {
      if (cancelled || Object.keys(live).length === 0) return
      setMates((prev) => adoptConnections(prev, connections.map((c) => ({ ...c, name: live[c.uid] ?? c.name }))))
    })
    return () => { cancelled = true }
  }, [social.requests, social.uid, loaded])

  const incomingRequests = social.requests.filter((r) => r.status === "pending" && r.to === social.uid)

  // ---------- pings: "did you mark me present?" ----------
  // What is put in front of you (a request to answer, or the answer to your own) is decided by the Ping events further
  // down. Here the answers you receive are applied to your own data, safely: see lib/ping-processing.ts.
  const demoActiveRef = useRef(false)
  demoActiveRef.current = demoActive
  // The data as it is right now. Handlers that wait (a safety copy is being saved) must not act on the render they were made in.
  const latest = useRef({ subjects, tasks, tags: allTags, mates, holidays, scheduleOverrides })
  useEffect(() => {
    latest.current = { subjects, tasks, tags: allTags, mates, holidays, scheduleOverrides }
  })

  /**
   * Applies an answer to this device's data and confirms it is really saved before saying so. It may run more than once
   * for the same Ping (after a crash, a reload, or on another device) and the second time changes nothing.
   */
  const applyDurably = async (p: Ping): Promise<boolean> => {
    if (demoActiveRef.current) return false // demo data is never saved, so there is nothing safe to confirm
    const r = applyPingResult(latestSubjects.current, latestMates.current, p)
    // A "yes" for a class this device doesn't have (a new browser, not yet synced) must not be marked processed: that is permanent
    if (mustWaitToApply(p, r)) return false
    if (r.helped.length > 0) {
      latestSubjects.current = r.subjects
      latestMates.current = r.mates
      setSubjects(r.subjects)
      setMates(r.mates)
      await Promise.all([dbSet("subjects", r.subjects), dbSet("mates", r.mates)])
    }
    const saved = { subjects: (await dbGet<Subject[]>("subjects")) ?? [], mates: (await dbGet<Mate[]>("mates")) ?? [] }
    return resultIsSaved(saved, r, p)
  }
  usePingProcessing({
    // Anonymous accounts may still use one-time WhatsApp/share links, but direct in-app Pings require Google sign-in.
    pings: social.sent.filter((ping) => !social.anonymous || !!ping.shareLink),
    enabled: loaded && consentReady && consentAccepted && !demoActive,
    deps: { lease: social.leasePing, apply: applyDurably, finalize: social.finalizePing },
  })

  // ---------- weekly wrapped ----------
  // Weekly Wrapped is exposed in the Quick WhatsApp Ping section on Saturdays only.
  const [wrappedSeen, setWrappedSeen] = useState<string | null | undefined>(undefined)
  const [wrappedForce, setWrappedForce] = useState(false) // set by the Settings simulator
  useEffect(() => {
    if (loaded) setWrappedSeen(localStorage.getItem("wrappedSeenWeek"))
  }, [loaded])

  const saturdayRelease = new Date().getDay() === 6
  const lastWeek = loaded ? lastWeekInfo(subjects) : null
  const wrappedDue = saturdayRelease && !!lastWeek && wrappedSeen !== undefined && (wrappedForce || (lastWeek.hasData && wrappedSeen !== lastWeek.key))

  const openWrapped = () => {
    setIsWrappedOpen(true)
    setWrappedForce(false)
    if (lastWeek) {
      setWrappedSeen(lastWeek.key)
      localStorage.setItem("wrappedSeenWeek", lastWeek.key)
    }
  }

  // ---------- first run ----------
  // A fresh install gets the welcome tour once. Anyone who already has data is treated as set up.
  useEffect(() => {
    if (!loaded) return
    try {
      if (localStorage.getItem("onboardingDone")) {
        setOnboardingResolved(true)
        return
      }
      if (subjects.length === 0 && mates.length === 0) setIsOnboardingOpen(true)
      else localStorage.setItem("onboardingDone", "1")
    } catch {
      /* private mode: skip the tour rather than show it every time */
    } finally {
      setOnboardingResolved(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  const finishOnboarding = () => {
    setIsOnboardingOpen(false)
    try {
      localStorage.setItem("onboardingDone", "1")
      localStorage.setItem("firstRunGuidesEnabled", "1")
      // Today is introduced by the first-run screen itself.
      localStorage.setItem("firstTabGuideSeen:today", "1")
    } catch {
      /* fine */
    }
  }

  // ---------- helpers ----------
  const closeToast = useCallback(() => setToast(null), [])
  const showToast = (message: string, undo?: () => void) => setToast({ id: Date.now(), message, undo })

  const patchSubject = (id: string, fn: (s: Subject) => Subject) =>
    setSubjects((prev) => prev.map((s) => (s.id === id ? fn(s) : s)))

  // A Ping to put in front of you: someone asking for attendance help, or the answer to your own request.
  // Shown wherever you are in the app, on opening it, and when a notification is tapped (/?ping=<id>).
  const pingEvents = usePingEvents({
    social,
    enabled: loaded && consentReady && consentAccepted && !demoActive,
    onNotice: (m) => showToast(m),
  })

  // The newest subjects, kept in step synchronously, so two quick taps each see the other's result
  const latestSubjects = useRef(subjects)
  latestSubjects.current = subjects
  const latestMates = useRef(mates)
  latestMates.current = mates

  /**
   * Mark (or change, or clear) one class on any date. The toast shows the resulting percentage, and its Undo puts back
   * exactly this class's previous record, never the whole subject: other classes of the same subject stay as they are.
   */
  const setToday = (id: string, date: string, status: "P" | "A" | null, meta?: MarkMeta) => {
    const s = latestSubjects.current.find((x) => x.id === id)
    if (!s) return
    if (markFor(s, date, meta?.t ?? "") === status) return // already in that state: nothing to count, nothing to announce
    if (!demoActiveRef.current) void recordProductUsageEvent(status === null ? "attendance_clear" : "attendance_mark", currentPage)
    const { next, undo } = markWithUndo(s, date, status, meta)
    latestSubjects.current = latestSubjects.current.map((x) => (x.id === id ? next : x))
    patchSubject(id, (x) => markWithUndo(x, date, status, meta).next)
    const now = getAttendance(next.attended, next.missed, next.requirement)
    const verb = status === "P" ? "Present" : status === "A" ? "Absent" : "Cleared"
    const when = date === localDate() ? "" : ` · ${formatDayMonth(date)}`
    showToast(`${verb} · ${s.name}${when}${now.total ? ` · now ${now.pct}%` : ""}`, () => patchSubject(id, undo))
  }

  // A scan opens a review. Attendance changes only after the person confirms the selected classes.
  const scanConfirm = (targets: ClassSlot[], review: ScanState) => {
    const date = localDate()
    const uniqueTargets = [...new Map(targets.map((target) => [scanTargetKey(target), target])).values()]
    const beforeRecords: { id: string; date: string; t: string; prev: LogEntry | null }[] = []
    const acceptedTargets: ClassSlot[] = []

    // Recheck live state at commit time. If another action marked a class while the review was open,
    // skip it rather than overwrite or count it twice.
    for (const target of uniqueTargets) {
      const owner = target.attendanceSubject ?? target.subject
      const before = subjects.find((s) => s.id === owner.id)
      if (!before || markFor(before, date, target.slot.start) !== null) continue
      beforeRecords.push({ id: before.id, date, t: target.slot.start, prev: entryFor(before, date, target.slot.start) })
      acceptedTargets.push(target)
    }

    if (acceptedTargets.length === 0) {
      showToast("Those classes are already marked. Nothing changed.")
      return
    }

    scanBefore.current = beforeRecords
    for (const target of acceptedTargets) {
      const owner = target.attendanceSubject ?? target.subject
      scanMarks.current.push({ id: owner.id, date, t: target.slot.start, k: target.slot.kind })
      if (!demoActiveRef.current) void recordProductUsageEvent("scan_checkin", "scanner")
    }

    // Apply the batch in one state update, including multiple slots owned by the same subject.
    setSubjects((prev) => prev.map((subject) => {
      const ownTargets = acceptedTargets.filter((target) => (target.attendanceSubject ?? target.subject).id === subject.id)
      return ownTargets.reduce(
        (current, target) => markFor(current, date, target.slot.start) === null
          ? withSet(current, date, "P", { t: target.slot.start, k: target.slot.kind })
          : current,
        subject,
      )
    }))
    setScan({ ...review, phase: "complete", marked: acceptedTargets[0], completed: acceptedTargets })
  }

  const scanUndo = () => {
    if (scan?.preview) return setScan(null)
    const before = scanBefore.current
    for (const record of before) {
      patchSubject(record.id, (subject) => restoreMark(subject, record.date, record.t, record.prev))
    }
    const restoredKeys = new Set(before.map((record) => `${record.id}@${record.date}@${record.t}`))
    // Keep pending sync fallbacks for every other slot, including other lectures of the same subject.
    scanMarks.current = scanMarks.current.filter((m) => !restoredKeys.has(`${m.id}@${m.date}@${m.t}`))
    scanBefore.current = []
    setScan(null)
  }

  // Data kept in step across browsers through a sync code
  const sync = useCloudSync({
    loaded: loaded && consentReady && consentAccepted,
    data: { subjects, tasks, tags: allTags, mates, holidays, scheduleOverrides },
    paused: demoActive, // demo data must never overwrite, or be overwritten by, the real synced copy
    apply: (d) => {
      // A scan does not wait for sync. If the synced copy arrives afterwards without a scan mark, restore every
      // scanned class for that subject (not only the first); one subject can have multiple slots on the same day.
      const kept = scanMarks.current.length
        ? d.subjects.map((s) => {
            const pending = scanMarks.current.filter((m) => m.id === s.id)
            return pending.reduce(
              (current, m) => markFor(current, m.date, m.t) === null
                ? withSet(current, m.date, "P", { t: m.t, k: m.k })
                : current,
              s,
            )
          })
        : d.subjects
      setSubjects(kept)
      setTasks(d.tasks)
      setAllTags(d.tags)
      setMates(d.mates)
      if (d.holidays !== undefined) setHolidays(d.holidays)
      if (d.scheduleOverrides !== undefined) setScheduleOverrides(d.scheduleOverrides)
    },
    notify: (m) => showToast(m),
  })

  // Do not consume connection links until the same Google-backed account used for sync is active.
  // Keep the pending link intact behind the Mates sign-in gate so the invitation can be completed after sign-in.
  useEffect(() => {
    if (!consentReady || !consentAccepted || !pendingLink || !sync.account || isOnline !== true) return
    if (!social.configured) {
      setToast({ id: Date.now(), message: "Friend connections aren't set up in this app yet." })
      setPendingLink(null)
      return
    }
    if (social.status !== "ready" || !social.name || social.anonymous) return
    const link = pendingLink
    setPendingLink(null)
    try { sessionStorage.removeItem("attendance-pending-mate-link") } catch {}
    // A link must never connect anyone on its own: a stranger's link opened from a chat would otherwise accept a request
    // they had already sent, and from then on they can send Pings and notifications. Ask first, showing who it is.
    void (async () => {
      let who = ""
      if (link.kind === "add") {
        try { who = ((await getProfileName(link.value)) ?? "").trim() } catch { /* the name is only for the question */ }
      }
      const question = who
        ? `Connect with ${who}?\n\nThey will be able to send you attendance Pings. Only continue if you know them.`
        : "Accept this connection link?\n\nThe person who made it will be able to send you attendance Pings. Only continue if you know them."
      if (!window.confirm(question)) return setToast({ id: Date.now(), message: "Connection cancelled." })
      try {
        const r = await (link.kind === "add" ? social.connectViaUid(link.value) : social.connectViaInvite(link.value))
        setToast({ id: Date.now(), message: r.message })
      } catch {
        setToast({ id: Date.now(), message: "Couldn't send the request. Try again." })
      }
    })()
  }, [pendingLink, sync.account, social.configured, social.status, social.name, social.anonymous, social.uid, isOnline])

  // Remind established users once they've had the app for two days. Existing installations without a timestamp
  // are treated as established; cloud sync is promoted only when a sync backend is configured.
  useEffect(() => {
    // Wait for persisted authentication to restore before deciding the user is signed out.
    // Otherwise this reminder flashes for existing Google-signed-in users on startup.
    if (!loaded || !consentReady || !consentAccepted || !sync.ready) {
      setShowSyncNudge(false)
      return
    }
    const evaluate = () => {
      try {
        const now = Date.now()
        let firstUsed = Number(localStorage.getItem("attendance-first-used-at") || 0)
        if (!firstUsed) {
          const existingData = subjects.length + tasks.length + mates.length > 0
          firstUsed = existingData ? now - 3 * 86400000 : now
          localStorage.setItem("attendance-first-used-at", String(firstUsed))
        }
        const dismissedAt = Number(localStorage.getItem("attendance-sync-nudge-dismissed-at") || 0)
        const setupStillIncomplete = localStorage.getItem("onboardingDone") !== "1"
        const eligible = setupStillIncomplete && sync.ready && cloudAvailable(sync.kind) && !sync.account && now - firstUsed >= 2 * 86400000 && now - dismissedAt >= 7 * 86400000
        setShowSyncNudge(eligible)
        if (sync.account) setShowSyncNudge(false)
      } catch {
        // Private mode may disable localStorage; never block the app because a reminder could not be saved.
      }
    }
    evaluate()
    const timer = window.setInterval(evaluate, 60_000)
    return () => window.clearInterval(timer)
  }, [loaded, consentReady, consentAccepted, subjects.length, tasks.length, mates.length, sync.kind, sync.account, sync.ready])

  // Rating prompt: first appearance after 48 hours, at most twice, with three days between appearances.
  useEffect(() => {
    if (!loaded || !consentReady || !consentAccepted) return
    const evaluateRatingPrompt = () => {
      try {
        const now = Date.now()
        let firstUsed = Number(localStorage.getItem("attendance-first-used-at") || 0)
        if (!firstUsed) {
          const existingData = subjects.length + tasks.length + mates.length > 0
          firstUsed = existingData ? now - 3 * 86400000 : now
          localStorage.setItem("attendance-first-used-at", String(firstUsed))
        }
        if (localStorage.getItem("attendance-rating-submitted") === "1") {
          setShowFeedbackNudge(false)
          return
        }
        const storedCount = localStorage.getItem("attendance-rating-prompt-count")
        const count = storedCount === null ? 0 : Math.max(0, Number(storedCount) || 0)
        const lastShown = Number(localStorage.getItem("attendance-rating-prompt-last-shown-at") || 0)
        if (storedCount === null && localStorage.getItem("attendance-feedback-prompt-dismissed") === "1") {
          localStorage.setItem("attendance-rating-prompt-count", "1")
          localStorage.setItem("attendance-rating-prompt-last-shown-at", String(now))
          return
        }
        const eligible = count === 0
          ? now - firstUsed >= 48 * 60 * 60 * 1000
          : count === 1 && now - lastShown >= 3 * 86400000
        if (eligible) {
          localStorage.setItem("attendance-rating-prompt-count", String(count + 1))
          localStorage.setItem("attendance-rating-prompt-last-shown-at", String(now))
          setShowFeedbackNudge(true)
        }
      } catch {
        // Rating prompts must never affect attendance recording.
      }
    }
    evaluateRatingPrompt()
    const timer = window.setInterval(evaluateRatingPrompt, 60_000)
    return () => window.clearInterval(timer)
  }, [loaded, consentReady, consentAccepted, subjects.length, tasks.length, mates.length])

  // Scanner apps often open the link in a temporary browser that forgets everything. Before marking anything there, try to
  // hand the scan to the real browser, once; the gate screen offers the same by button if that didn't happen.
  useEffect(() => {
    const ua = navigator.userAgent
    if (!new URLSearchParams(window.location.search).has("scan") || !isInAppBrowser(ua)) return
    setScanGate(true)
    try {
      if (sessionStorage.getItem("triedRealBrowser")) return
      sessionStorage.setItem("triedRealBrowser", "1")
    } catch {
      /* private mode: just show the gate */
    }
    const t = setTimeout(() => {
      const url = `${window.location.origin}/scan`
      window.location.href = /Android/.test(ua) ? chromeIntentUrl(url) : safariUrl(url)
    }, 400)
    return () => clearTimeout(t)
  }, [])

  // A scan opens a review as soon as local data is ready. The timing match is preselected, but no attendance is
  // written until the person confirms; all other unchecked classes today remain available as recovery options.
  useEffect(() => {
    if (!loaded || !consentReady || !consentAccepted || scanHandled.current || scanGate) return
    if (subjects.length === 0 && !sync.ready) return
    const params = new URLSearchParams(window.location.search)
    if (!params.has("scan")) return
    scanHandled.current = true
    window.history.replaceState(null, "", window.location.pathname) // a refresh must not mark a second time
    runScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, consentReady, consentAccepted, sync.ready, subjects.length, scanGate])


  /** Build the scan review: suggest one timing match and offer every other unchecked class today. */
  const runScan = () => {
    const review = prepareScanReview(subjects, new Date(), effectiveOverrides)
    // A newcomer with nothing set up is shown the welcome tour, which is already open, rather than an empty scan screen.
    let newcomer = false
    try {
      newcomer = review.result.kind === "idle" && review.result.reason === "no-subjects" && !localStorage.getItem("onboardingDone")
    } catch {
      /* private mode */
    }
    if (!newcomer) setScan({
      result: review.result,
      marked: null,
      phase: "review",
      options: review.options,
      suggested: review.suggested,
    })
  }

  // Developer tools (Settings): a timetable built around now, and manual triggers for the scan flow
  const addTestTimetable = (withOverlap: boolean) => {
    setSubjects((prev) => [...prev.filter((s) => !isTestSubject(s)), ...buildTestSubjects(new Date(), withOverlap)])
    showToast(withOverlap ? "Test timetable added, with a clashing class" : "Test timetable added for today")
  }
  const removeTestTimetable = () => {
    setSubjects((prev) => prev.filter((s) => !isTestSubject(s)))
    showToast("Test subjects removed")
  }
  const previewScan = () => {
    const now = new Date()
    const fake = buildTestSubjects(now)[0]
    setScan({ result: { kind: "mark", target: { subject: fake, slot: fake.slots![0] } }, marked: { subject: fake, slot: fake.slots![0] }, preview: true })
  }

  const setPlan = (id: string, date: string, value: "attend" | "skip" | null) =>
    patchSubject(id, (s) => {
      const plan = { ...(s.plan || {}) }
      if (value) plan[date] = value
      else delete plan[date]
      return { ...s, plan }
    })

  const mergeTags = (tags: string[]) => {
    const fresh = tags.filter((t) => !allTags.includes(t))
    if (fresh.length > 0) setAllTags([...allTags, ...fresh])
  }

  const handleAddSubject = (values: SubjectValues) => {
    if (!demoActiveRef.current) void recordProductUsageEvent("subject_create", "subjects")
    setSubjects([...subjects, { id: newId(), ...values }])
    mergeTags(values.tags)
    setIsAddOpen(false)
  }

  const handleEditSubject = (values: SubjectValues) => {
    if (editingSubjectId) {
      if (!demoActiveRef.current) void recordProductUsageEvent("subject_update", "subjects")
      patchSubject(editingSubjectId, (s) => ({ ...s, ...values }))
    }
    mergeTags(values.tags)
    setEditingSubjectId(null)
  }

  const handleDeleteSubject = (subject: Subject) => {
    if (!demoActiveRef.current) void recordProductUsageEvent("subject_delete", "subjects")
    setSubjects((prev) => prev.filter((s) => s.id !== subject.id))
    setEditingSubjectId(null)
    setDetailId(null)
    showToast(`Deleted ${subject.name}`, () => setSubjects((prev) => [...prev, subject]))
  }

  const handleDeleteTag = (tagToDelete: string) => {
    setAllTags(allTags.filter((tag) => tag !== tagToDelete))
    setSubjects(subjects.map((s) => ({ ...s, tags: s.tags.filter((tag) => tag !== tagToDelete) })))
  }

  const currentBackup = () => ({ ...latest.current, reminders: loadSchedule() })
  // Read at the moment of asking, and set the instant the demo starts or ends (not when React next renders)
  const demoIsActive = () => demoActiveRef.current

  /** Resolves true only if the reset really happened. A copy is kept under Settings > Backup & restore in case it was a slip. */
  const handleResetAllData = async (): Promise<boolean> => {
    const r = await resetEverything({
      current: currentBackup,
      saveRestorePoint,
      demoActive: demoIsActive,
      clearCloud: async () => {
        // Never sign out: target only the UID attached to the active sync account.
        const owner = sync.account?.id
        if (!owner) return // no authenticated cloud account exists on this device
        const existing = await cloudGet(owner)
        if (!existing) return // nothing stored for this account
        const empty = buildBackup({ subjects: [], tasks: [], tags: [], mates: [], reminders: [], holidays: [], scheduleOverrides: [] }, false)
        const result = await cloudPut(owner, empty, existing.rev)
        if (!result.ok) throw new Error(`Cloud reset failed: ${result.reason}`)
        const verify = await cloudGet(owner)
        if (!verify) throw new Error("Could not verify the account's cloud reset")
        const parsed = parseFullBackup(verify.data)
        if (!parsed.ok || parsed.data.subjects.length || parsed.data.tasks.length || parsed.data.tags.length || parsed.data.mates.length || (parsed.data.holidays?.length ?? 0) || (parsed.data.scheduleOverrides?.length ?? 0) || parsed.data.reminders.length) {
          throw new Error("Could not verify that this account's cloud data was cleared")
        }
      },
      clear: clearEverything,
      isCleared: resetIsComplete,
    })
    if (!r.ok) showToast(r.message) // never reset what could not be kept
    if (r.ok) {
      setUsageAnalyticsEnabled(false) // a full reset also withdraws the optional local analytics choice
      try { localStorage.removeItem("attendance-analytics-visitor-id") } catch {}
    }
    return r.ok
  }

  const clearEverything = () => {
    setSubjects([])
    setTasks([])
    setAllTags([])
    setMates([])
    setHolidays([])
    setScheduleOverrides([])
    demoSnapshot.current = null
    demoActiveRef.current = false
    setDemoLive(false)
    setDemoActive(false)
    setDemoTourOpen(false)
    // Everything this device keeps: data, reminders, ping records, seen-bubbles and the first-run flag (the theme stays)
    for (const key of RESET_LOCAL_KEYS) localStorage.removeItem(key)
    return Promise.all(RESET_DB_KEYS.map((key) => dbDel(key))).then(() => undefined)
  }

  // ---------- deadlines ----------
  const openDeadline = (task: Task | null, date: string) => setDeadlineEditor({ task, date })

  const saveDeadline = (values: DeadlineValues) => {
    const editing = deadlineEditor?.task
    if (!demoActiveRef.current) void recordProductUsageEvent(editing ? "task_update" : "task_create", "calendar")
    if (editing) {
      // `subjectId` may have been cleared, so it is set explicitly rather than merged
      setTasks((prev) => prev.map((t) => (t.id === editing.id ? { ...t, ...values, subjectId: values.subjectId } : t)))
    } else {
      setTasks((prev) => [...prev, { id: newId(), ...values }])
    }
    setDeadlineEditor(null)
    setCurrentPage("calendar")
    showToast(editing ? "Deadline updated" : "Deadline added")
  }

  const deleteDeadline = (task: Task) => {
    if (!demoActiveRef.current) void recordProductUsageEvent("task_delete", "calendar")
    setTasks((prev) => prev.filter((t) => t.id !== task.id))
    setDeadlineEditor(null)
    setConfirmDeadline(null)
    showToast(`Deleted ${task.title}`, () => setTasks((prev) => [...prev, task]))
  }

  /** Ticking a deadline keeps it in the Completed list; ticking it again brings it back */
  const toggleDeadlineDone = (task: Task) => {
    setConfirmDeadline(null)
    const done = !task.done
    if (!demoActiveRef.current) void recordProductUsageEvent(done ? "task_complete" : "task_reopen", "calendar")
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, done } : t)))
    showToast(done ? `Done · ${task.title}` : `Back on your list · ${task.title}`, () =>
      setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, done: !done } : t))),
    )
  }

  // ---------- developer tools (in Settings) ----------
  const testNotificationSetup = async () => {
    try {
      if (!("Notification" in window)) return alert("This browser cannot show notifications. You can still use the rest of College Tracker.")
      await enableNotifications()
      if (Notification.permission !== "granted") return alert("Notifications are turned off for this site. Allow them in your browser settings, then try again.")
      const registration = await registerServiceWorker()
      if (!registration) return alert("This device could not finish setting up alerts after you close the app. Local reminders can still run while the app is open.")
      const subscription = await subscribeToPushNotifications()
      const notificationShown = await sendLocalNotification("Attendance Tracker test", { body: "This device accepted a local notification request." })
      alert(!notificationShown
        ? "No test alert appeared. Check browser permission and try again. On iPhone or iPad, open the Home Screen app and retry setup."
        : subscription
          ? "Your test alert was displayed. This device is registered, but background friend alerts still depend on server setup. Class reminders in this version run while the app is open."
          : "Your test alert was displayed, but background delivery was not confirmed. Local reminders can still run while the app is open.")
    } catch (err) {
      console.error("Test notification error", err)
      alert("Notification setup could not be completed. " + (err instanceof Error ? err.message : "Please check your browser permissions and try again."))
    }
  }

  const testFcmToken = async () => {
    try {
      if (!("Notification" in window)) return alert("This browser does not support the background alert features needed for this check.")
      if (!("serviceWorker" in navigator)) return alert("This browser cannot register the background service needed for alerts after the app closes.")
      if (!("PushManager" in window)) return alert("This browser cannot register for background alerts. Local reminders may still work while the app is open.")

      let permission = Notification.permission
      if (permission === "default") permission = await Notification.requestPermission()
      if (permission !== "granted") return alert("Notifications are blocked for this site. Change the permission in browser settings and retry.")

      const vapidKey = getFirebaseVapidKey()
      if (!vapidKey) {
        alert("Background alert registration is not configured for this deployment. You can still use local reminders while the app is open. The app administrator needs to finish the notification service setup.")
        return
      }
      await navigator.serviceWorker.register(SW_URL, SW_OPTIONS)
      const registration = await navigator.serviceWorker.ready
      if (!registration.active) return alert("The background alert service is not ready yet. Refresh the page and try again.")

      const messaging = await getClientMessaging()
      if (!messaging) return alert("This browser or app setup cannot register for background alerts right now. Local reminders may still work while the app is open.")

      const { getToken } = await import("firebase/messaging")
      const token = await getToken(messaging, { vapidKey, serviceWorkerRegistration: registration })

      if (token) {
        // FCM registration tokens are private device endpoints; never print or display the token itself.
        alert("This device registered for background alerts. Actual delivery after the app closes still depends on the app server and browser support.")
      } else {
        alert("Background alert registration did not complete. Local reminders may still work while the app is open.")
      }
    } catch (error: unknown) {
      console.warn("FCM test could not register remote push.")
      alert(pushSetupMessage(error))
    }
  }

  // ---------- banner on Today: the single most important thing ----------
  const banner: Banner | null = (() => {
    if (!loaded) return null
    if (incomingRequests.length > 0) {
      const first = incomingRequests[0].fromName
      const more = incomingRequests.length - 1
      return { text: `${first}${more ? ` and ${more} more want` : " wants"} to be your proxy-mate`, tone: "info", target: "mates" }
    }
    const now = new Date()
    const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate()
    const owed = mates.reduce((n, m) => n + Math.max(0, m.covered - m.repaid), 0)
    if (owed > 0 && daysLeft <= 3) {
      return { text: `Month ends in ${daysLeft} day${daysLeft === 1 ? "" : "s"}. You owe your proxy-mates ${owed}.`, tone: "bad", target: "mates" }
    }
    // A deadline shows up here once it is as close as its own reminder setting (default 1 day; -1 = never)
    const due = tasks
      .filter((t) => !t.done)
      .map((t) => ({ t, d: daysUntil(t.dueDate), remind: t.remindDaysBefore ?? 1 }))
      .filter((x) => x.d >= 0 && x.remind >= 0 && x.d <= x.remind)
      .sort((a, b) => a.d - b.d)[0]
    if (due) {
      const when = due.d === 0 ? "today" : due.d === 1 ? "tomorrow" : `in ${due.d} days`
      return { text: `${due.t.title} is due ${when}`, tone: "warn", target: "calendar" }
    }
    const atRisk = subjects.filter((s) => getAttendance(s.attended, s.missed, s.requirement).status === "risk").length
    if (atRisk > 0) {
      return { text: `${atRisk} subject${atRisk === 1 ? " is" : "s are"} below the attendance requirement`, tone: "bad", target: "subjects" }
    }
    return null
  })()

  // ---------- navigation ----------
  const detailSubject = subjects.find((s) => s.id === detailId) ?? null
  const editingSubject = subjects.find((s) => s.id === editingSubjectId) ?? null

  /** Something to ping about for the simulators: today's first class, else the first subject */
  const demoItems = () => {
    const pick = classesOn(subjects, new Date())[0]
    const subject = pick?.subject ?? subjects[0]
    if (!subject) return [{ key: "demo@", subjectId: "demo", name: "Database Systems" }]
    const displayName = pick?.override?.kind === "substitute" ? `${pick.attendanceSubject?.name ?? pick.originalSubjectName} (held as ${pick.subject.name})` : subject.name
    return [{ key: `${pick?.attendanceSubject?.id ?? subject.id}@${pick?.slot.start ?? ""}`, subjectId: pick?.attendanceSubject?.id ?? subject.id, name: displayName, ...(pick ? { t: pick.slot.start, ...(pick.override?.kind === "substitute" ? { substituted: true } : {}) } : {}) }]
  }
  const demoMateName = () => mates.find((m) => m.uid)?.name ?? mates[0]?.name ?? "Arjun"

  /** Dummy trigger (Settings > Developer tools): a mate answers "yes, I covered you" to a ping */
  const simulateReply = () => {
    social.simulateReply(demoMateName(), demoItems(), "yes")
    setCurrentPage((p) => (p === "mates" ? "today" : p)) // the bubble only shows away from Mates
  }

  /** Dummy trigger (Settings > Developer tools): a mate asks whether you marked them present */
  const simulateIncoming = () => {
    social.simulateIncoming(demoMateName(), demoItems())
    setCurrentPage((p) => (p === "mates" ? "today" : p))
  }

  /** Developer-only trigger; the Wrapped card remains gated to Saturday by wrappedDue. */
  const simulateWrapped = () => {
    setWrappedForce(true)
    setCurrentPage((p) => (p === "mates" ? "today" : p))
  }

  const repayMate = (m: Mate): Mate => ({ ...m, repaid: Math.min(m.covered, m.repaid + 1), repaidLog: [...(m.repaidLog ?? []), localDate()] })
  /** Used from the wrapped story, where a toast would be hidden behind it */
  const repayQuiet = (id: string) => setMates((prev) => prev.map((m) => (m.id === id ? repayMate(m) : m)))

  const handleImportTimetable = (incoming: FinalSubject[], notes: string[]) => {
    const before = subjects
    const r = applyImport(subjects, incoming, notes)
    setSubjects(r.subjects)
    setCurrentPage("subjects")
    setDetailId(null)
    // The import sheet shows the review (and Undo), so no toast here
    return { summary: r.summary, undo: () => setSubjects(before) }
  }

  const goto = (page: string) => {
    const destination = page as Page
    setCurrentPage(destination)
    setDetailId(null)
    setCalendarFocusDate(null)
    try {
      // Only browsers that completed the first-run guide receive these one-time tab introductions.
      if (destination !== "today") {
        const key = `firstTabGuideSeen:${destination}`
        // Show each tab's guide once per browser. Mates is intentionally included for existing users
        // because its feature set changed substantially; Subjects/Calendar are also available on
        // their first post-update visit because earlier versions did not persist historic tab visits.
        if (!localStorage.getItem(key)) {
          localStorage.setItem(key, "1")
          setFirstVisitTourPage(destination)
        }
      }
    } catch {
      // Private browsing can disable persistence; don't block navigation.
    }
    window.scrollTo({ top: 0, behavior: "auto" })
  }

  const openTomorrowCalendar = (date: string) => {
    setCalendarFocusDate(date)
    setCurrentPage("calendar")
    setDetailId(null)
    window.scrollTo({ top: 0, behavior: "auto" })
  }

  /** Settings > "Try a demo": swaps in a full sample term so every screen has something worth looking at. Your own
   *  data is snapshotted first and put back exactly as it was on Exit demo. Demo data is never written to storage
   *  (see the persistence effects) and sync is paused, so it reaches neither this device's saved data nor the cloud. */
  const startDemo = () => {
    // App guide is illustrative and never swaps or mutates real user data.
    setIsSettingsOpen(false)
    setDemoTourOpen(true)
  }
  const exitDemo = () => {
    if (!demoActiveRef.current) { setDemoTourOpen(false); return }
    const release = tryAcquire("demo")
    if (!release) return showToast(BUSY_MESSAGE)
    const snap = demoSnapshot.current
    if (snap) {
      setSubjects(snap.subjects)
      setTasks(snap.tasks)
      setAllTags(snap.tags)
      setMates(snap.mates)
    }
    demoSnapshot.current = null
    demoActiveRef.current = false
    setDemoLive(false)
    setDemoActive(false)
    setDemoTourOpen(false)
    showToast("Demo ended. Your own data is back.")
    release()
  }
  const openSubject = (id: string) => {
    setCurrentPage("subjects")
    setDetailId(id)
    window.scrollTo({ top: 0 })
  }

  const addAction =
    currentPage === "subjects"
      ? { label: "Add subject", run: () => setIsAddOpen(true) }
      : currentPage === "calendar"
        ? { label: "Add deadline", run: () => openDeadline(null, localDate()) }
        : currentPage === "mates" && !!sync.account && isOnline === true
          ? { label: "Add mate", run: () => setIsMateOpen(true) }
          : null

  const caption =
    currentPage === "today"
      ? dateLabel
      : currentPage === "subjects"
        ? `${subjects.length} ${subjects.length === 1 ? "subject" : "subjects"}`
        : currentPage === "calendar"
          ? `${tasks.filter((t) => !t.done).length} open`
          : sync.account ? `${mates.length} ${mates.length === 1 ? "mate" : "mates"}` : isOnline === false ? "Offline · saved mates" : "Sign in required"

  // Home-screen shortcuts: /?go=mates opens a tab, /?mark=next marks the class that has started and isn't marked yet
  const pendingMark = useRef(false)
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const go = p.get("go")
    if (go && ["today", "subjects", "calendar", "mates"].includes(go)) setCurrentPage(go as Page)
    if (p.get("mark") === "next") {
      pendingMark.current = true
      setCurrentPage("today")
    }
    if (go || p.get("mark")) window.history.replaceState(null, "", window.location.pathname)
  }, [])

  useEffect(() => {
    if (!loaded || !pendingMark.current) return
    pendingMark.current = false
    const now = new Date()
    const nowMin = now.getHours() * 60 + now.getMinutes()
    const today = localDate(now)
    const next = classesOn(subjects, now, effectiveOverrides).find((c) => markFor(c.attendanceSubject ?? c.subject, today, c.slot.start) === null && toMin(c.slot.start) <= nowMin && !c.cancelled)
    if (next) setToday((next.attendanceSubject ?? next.subject).id, today, "P", { t: next.slot.start, k: next.slot.kind })
    else showToast("No unmarked class right now")
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  return (
    <div className="min-h-dvh text-foreground lg:pl-[88px]">
      {/* Stays up while demo data is on screen, so it's never mistaken for the real thing and Exit is always one tap away */}
      {demoActive && (
        <div data-tour-topbar className="fixed top-0 inset-x-0 z-[76] bg-ink text-paper pt-[env(safe-area-inset-top)] lg:left-[88px]">
          <div className="max-w-3xl mx-auto lg:max-w-[1280px] 2xl:max-w-[1440px] px-4 lg:px-10 h-10 flex items-center justify-between gap-3">
            <span className="text-[13px] font-semibold truncate">Viewing demo data</span>
            <button onClick={exitDemo} className="text-[13px] font-semibold underline underline-offset-2 flex-shrink-0">
              Exit demo
            </button>
          </div>
        </div>
      )}
      {/* One comfortable column up to 1024px; from there the content gets the room: side rail, wider frame, two columns */}
      <div className={`w-full max-w-3xl mx-auto pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] sm:pl-[max(1.5rem,env(safe-area-inset-left))] sm:pr-[max(1.5rem,env(safe-area-inset-right))] lg:max-w-[1280px] lg:px-10 2xl:max-w-[1440px] ${demoActive ? "pt-[calc(2.5rem+env(safe-area-inset-top))]" : ""}`}>
        {!detailSubject && (
          <header className={`pt-[calc(env(safe-area-inset-top)+16px)] ${currentPage === "today" ? "pb-5" : "pb-6"} flex items-center justify-between gap-3`}>
            <div className="min-w-0">
              <p className="text-[15px] text-mute leading-tight">{caption}</p>
              {currentPage !== "today" && <h1 className="font-display text-[clamp(26px,7.2vw,34px)] leading-[1.15] mt-0.5">{TITLES[currentPage]}</h1>}
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              {addAction && (
                <button onClick={addAction.run} aria-label={addAction.label} className={iconButton}>
                  <Plus weight="regular" className="w-[22px] h-[22px]" />
                </button>
              )}
              <button onClick={() => { setSettingsStartPanel("home"); setIsSettingsOpen(true) }} aria-label={myTickets.followUps.length ? "Settings, the developer replied to you" : "Settings"} className={`${iconButton} relative`}>
                <GearSix weight="regular" className="w-[22px] h-[22px]" />
                {myTickets.followUps.length > 0 && <span aria-hidden className="absolute right-1.5 top-1.5 h-2.5 w-2.5 rounded-full bg-bad ring-2 ring-background" />}
              </button>
            </div>
          </header>
        )}

        <main className={`${detailSubject ? "pt-[calc(env(safe-area-inset-top)+16px)]" : ""} pb-[calc(9rem+env(safe-area-inset-bottom))] lg:pb-16`}>
          {currentPage === "today" && (
            <TodayView
              subjects={subjects}
              scheduleOverrides={effectiveOverrides}
              onClassActions={(target) => setClassActionsTarget(target)}
              onSleep={(subject) => setSleepTarget(subject)}
              mates={mates}
              tasks={tasks}
              banner={banner}
              onSet={setToday}
              onOpenSubject={openSubject}
              onGoto={goto}
              onAddSubject={() => setIsAddOpen(true)}
              onOpenTomorrow={openTomorrowCalendar}
              demoActive={demoActive}
            />
          )}

          {currentPage === "subjects" &&
            (detailSubject ? (
              <SubjectDetail
                subject={detailSubject}
                allSubjects={subjects}
                scheduleOverrides={effectiveOverrides}
                onClassActions={(target) => setClassActionsTarget(target)}
                onSleep={(subject) => setSleepTarget(subject)}
                onBack={() => setDetailId(null)}
                onSet={(date, status, meta) => setToday(detailSubject.id, date, status, meta)}
                onEdit={() => setEditingSubjectId(detailSubject.id)}
                onDelete={() => setDeleteSubjectTarget(detailSubject)}
                onPlan={(date, value) => setPlan(detailSubject.id, date, value)}
              />
            ) : (
              <SubjectsView
                subjects={subjects}
                onOpen={openSubject}
                onAdd={() => setIsAddOpen(true)}
                onImport={() => setIsImportOpen(true)}
                onSleep={(subject) => setSleepTarget(subject)}
                onEditSubject={(id) => setEditingSubjectId(id)}
                onDeleteSubject={(id) => {
                  const subject = subjects.find((item) => item.id === id)
                  if (subject) setDeleteSubjectTarget(subject)
                }}
              />
            ))}

          {currentPage === "calendar" && (
            <CalendarView
              onSet={setToday}
              initialDate={calendarFocusDate}
              onInitialDateConsumed={() => setCalendarFocusDate(null)}
              tasks={tasks}
              subjects={subjects}
              holidays={holidays}
              scheduleOverrides={effectiveOverrides}
              onAddHoliday={(holiday) => {
                const name = holiday.name.trim()
                if (!name) return showToast("Enter a holiday name")
                const end = holiday.endDate ?? holiday.date
                if (end < holiday.date) return showToast("The end date must be on or after the start date")
                if (holidays.some(h => h.date === holiday.date && (h.endDate ?? h.date) === end && h.name.trim().toLowerCase() === name.toLowerCase())) return showToast("That holiday already exists")
                setHolidays(prev => [...prev, { id: newId(), date: holiday.date, ...(holiday.endDate ? { endDate: holiday.endDate } : {}), name }])
                showToast(end === holiday.date ? `${name} added to Calendar` : `${name} holiday range added`)
              }}
              onDeleteHoliday={(id) => setHolidays(prev => prev.filter(h => h.id !== id))}
              onClassActions={(target) => setClassActionsTarget(target)}
              onSleep={(subject) => setSleepTarget(subject)}
              onAdd={(date) => openDeadline(null, date)}
              onEdit={(t) => openDeadline(t, t.dueDate)}
              // Bringing a finished deadline back is harmless, so only marking one done asks first
              onToggleDone={(t) => (t.done ? toggleDeadlineDone(t) : setConfirmDeadline({ kind: "done", task: t }))}
            />
          )}

          {currentPage === "mates" && (
            (sync.account || isOnline !== true) ? <MatesView
              mates={mates}
              online={isOnline === true}
              social={social}
              onToast={(message) => showToast(message)}
              addOpen={isMateOpen}
              onCloseAdd={() => setIsMateOpen(false)}
              onOpenAdd={() => setIsMateOpen(true)}
              subjects={subjects}
              scheduleOverrides={effectiveOverrides}
              onOpenWrapped={openWrapped}
              showWrappedInPingSection={wrappedDue}
              onRemove={(id) => {
                const m = mates.find((x) => x.id === id)
                // removing a connected mate also ends the connection
                const link = m?.uid ? social.requests.find((r) => r.status === "accepted" && r.participants.includes(m.uid as string)) : undefined
                if (link) social.cancel(link.id).catch(() => {})
                // pings still waiting on this mate would never be answered
                social.sent.filter((p) => p.status === "asking" && (m?.uid ? p.to === m.uid : !p.to.startsWith("share-recipient:") && p.toName.trim().toLowerCase() === (m?.name ?? "").trim().toLowerCase())).forEach((p) => void social.cancelPing(p.id))
                setMates((prev) => prev.filter((x) => x.id !== id))
                if (m) showToast(`Removed ${m.name}`, () => setMates((prev) => [...prev, m]))
              }}
            /> : <MatesAccessGate sync={sync} social={social} onToast={showToast} />
          )}
        </main>
      </div>

      <ClassChangeSheet
        target={classActionsTarget}
        subjects={subjects}
        overrides={effectiveOverrides}
        onClose={() => setClassActionsTarget(null)}
        onCancelClass={(subjectId, date, start) => {
          setScheduleOverrides(prev => [...prev.filter(o => !(o.originalSubjectId === subjectId && o.date === date && o.start === start)), { id: newId(), originalSubjectId: subjectId, date, start, kind: "cancelled" }])
          showToast("Lecture cancelled for this date")
        }}
        onReplaceClass={(subjectId, date, start, substituteSubjectId) => {
          if (subjectId === substituteSubjectId) return showToast("Choose a different subject")
          setScheduleOverrides(prev => [...prev.filter(o => !(o.originalSubjectId === subjectId && o.date === date && o.start === start)), { id: newId(), originalSubjectId: subjectId, date, start, kind: "substitute", substituteSubjectId }])
          showToast("Substitute saved for this date")
        }}
        onRestore={(subjectId, date, start) => { if (effectiveOverrides.some((o) => isHolidayCancellation(o) && o.originalSubjectId === subjectId && o.date === date && o.start === start)) return showToast("A holiday cancels this class. Turn off \"Holidays cancel classes\" in Settings to attend it."); setScheduleOverrides(prev => prev.filter(o => !(o.originalSubjectId === subjectId && o.date === date && o.start === start))); showToast("Original lecture restored") }}
      />
      <SleepSubjectSheet
        subject={sleepTarget}
        onClose={() => setSleepTarget(null)}
        onSleep={(id, range) => {
          const s = subjects.find(x => x.id === id)
          if (!s) return
          patchSubject(id, x => ({ ...x, sleeping: true, sleepFrom: range.from, sleepUntil: range.until }))
          showToast(range.until === "forever"
            ? `${s.name} will sleep from ${range.from} until you wake it. Its timetable and attendance are preserved.`
            : `${s.name} will sleep from ${range.from} through ${range.until}. Its timetable and attendance are preserved.`)
        }}
        onWake={(id) => { const s = subjects.find(x => x.id === id); patchSubject(id, x => ({ ...x, sleeping: false, sleepFrom: undefined, sleepUntil: undefined })); if(s) showToast(`${s.name} is awake; its recurring classes are visible again.`) }}
      />

      {showSyncNudge && consentAccepted && !sync.account && (
        <div className="fixed z-[70] bottom-[calc(5.6rem+env(safe-area-inset-bottom))] left-3 right-3 sm:left-auto sm:right-5 sm:max-w-md rounded-2xl bg-ink text-paper shadow-xl p-3.5 flex items-start gap-3" role="status">
          <span className="w-9 h-9 rounded-xl bg-white/15 grid place-items-center flex-shrink-0">↗</span>
          <div className="min-w-0 flex-1"><p className="text-[14px] font-semibold">Keep your data safe across devices</p><p className="text-[12px] text-paper/75 leading-snug mt-0.5">Turn on Google sync to use your subjects and attendance marks on your other devices. Wait for “Up to date” before relying on the backup.</p><button onClick={() => { setSettingsStartPanel("sync"); setIsSettingsOpen(true); setShowSyncNudge(false) }} className="mt-2 text-[13px] font-bold underline underline-offset-2">Set up Google sync</button></div>
          <button aria-label="Dismiss sync reminder" onClick={() => { setShowSyncNudge(false); try { localStorage.setItem("attendance-sync-nudge-dismissed-at", String(Date.now())) } catch {} }} className="text-paper/75 text-xl leading-none px-1">×</button>
        </div>
      )}
      {showFeedbackNudge && consentAccepted && !showFeedback && !myRating && (
        <FeedbackNudge onRate={() => { setFeedbackKind("rating"); setShowFeedbackNudge(false); setShowFeedback(true) }} onDismiss={() => setShowFeedbackNudge(false)} />
      )}
      <FeedbackSheet key={feedbackKind} initialKind={feedbackKind} existingRating={myRating} open={showFeedback} onClose={() => setShowFeedback(false)} onSubmitted={(kind, changedRating) => { try { localStorage.setItem("attendance-feedback-submitted", "1"); if (kind === "rating") localStorage.setItem("attendance-rating-submitted", "1") } catch {}; setShowFeedbackNudge(false); showToast(changedRating ? "Rating updated" : "Feedback sent — thank you") }} />
      <FeedbackCelebration
        ticket={replyToShow}
        onClose={() => {
          if (!replyToShow) return
          if (previewTicket) return setPreviewTicket(null)
          setDismissedReplyIds((ids) => new Set(ids).add(replyToShow.id))
          myTickets.acknowledge(replyToShow.id)
          void markTicketSeen(replyToShow.id).catch(() => {})
        }}
        onViewThread={() => {
          if (!replyToShow) return
          const id = replyToShow.id
          if (previewTicket) setPreviewTicket(null)
          else { setDismissedReplyIds((ids) => new Set(ids).add(id)); myTickets.acknowledge(id) }
          setTicketsOpenId(id)
          setShowTickets(true)
        }}
      />
      <FixCheckIn
        key={myTickets.fixDue?.id ?? "none"}
        ticket={!replyToShow && !showTickets && !isSettingsOpen && !showFeedback ? myTickets.fixDue : null}
        onDone={() => { if (myTickets.fixDue) myTickets.snooze(myTickets.fixDue.id) }}
        onLater={() => { if (myTickets.fixDue) myTickets.snooze(myTickets.fixDue.id) }}
        onToast={(m) => showToast(m)}
      />
      <TicketsSheet
        open={showTickets}
        onClose={() => { setShowTickets(false); setTicketsOpenId(null) }}
        tickets={myTickets.tickets}
        openId={ticketsOpenId}
        onOpenFeedback={(kind) => { setShowTickets(false); setTicketsOpenId(null); setFeedbackKind(kind); setShowFeedback(true) }}
        onToast={(m) => showToast(m)}
      />
      <TermsGate
        open={loaded && onboardingResolved && consentReady && !consentAccepted}
        onAgree={(usageEnabled) => {
          try {
            localStorage.setItem(CONSENT_VERSION, "1")
            localStorage.setItem(USAGE_ANALYTICS_KEY, usageEnabled ? "1" : "0")
            if (!usageEnabled) localStorage.removeItem("attendance-analytics-visitor-id")
          } catch {}
          setUsageAnalyticsEnabled(usageEnabled)
          setConsentAccepted(true)
        }}
      />

      <BottomNav
        currentPage={currentPage}
        onPageChange={goto}
        badges={{ mates: sync.account ? incomingRequests.length + pingEvents.pending : 0 }}
      />
      <UndoToast toast={toast} onClose={closeToast} />

      {/* After a first sign-in on a device that already has data: compare and choose (see lib/signin-reconcile.ts) */}
      <ReconcileSheet sync={sync} />
      <SettingsSheet
        isOpen={isSettingsOpen && !(sync.reconcile?.offer && !sync.reconcile.declined)}
        onClose={() => { setIsSettingsOpen(false); setSettingsStartPanel("home") }}
        startPanel={settingsStartPanel}
        onResetConsent={() => { try { localStorage.removeItem(CONSENT_VERSION) } catch {}; setConsentAccepted(false); setConsentReady(true); setIsSettingsOpen(false) }}
        usageAnalyticsEnabled={usageAnalyticsEnabled}
        onUsageAnalyticsChange={(enabled) => {
          try {
            localStorage.setItem(USAGE_ANALYTICS_KEY, enabled ? "1" : "0")
            if (!enabled) localStorage.removeItem("attendance-analytics-visitor-id")
          } catch {}
          setUsageAnalyticsEnabled(enabled)
          showToast(enabled ? "Optional app-usage analytics enabled" : "Optional app-usage analytics disabled")
        }}
        onShowSyncNudge={() => { setShowSyncNudge(true); setIsSettingsOpen(false) }}
        onOpenFeedback={(kind) => { setFeedbackKind(kind); setIsSettingsOpen(false); setShowFeedback(true) }}
        myRating={myRating?.rating ?? null}
        holidaysCancelClasses={holidaysCancel}
        onHolidaysCancelClassesChange={(on) => { setHolidaysCancel(on); try { localStorage.setItem("holidaysCancelClasses", on ? "1" : "0") } catch {} }}
        ticketCount={myTickets.tickets.length}
        ticketAlert={myTickets.followUps[0] ? { id: myTickets.followUps[0].id, kind: myTickets.followUps[0].kind, title: ticketTitle(myTickets.followUps[0]), count: myTickets.followUps.length } : null}
        onOpenTickets={(id) => { setIsSettingsOpen(false); setTicketsOpenId(id ?? null); setShowTickets(true) }}
        onPreviewFeedbackAnimation={(kind) => setPreviewTicket({
          id: "preview", uid: null, userEmail: null, userName: null, kind: kind === "bug" ? "bug" : "suggestion", rating: null, status: "resolved", seenByUser: false, devReplyCount: 1,
          message: kind === "bug" ? "The calendar looks squashed on my phone." : "A dark mode schedule would be great.",
          developerReply: kind === "bug" ? "Found it: the date picker was opening inside half the form. It now opens full width. Update the app and let me know if it still looks off." : "Good idea. I have added it to the list and will start with a schedule that follows sunset.",
          createdAt: new Date(Date.now() - 2 * 86_400_000), repliedAt: new Date(),
        })}
        subjects={subjects}
        tasks={tasks}
        holidays={holidays}
        scheduleOverrides={scheduleOverrides}
        tags={allTags}
        mates={mates}
        onAddTag={(tag) => mergeTags([tag])}
        onDeleteTag={handleDeleteTag}
        onResetAllData={handleResetAllData}
        onImportData={async (data) => {
          // Resolves true only if the data was really replaced; the reminders follow the safety copy, never precede it
          const r = await restoreFrom(data, {
            current: currentBackup,
            saveRestorePoint,
            demoActive: demoIsActive,
            applyData: (d) => {
              setTasks(d.tasks)
              setAllTags(d.tags)
              // A JSON backup: everything comes back exactly as saved
              setSubjects(d.subjects)
              setMates(d.mates ?? [])
              if (d.holidays !== undefined) setHolidays(d.holidays)
              if (d.scheduleOverrides !== undefined) setScheduleOverrides(d.scheduleOverrides)
            },
            applyReminders: saveSchedule,
            readReminders: loadSchedule, // read back from storage, not the list that was just written
            dataPersisted,
          })
          if (!r.ok) showToast(r.message) // never replace what could not be kept
          return r.ok
        }}
        notificationSupported={notificationSupported}
        notificationPermission={notificationPermission}
        isSubscribed={isSubscribed}
        onEnableNotifications={enableNotifications}
        onImportTimetable={() => setIsImportOpen(true)}
        onToast={showToast}
        onTestNotification={testNotificationSetup}
        onTestFcm={testFcmToken}
        onSimulateReply={simulateReply}
        onSimulateIncoming={simulateIncoming}
        onSimulateWrapped={simulateWrapped}
        onShowWelcome={() => setIsOnboardingOpen(true)}
        onAddTestTimetable={addTestTimetable}
        onRemoveTestTimetable={removeTestTimetable}
        onSimulateScan={runScan}
        onPreviewScan={previewScan}
        sync={sync}
        demoActive={demoActive}
        onTryDemo={startDemo}
        onExitDemo={exitDemo}
      />

      <Onboarding
        open={isOnboardingOpen}
        onClose={finishOnboarding}
        subjects={subjects}
        currentName={social.name}
        onSetName={(n) => void social.setName(n)}
        showGoogleSyncPrompt={sync.ready && !sync.account}
        onOpenAccount={() => { setIsOnboardingOpen(false); setSettingsStartPanel("sync"); setIsSettingsOpen(true) }}
        onImportTimetable={() => setIsImportOpen(true)}
        onAddSubject={() => setIsAddOpen(true)}
        notificationSupported={notificationSupported}
        notificationPermission={notificationPermission}
        onEnableNotifications={enableNotifications}
        onOpenMates={() => setCurrentPage("mates")}
        onToast={showToast}
      />
      <TimetableImportSheet
        open={isImportOpen}
        onClose={() => setIsImportOpen(false)}
        existing={subjects}
        onImport={handleImportTimetable}
        onEditSubject={(id) => setEditingSubjectId(id)} // the review stays open underneath, so closing the editor lands back on it
      />
      <ScanCheckIn
        scan={scan}
        subjects={subjects}
        onConfirm={(targets) => scan && scanConfirm(targets, scan)}
        onUndo={scanUndo}
        onClose={() => setScan(null)}
      />
      {pingEvents.event && (
        <PingEventView
          event={pingEvents.event}
          onAnswer={pingEvents.answer}
          onFinish={pingEvents.finish}
          onLater={pingEvents.later}
          onAcknowledge={pingEvents.acknowledge}
          alertsOffer={pingEvents.alertsOffer}
          onEnableAlerts={pingEvents.enableAlerts}
        />
      )}
      <ScanGate open={scanGate} link={typeof window === "undefined" ? "" : `${window.location.origin}/scan`} onContinue={() => setScanGate(false)} />
      <DemoTour open={demoTourOpen} onEnd={exitDemo} />
      <FirstVisitTour page={firstVisitTourPage} onClose={() => setFirstVisitTourPage(null)} />
      <WrappedStory open={isWrappedOpen} onClose={() => setIsWrappedOpen(false)} subjects={subjects} mates={mates} onRepay={repayQuiet} />

      <SubjectSheet
        open={isAddOpen || editingSubject !== null}
        onClose={() => {
          setIsAddOpen(false)
          setEditingSubjectId(null)
        }}
        subject={editingSubject}
        subjectKey={editingSubjectId}
        existingTags={allTags}
        onSubmit={editingSubject ? handleEditSubject : handleAddSubject}
      />

      <Sheet
        open={deleteSubjectTarget !== null}
        onClose={() => setDeleteSubjectTarget(null)}
        title="Delete this subject?"
      >
        <p className="text-[14px] text-mute leading-relaxed">
          <span className="font-semibold text-ink">{deleteSubjectTarget?.name}</span> and its saved attendance history will be removed from this device’s subject list. This can be undone briefly after deletion.
        </p>
        <div className="grid grid-cols-2 gap-2 mt-5">
          <button type="button" onClick={() => setDeleteSubjectTarget(null)} className={tintButton}>Cancel</button>
          <button type="button" onClick={() => {
            if (deleteSubjectTarget) handleDeleteSubject(deleteSubjectTarget)
            setDeleteSubjectTarget(null)
          }} className="h-12 rounded-xl bg-bad text-white text-[15px] font-semibold">Delete subject</button>
        </div>
      </Sheet>
      <DeadlineSheet
        open={deadlineEditor !== null}
        onClose={() => setDeadlineEditor(null)}
        task={deadlineEditor?.task ?? null}
        defaultDate={deadlineEditor?.date ?? localDate()}
        subjects={subjects}
        onSubmit={saveDeadline}
        onDelete={deadlineEditor?.task ? () => setConfirmDeadline({ kind: "delete", task: deadlineEditor.task as Task }) : undefined}
      />

      <Sheet
        open={confirmDeadline !== null}
        onClose={() => setConfirmDeadline(null)}
        title={confirmDeadline?.kind === "delete" ? "Delete this deadline?" : "Mark it as done?"}
      >
        {confirmDeadline && (
          <>
            <p className="text-[15px] text-mute leading-snug mb-5">
              {confirmDeadline.kind === "delete" ? (
                <>
                  <span className="text-ink font-semibold">{confirmDeadline.task.title}</span> will be removed for good. You can undo it for a few seconds.
                </>
              ) : (
                <>
                  <span className="text-ink font-semibold">{confirmDeadline.task.title}</span> moves to Completed. You can bring it back from there.
                </>
              )}
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button onClick={() => setConfirmDeadline(null)} className={`${tintButton} h-[52px] text-[17px]`}>
                {confirmDeadline.kind === "delete" ? "Keep it" : "Not yet"}
              </button>
              <button
                onClick={() => (confirmDeadline.kind === "delete" ? deleteDeadline(confirmDeadline.task) : toggleDeadlineDone(confirmDeadline.task))}
                className={`h-[52px] rounded-2xl text-paper text-[17px] font-semibold ${confirmDeadline.kind === "delete" ? "bg-bad" : "bg-ink"}`}
              >
                {confirmDeadline.kind === "delete" ? "Delete" : "Yes, done"}
              </button>
            </div>
          </>
        )}
      </Sheet>
    </div>
  )
}
