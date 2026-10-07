"use client"

import { useState, useEffect, useCallback, useRef } from "react"
import { GearSix, Plus } from "@phosphor-icons/react"
import { useNotifications } from "@/hooks/use-notifications"
import {
  registerServiceWorker,
  subscribeToPushNotifications,
  sendLocalNotification,
  onMessageListener,
} from "@/lib/notifications"
import { getClientMessaging } from "@/lib/firebase"
import type { Subject, Task, Mate, Ping, LogEntry } from "@/lib/types"
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
import { usePingEvents } from "@/lib/use-ping-events"
import { usePingProcessing } from "@/lib/use-ping-processing"
import { applyPingResult, resultIsSaved } from "@/lib/ping-apply"
import PingEventView from "@/components/ping-event"
import { loadSchedule } from "@/lib/reminders"
import { useSocial } from "@/lib/use-social"
import { useCloudSync } from "@/hooks/use-cloud-sync"
import BottomNav from "@/components/bottom-nav"
import SubjectSheet, { type SubjectValues } from "@/components/subject-sheet"
import DeadlineSheet, { type DeadlineValues } from "@/components/deadline-sheet"
import Sheet, { tintButton } from "@/components/sheet"
import TodayView, { type Banner } from "@/components/today-view"
import SubjectsView from "@/components/subjects-view"
import SubjectDetail from "@/components/subject-detail"
import CalendarView from "@/components/calendar-view"
import MatesView from "@/components/mates-view"
import SettingsSheet from "@/components/settings-sheet"
import TimetableImportSheet from "@/components/timetable-import-sheet"
import Onboarding from "@/components/onboarding"
import ScanCheckIn, { type ScanState } from "@/components/scan-check-in"
import ScanGate from "@/components/scan-gate"
import DemoTour from "@/components/demo-tour"
import { buildDemoData } from "@/lib/demo-data"
import { isInAppBrowser, safariUrl, chromeIntentUrl } from "@/lib/in-app"
import { pickScanTarget } from "@/lib/scan"
import { buildTestSubjects, isTestSubject } from "@/lib/scan-test"
import WrappedStory from "@/components/wrapped-story"
import UndoToast, { type ToastState } from "@/components/undo-toast"

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
  const [allTags, setAllTags] = useState<string[]>([])
  const [detailId, setDetailId] = useState<string | null>(null)
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
  const [isImportOpen, setIsImportOpen] = useState(false)
  const [scan, setScan] = useState<ScanState | null>(null)
  const scanBefore = useRef<{ id: string; date: string; t: string; prev: LogEntry | null } | null>(null) // the class a scan marked and what it was before, for Undo
  const [demoActive, setDemoActive] = useState(false)
  const [demoTourOpen, setDemoTourOpen] = useState(false)
  const demoSnapshot = useRef<{ subjects: Subject[]; tasks: Task[]; tags: string[]; mates: Mate[] } | null>(null)
  const scanHandled = useRef(false)
  const [scanGate, setScanGate] = useState(false) // a scan opened inside a scanner app's temporary browser
  const scanMarks = useRef<{ id: string; date: string; t: string; k?: string }[]>([]) // marks made by scanning this visit
  const [isWrappedOpen, setIsWrappedOpen] = useState(false)
  const [isOnboardingOpen, setIsOnboardingOpen] = useState(false)

  const [toast, setToast] = useState<ToastState | null>(null)

  const { notificationSupported, notificationPermission, enableNotifications } = useNotifications()
  const social = useSocial()
  const [pendingLink, setPendingLink] = useState<{ kind: "add" | "invite"; value: string } | null>(null)

  // ---------- load / persist ----------
  // The working copy lives in IndexedDB (lib/db.ts), which also moves over anything an older version left in localStorage.
  // Nothing is written back until this has finished, so an empty screen can never overwrite saved data.
  useEffect(() => {
    let alive = true
    void (async () => {
      const [savedSubjects, savedTasks, savedTags, savedMates] = await Promise.all([
        dbGet<Subject[]>("subjects"),
        dbGet<Task[]>("tasks"),
        dbGet<string[]>("tags"),
        dbGet<Mate[]>("mates"),
      ])
      if (!alive) return
      if (Array.isArray(savedSubjects)) {
        setSubjects(savedSubjects)
        setAllTags(Array.from(new Set(savedSubjects.flatMap((s) => s.tags || []))))
      }
      if (Array.isArray(savedTasks)) setTasks(savedTasks)
      if (Array.isArray(savedTags)) setAllTags(savedTags)
      if (Array.isArray(savedMates)) setMates(savedMates)

      // Habit tracker, to-do list and tutorial were removed; drop their leftovers
      for (const key of ["todos", "binTodos", "binClearDate", "habits", "tutorialSeen"]) localStorage.removeItem(key)

      setDateLabel(new Date().toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" }))
      setLoaded(true)
      void protectStorage() // ask the browser not to evict this data when the device runs low on space
    })()
    return () => {
      alive = false
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
    if (loaded && !demoActive) void dbSet("subjects", subjects)
  }, [subjects, loaded, demoActive])
  useEffect(() => {
    if (loaded && !demoActive) void dbSet("tasks", tasks)
  }, [tasks, loaded, demoActive])
  useEffect(() => {
    if (loaded && !demoActive) void dbSet("tags", allTags)
  }, [allTags, loaded, demoActive])
  useEffect(() => {
    if (loaded && !demoActive) void dbSet("mates", mates)
  }, [mates, loaded, demoActive])

  // ---------- friend connections ----------
  // Opening someone's QR code or link lands here as ?add=<id> or ?invite=<token>
  useEffect(() => {
    const p = new URLSearchParams(window.location.search)
    const add = p.get("add")
    const inv = p.get("invite")
    if (add || inv) {
      setPendingLink({ kind: add ? "add" : "invite", value: (add || inv) as string })
      window.history.replaceState(null, "", window.location.pathname)
      setCurrentPage("mates")
    }
  }, [])

  useEffect(() => {
    if (currentPage === "mates") social.enable()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage])

  useEffect(() => {
    if (!pendingLink) return
    if (!social.configured) {
      setToast({ id: Date.now(), message: "Friend connections aren't set up in this app yet." })
      setPendingLink(null)
      return
    }
    social.enable()
    if (social.status !== "ready" || !social.name) return // waits for sign-in and for a name
    const link = pendingLink
    setPendingLink(null)
    const run = link.kind === "add" ? social.connectViaUid(link.value) : social.connectViaInvite(link.value)
    run
      .then((r) =>
        setToast({
          id: Date.now(),
          // A browser with no Google account keeps this connection on this browser only
          message: r.ok && social.anonymous && social.uid && !social.uid.startsWith("mock-") ? `${r.message} Sign in with Google in Settings to keep your mates on all your devices.` : r.message,
        }),
      )
      .catch(() => setToast({ id: Date.now(), message: "Couldn't send the request. Try again." }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingLink, social.status, social.name])

  // Accepted connections appear in the favour ledger
  useEffect(() => {
    if (!loaded || !social.uid) return
    const accepted = social.requests.filter((r) => r.status === "accepted")
    if (accepted.length === 0) return
    // A mate who reconnected under a new account id is the same person: their old row takes the new id and keeps its history
    setMates((prev) =>
      adoptConnections(
        prev,
        accepted.flatMap((r) => {
          const other = r.participants.find((p) => p !== social.uid)
          return other ? [{ uid: other, name: r.from === social.uid ? r.toName : r.fromName }] : []
        }),
      ),
    )
  }, [social.requests, social.uid, loaded])

  const incomingRequests = social.requests.filter((r) => r.status === "pending" && r.to === social.uid)

  // ---------- pings: "did you mark me present?" ----------
  // What is put in front of you (a request to answer, or the answer to your own) is decided by the Ping events further
  // down. Here the answers you receive are applied to your own data, safely: see lib/ping-processing.ts.
  const demoActiveRef = useRef(false)
  demoActiveRef.current = demoActive

  /**
   * Applies an answer to this device's data and confirms it is really saved before saying so. It may run more than once
   * for the same Ping (after a crash, a reload, or on another device) and the second time changes nothing.
   */
  const applyDurably = async (p: Ping): Promise<boolean> => {
    if (demoActiveRef.current) return false // demo data is never saved, so there is nothing safe to confirm
    const r = applyPingResult(latestSubjects.current, latestMates.current, p)
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
    pings: social.sent,
    enabled: loaded && !demoActive,
    deps: { lease: social.leasePing, apply: applyDurably, finalize: social.finalizePing },
  })

  // ---------- weekly wrapped ----------
  // From each Monday the previous week's wrapped is "due" (if you marked anything in it), until you open it.
  const [wrappedSeen, setWrappedSeen] = useState<string | null | undefined>(undefined)
  const [wrappedForce, setWrappedForce] = useState(false) // set by the Settings simulator
  useEffect(() => {
    if (loaded) setWrappedSeen(localStorage.getItem("wrappedSeenWeek"))
  }, [loaded])

  const lastWeek = loaded ? lastWeekInfo(subjects) : null
  const wrappedDue = !!lastWeek && wrappedSeen !== undefined && (wrappedForce || (lastWeek.hasData && wrappedSeen !== lastWeek.key))
  const wrappedNotice =
    wrappedDue && lastWeek && currentPage !== "mates"
      ? { key: `wrapped-${lastWeek.key}${wrappedForce ? "-demo" : ""}`, initial: "\u2605", text: "Your week wrapped is ready" }
      : null

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
      if (localStorage.getItem("onboardingDone")) return
      if (subjects.length === 0 && mates.length === 0) setIsOnboardingOpen(true)
      else localStorage.setItem("onboardingDone", "1")
    } catch {
      /* private mode: skip the tour rather than show it every time */
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded])

  const finishOnboarding = () => {
    setIsOnboardingOpen(false)
    try {
      localStorage.setItem("onboardingDone", "1")
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
    enabled: loaded && !demoActive,
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
    const { next, undo } = markWithUndo(s, date, status, meta)
    latestSubjects.current = latestSubjects.current.map((x) => (x.id === id ? next : x))
    patchSubject(id, (x) => markWithUndo(x, date, status, meta).next)
    const now = getAttendance(next.attended, next.missed, next.requirement)
    const verb = status === "P" ? "Present" : status === "A" ? "Absent" : "Cleared"
    const when = date === localDate() ? "" : ` · ${formatDayMonth(date)}`
    showToast(`${verb} · ${s.name}${when}${now.total ? ` · now ${now.pct}%` : ""}`, () => patchSubject(id, undo))
  }

  // A scanned QR code or tapped NFC tag opens the app at /scan (see next.config.mjs). Marking present here, and only
  // here, plays the check-in celebration.
  const scanMark = (target: ClassSlot, result: ScanState["result"], from: Subject[] = subjects) => {
    const before = from.find((x) => x.id === target.subject.id)
    if (!before) return
    scanBefore.current = { id: before.id, date: localDate(), t: target.slot.start, prev: entryFor(before, localDate(), target.slot.start) }
    scanMarks.current.push({ id: before.id, date: localDate(), t: target.slot.start, k: target.slot.kind })
    patchSubject(before.id, (x) => withSet(x, localDate(), "P", { t: target.slot.start, k: target.slot.kind }))
    setScan({ result, marked: target })
  }

  const scanUndo = () => {
    if (scan?.preview) return setScan(null)
    const before = scanBefore.current
    if (before) patchSubject(before.id, (x) => restoreMark(x, before.date, before.t, before.prev)) // only the scanned class goes back
    scanMarks.current = scanMarks.current.filter((m) => m.id !== before?.id)
    scanBefore.current = null
    setScan(null)
  }

  // Data kept in step across browsers through a sync code
  const sync = useCloudSync({
    loaded,
    data: { subjects, tasks, tags: allTags, mates },
    paused: demoActive, // demo data must never overwrite, or be overwritten by, the real synced copy
    apply: (d) => {
      // A scan does not wait for sync. If the synced copy arrives afterwards without that mark, put it back.
      const kept = scanMarks.current.length
        ? d.subjects.map((s) => {
            const m = scanMarks.current.find((x) => x.id === s.id)
            return m && markFor(s, m.date, m.t) === null ? withSet(s, m.date, "P", { t: m.t, k: m.k }) : s
          })
        : d.subjects
      setSubjects(kept)
      setTasks(d.tasks)
      setAllTags(d.tags)
      setMates(d.mates)
    },
    notify: (m) => showToast(m),
  })

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

  // A scan marks straight away when this browser already has a timetable, and syncs in the background. Only a browser
  // with nothing in it waits, because the synced copy is the only place a timetable can come from.
  useEffect(() => {
    if (!loaded || scanHandled.current || scanGate) return
    if (subjects.length === 0 && !sync.ready) return
    const params = new URLSearchParams(window.location.search)
    if (!params.has("scan")) return
    scanHandled.current = true
    window.history.replaceState(null, "", window.location.pathname) // a refresh must not mark a second time
    runScan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, sync.ready, subjects.length, scanGate])


  /** What a scan does: pick the class that fits this moment and mark it, or ask */
  const runScan = () => {
    const result = pickScanTarget(subjects, new Date())
    if (result.kind === "mark") return scanMark(result.target, result)
    // A newcomer with nothing set up is shown the welcome tour, which is already open, rather than an empty scan screen
    let newcomer = false
    try {
      newcomer = result.kind === "idle" && result.reason === "no-subjects" && !localStorage.getItem("onboardingDone")
    } catch {
      /* private mode */
    }
    if (!newcomer) setScan({ result, marked: null })
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
    setSubjects([...subjects, { id: newId(), ...values }])
    mergeTags(values.tags)
    setIsAddOpen(false)
  }

  const handleEditSubject = (values: SubjectValues) => {
    if (editingSubjectId) patchSubject(editingSubjectId, (s) => ({ ...s, ...values }))
    mergeTags(values.tags)
    setEditingSubjectId(null)
  }

  const handleDeleteSubject = (subject: Subject) => {
    setSubjects((prev) => prev.filter((s) => s.id !== subject.id))
    setEditingSubjectId(null)
    setDetailId(null)
    showToast(`Deleted ${subject.name}`, () => setSubjects((prev) => [...prev, subject]))
  }

  const handleDeleteTag = (tagToDelete: string) => {
    setAllTags(allTags.filter((tag) => tag !== tagToDelete))
    setSubjects(subjects.map((s) => ({ ...s, tags: s.tags.filter((tag) => tag !== tagToDelete) })))
  }

  const handleResetAllData = async () => {
    // A reset is deliberate, but a copy is kept under Settings > Backup & restore in case it was a slip
    await saveRestorePoint("Before reset", { subjects, tasks, tags: allTags, mates, reminders: loadSchedule() })
    setSubjects([])
    setTasks([])
    setAllTags([])
    setMates([])
    demoSnapshot.current = null
    setDemoActive(false)
    setDemoTourOpen(false)
    void sync.signOut() // a reset must not wipe the copy your other browsers rely on
    // Everything this device keeps: data, reminders, ping records, seen-bubbles and the first-run flag (the theme stays)
    for (const key of [
      "subjects", "tasks", "tags", "mates", "notificationSchedule", "pingSeenIds", "appliedPings", "pingPresented", "pingSendKeys",
      "wrappedSeenWeek", "demo-pings", "mock-pings", "subjectsView", "onboardingDone",
    ])
      localStorage.removeItem(key)
    for (const key of ["subjects", "tasks", "tags", "mates", "syncBase"]) void dbDel(key)
  }

  // ---------- deadlines ----------
  const openDeadline = (task: Task | null, date: string) => setDeadlineEditor({ task, date })

  const saveDeadline = (values: DeadlineValues) => {
    const editing = deadlineEditor?.task
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
    setTasks((prev) => prev.filter((t) => t.id !== task.id))
    setDeadlineEditor(null)
    setConfirmDeadline(null)
    showToast(`Deleted ${task.title}`, () => setTasks((prev) => [...prev, task]))
  }

  /** Ticking a deadline keeps it in the Completed list; ticking it again brings it back */
  const toggleDeadlineDone = (task: Task) => {
    setConfirmDeadline(null)
    const done = !task.done
    setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, done } : t)))
    showToast(done ? `Done · ${task.title}` : `Back on your list · ${task.title}`, () =>
      setTasks((prev) => prev.map((t) => (t.id === task.id ? { ...t, done: !done } : t))),
    )
  }

  // ---------- developer tools (in Settings) ----------
  const testNotificationSetup = async () => {
    try {
      await enableNotifications()
      await registerServiceWorker()
      const subscription = await subscribeToPushNotifications()
      if (subscription) {
        alert("FCM token obtained. Notifications will be sent automatically at scheduled times.")
      } else {
        await sendLocalNotification("Test Notification", { body: "Local notification test - FCM not available" })
        alert("Local notification shown (FCM not available)")
      }
    } catch (err) {
      console.error("Test notification error", err)
      alert("Failed to set up notifications: " + (err instanceof Error ? err.message : String(err)))
    }
  }

  const testFcmToken = async () => {
    try {
      if (!("serviceWorker" in navigator)) return alert("Service Workers not supported in this browser")
      if (!("PushManager" in window)) return alert("Push notifications not supported in this browser")

      let permission = Notification.permission
      if (permission === "default") permission = await Notification.requestPermission()
      if (permission !== "granted") return alert("Notification permission denied")

      const registration = await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
      await navigator.serviceWorker.ready

      const messaging = await getClientMessaging()
      if (!messaging) return alert("Messaging not supported")

      const { getToken } = await import("firebase/messaging")
      const token = await getToken(messaging, {
        vapidKey: process.env.NEXT_PUBLIC_FIREBASE_VAPID_KEY,
        serviceWorkerRegistration: registration,
      })

      if (token) {
        console.log("FCM Token:", token)
        alert(`FCM Token obtained!\nCheck console for full token.\n\nToken preview: ${token.substring(0, 50)}...`)
      } else {
        alert("No FCM token received")
      }
    } catch (error: any) {
      console.error("Error getting FCM token:", error)
      let errorMsg = error?.message || "Unknown error"
      if (errorMsg.includes("push service error")) {
        errorMsg =
          "Push service error - This may happen on localhost.\n\nTry:\n1. Use Chrome/Edge\n2. Check Firebase Console for valid VAPID key\n3. Test on HTTPS domain"
      }
      alert("Error: " + errorMsg)
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
    return [{ key: `${subject.id}@${pick?.slot.start ?? ""}`, subjectId: subject.id, name: subject.name, ...(pick ? { t: pick.slot.start } : {}) }]
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

  /** Dummy trigger (Settings > Developer tools): make the weekly wrapped bubble appear as if it were Monday */
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
    setCurrentPage(page as Page)
    setDetailId(null)
    window.scrollTo({ top: 0 })
  }

  /** Settings > "Try a demo": swaps in a full sample term so every screen has something worth looking at. Your own
   *  data is snapshotted first and put back exactly as it was on Exit demo. Demo data is never written to storage
   *  (see the persistence effects) and sync is paused, so it reaches neither this device's saved data nor the cloud. */
  const startDemo = () => {
    demoSnapshot.current = { subjects, tasks, tags: allTags, mates }
    const demo = buildDemoData(new Date())
    setSubjects(demo.subjects)
    setTasks(demo.tasks)
    setAllTags(demo.tags)
    setMates(demo.mates)
    setDetailId(null)
    setDemoActive(true)
    setCurrentPage("today")
    setIsSettingsOpen(false)
    setDemoTourOpen(true)
  }

  const exitDemo = () => {
    const snap = demoSnapshot.current
    if (snap) {
      setSubjects(snap.subjects)
      setTasks(snap.tasks)
      setAllTags(snap.tags)
      setMates(snap.mates)
    }
    demoSnapshot.current = null
    setDemoActive(false)
    setDemoTourOpen(false)
    showToast("Demo ended. Your own data is back.")
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
        : currentPage === "mates"
          ? { label: "Add mate", run: () => setIsMateOpen(true) }
          : null

  const caption =
    currentPage === "today"
      ? dateLabel
      : currentPage === "subjects"
        ? `${subjects.length} ${subjects.length === 1 ? "subject" : "subjects"}`
        : currentPage === "calendar"
          ? `${tasks.filter((t) => !t.done).length} open`
          : `${mates.length} ${mates.length === 1 ? "mate" : "mates"}`

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
    const next = classesOn(subjects, now).find((c) => markFor(c.subject, today, c.slot.start) === null && toMin(c.slot.start) <= nowMin)
    if (next) setToday(next.subject.id, today, "P", { t: next.slot.start, k: next.slot.kind })
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
              <button onClick={() => setIsSettingsOpen(true)} aria-label="Settings" className={iconButton}>
                <GearSix weight="regular" className="w-[22px] h-[22px]" />
              </button>
            </div>
          </header>
        )}

        <main className={`${detailSubject ? "pt-[calc(env(safe-area-inset-top)+16px)]" : ""} pb-[calc(9rem+env(safe-area-inset-bottom))] lg:pb-16`}>
          {currentPage === "today" && (
            <TodayView
              subjects={subjects}
              mates={mates}
              tasks={tasks}
              banner={banner}
              onSet={setToday}
              onOpenSubject={openSubject}
              onGoto={goto}
              onAddSubject={() => setIsAddOpen(true)}
            />
          )}

          {currentPage === "subjects" &&
            (detailSubject ? (
              <SubjectDetail
                subject={detailSubject}
                onBack={() => setDetailId(null)}
                onSet={(date, status, meta) => setToday(detailSubject.id, date, status, meta)}
                onEdit={() => setEditingSubjectId(detailSubject.id)}
                onPlan={(date, value) => setPlan(detailSubject.id, date, value)}
              />
            ) : (
              <SubjectsView subjects={subjects} onOpen={openSubject} onAdd={() => setIsAddOpen(true)} onImport={() => setIsImportOpen(true)} />
            ))}

          {currentPage === "calendar" && (
            <CalendarView
              onSet={setToday}
              tasks={tasks}
              subjects={subjects}
              onAdd={(date) => openDeadline(null, date)}
              onEdit={(t) => openDeadline(t, t.dueDate)}
              // Bringing a finished deadline back is harmless, so only marking one done asks first
              onToggleDone={(t) => (t.done ? toggleDeadlineDone(t) : setConfirmDeadline({ kind: "done", task: t }))}
            />
          )}

          {currentPage === "mates" && (
            <MatesView
              mates={mates}
              social={social}
              onToast={(message) => showToast(message)}
              addOpen={isMateOpen}
              onCloseAdd={() => setIsMateOpen(false)}
              onAdd={(name) => setMates((prev) => [...prev, { id: newId(), name, covered: 0, repaid: 0 }])}
              subjects={subjects}
              onOpenWrapped={openWrapped}
              onRemove={(id) => {
                const m = mates.find((x) => x.id === id)
                // removing a connected mate also ends the connection
                const link = m?.uid ? social.requests.find((r) => r.status === "accepted" && r.participants.includes(m.uid as string)) : undefined
                if (link) social.cancel(link.id).catch(() => {})
                // pings still waiting on this mate would never be answered
                social.sent.filter((p) => p.status === "asking" && (p.to === m?.uid || p.toName === m?.name)).forEach((p) => void social.cancelPing(p.id))
                setMates((prev) => prev.filter((x) => x.id !== id))
                if (m) showToast(`Removed ${m.name}`, () => setMates((prev) => [...prev, m]))
              }}
            />
          )}
        </main>
      </div>

      <BottomNav
        currentPage={currentPage}
        onPageChange={goto}
        badges={{ mates: incomingRequests.length + pingEvents.pending + (wrappedDue ? 1 : 0) }}
        cover={wrappedNotice}
      />
      <UndoToast toast={toast} onClose={closeToast} />

      <SettingsSheet
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
        subjects={subjects}
        tasks={tasks}
        tags={allTags}
        mates={mates}
        onAddTag={(tag) => mergeTags([tag])}
        onDeleteTag={handleDeleteTag}
        onResetAllData={handleResetAllData}
        onImportData={async (data) => {
          await saveRestorePoint("Before restoring a backup", { subjects, tasks, tags: allTags, mates, reminders: loadSchedule() })
          setTasks(data.tasks)
          setAllTags(data.tags)
          // A JSON backup: everything comes back exactly as saved
          setSubjects(data.subjects)
          setMates(data.mates ?? [])
        }}
        notificationSupported={notificationSupported}
        notificationPermission={notificationPermission}
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
        onPick={(t) => scan && scanMark(t, scan.result)}
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
      <DemoTour open={demoTourOpen} onGoto={goto} onOpenWrapped={openWrapped} onEnd={() => setDemoTourOpen(false)} />
      <WrappedStory open={isWrappedOpen} onClose={() => setIsWrappedOpen(false)} subjects={subjects} mates={mates} onRepay={repayQuiet} />

      <SubjectSheet
        open={isAddOpen || editingSubject !== null}
        onClose={() => {
          setIsAddOpen(false)
          setEditingSubjectId(null)
        }}
        subject={editingSubject}
        existingTags={allTags}
        onSubmit={editingSubject ? handleEditSubject : handleAddSubject}
        onDelete={editingSubject ? () => handleDeleteSubject(editingSubject) : undefined}
      />
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
