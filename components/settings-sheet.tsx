"use client"

import { useEffect, useState } from "react"
import { getAuth, onAuthStateChanged } from "firebase/auth"
import { app } from "@/lib/firebase"
import { BellRinging, Bell, CalendarPlus, CaretRight, CircleHalf, FloppyDisk, Sparkle, Tag, Trash, Info, Star, Bug, Lightbulb, UserCircle } from "@phosphor-icons/react"
import Sheet, { Segmented, tintButton } from "./sheet"
import { RemindersList, ReminderEditor } from "./settings-reminders"
import ScanPanel from "./settings-scan"
import SyncPanel from "./settings-sync"
import RestorePoints from "./restore-points"
import type { CloudSync } from "@/hooks/use-cloud-sync"
import { isTestSubject } from "@/lib/scan-test"
import { BackupPanel, NotificationsPanel, ResetPanel, TagsPanel } from "./settings-panels"
import { entriesFromTimetable, loadSchedule, saveSchedule, type ScheduleEntry } from "@/lib/reminders"
import type { RestoreRequest } from "@/lib/safe-replace"
import { buildBackup, downloadText } from "@/lib/backup"
import { localDate } from "@/lib/attendance"
import { readTheme, setTheme, type ThemePref } from "@/lib/theme"
import type { Holiday, Mate, ScheduleOverride, Subject, Task } from "@/lib/types"
import { TermsContent } from "./terms-gate"

type Panel = "home" | "reminders" | "reminder-edit" | "notifications" | "tags" | "backup" | "reset" | "scan" | "sync" | "tips-terms"

const TITLES: Record<Panel, string> = {
  home: "Settings",
  reminders: "Class reminders",
  "reminder-edit": "Reminder",
  notifications: "Notifications",
  tags: "Tags",
  backup: "Backup & restore",
  reset: "Reset all data",
  scan: "Scan check-in",
  sync: "Account",
  "tips-terms": "Tips, privacy & terms",
}

interface SettingsSheetProps {
  isOpen: boolean
  onClose: () => void
  subjects: Subject[]
  tasks: Task[]
  holidays?: Holiday[]
  scheduleOverrides?: ScheduleOverride[]
  tags: string[]
  mates: Mate[]
  onAddTag: (tag: string) => void
  onDeleteTag: (tag: string) => void
  /** Resolves true only if the reset really happened (it says why, itself, when it did not) */
  onResetAllData: () => Promise<boolean>
  /** Resolves true only if the data was really replaced */
  onImportData: (data: RestoreRequest) => Promise<boolean>
  notificationSupported: boolean
  notificationPermission: NotificationPermission | null
  isSubscribed: boolean
  onEnableNotifications: () => Promise<void>
  onImportTimetable: () => void
  onToast: (message: string, undo?: () => void) => void
  onTestNotification: () => void
  onTestFcm: () => void
  /** Pretend a mate answered "yes, I covered you" to a ping, to preview the Mates bubble */
  onSimulateReply: () => void
  /** Pretend a mate is asking whether you marked them present */
  onSimulateIncoming: () => void
  /** Queue Weekly Wrapped for its normal Saturday release in the development build. */
  onSimulateWrapped: () => void
  /** Replay the first-run welcome tour */
  onShowWelcome: () => void
  /** Scan check-in test tools */
  onAddTestTimetable: (withOverlap: boolean) => void
  onRemoveTestTimetable: () => void
  onSimulateScan: () => void
  onPreviewScan: () => void
  /** Keeps data in step across browsers through a signed-in account */
  sync: CloudSync
  /** True while demo data is on screen instead of the real thing */
  demoActive: boolean
  /** Loads a full sample term and opens the guided tour */
  onTryDemo: () => void
  /** Puts your own data back */
  onExitDemo: () => void
  startPanel?: "home" | "sync" | "tips-terms"
  onResetConsent: () => void
  usageAnalyticsEnabled: boolean
  onUsageAnalyticsChange: (enabled: boolean) => void
  onShowSyncNudge: () => void
  onOpenFeedback: (kind: "rating" | "bug" | "suggestion") => void
  onPreviewFeedbackAnimation: (kind: "thanks" | "bug") => void
}

function Row({
  icon,
  avatar = false,
  title,
  hint,
  onClick,
  danger,
  status,
}: {
  icon: React.ReactNode
  avatar?: boolean
  title: string
  hint: string
  onClick: () => void
  danger?: boolean
  status?: { text: string; tone: "good" | "bad" | "mute" }
}) {
  return (
    <li>
      <button onClick={onClick} className="w-full flex items-center gap-3.5 px-4 py-3 text-left min-h-[64px] active:bg-ink/[0.04] transition">
        <span className={`w-10 h-10 rounded-xl grid place-items-center flex-shrink-0 overflow-hidden ${danger ? "bg-bad/10 text-bad" : avatar ? "bg-secondary text-ink rounded-full" : "bg-card text-ink"}`}>{avatar ? <SettingsAccountAvatar /> : icon}</span>
        <span className="min-w-0 flex-1">
          <span className={`block text-[16px] font-semibold leading-snug ${danger ? "text-bad" : ""}`}>{title}</span>
          <span className="block text-[13px] text-mute leading-snug truncate">{hint}</span>
        </span>
        {status && (
          <span
            className={`text-[12px] font-semibold rounded-full px-2.5 py-1 ${
              status.tone === "good" ? "bg-good/15 text-good" : status.tone === "bad" ? "bg-bad/10 text-bad" : "bg-ink/[0.07] text-mute"
            }`}
          >
            {status.text}
          </span>
        )}
        <CaretRight weight="bold" className="w-4 h-4 text-mute flex-shrink-0" />
      </button>
    </li>
  )
}

function SettingsAccountAvatar() {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null)
  const [imageFailed, setImageFailed] = useState(false)

  useEffect(() => {
    const auth = getAuth(app)
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      if (!user || user.isAnonymous) {
        setPhotoUrl(null)
        setImageFailed(false)
        return
      }

      setPhotoUrl(user.photoURL || null)
      setImageFailed(false)
      // Ask Firebase for the latest Google profile every time the account becomes available.
      void user.reload().then(() => {
        if (auth.currentUser?.uid !== user.uid) return
        setPhotoUrl(auth.currentUser.photoURL || user.photoURL || null)
        setImageFailed(false)
      }).catch(() => {
        // Keep the cached photo URL; a temporary profile refresh failure should not hide the avatar.
      })
    })
    return unsubscribe
  }, [])

  if (photoUrl && !imageFailed) {
    return <img src={photoUrl} alt="" referrerPolicy="no-referrer" className="w-full h-full object-cover" onError={() => setImageFailed(true)} />
  }
  return <UserCircle weight="regular" className="w-7 h-7" aria-hidden="true" />
}

/** The simulators and test buttons are for development only; production builds hide them */
const DEV_TOOLS = process.env.NODE_ENV !== "production"

const groupClass = "rounded-2xl bg-secondary overflow-hidden divide-y divide-ink/[0.08]"
const label = "text-[12px] font-medium uppercase tracking-wider text-mute mb-2 px-1"
const icon = "w-5 h-5"

export default function SettingsSheet(p: SettingsSheetProps) {
  const [panel, setPanel] = useState<Panel>(p.startPanel ?? "home")
  const [showDev, setShowDev] = useState(false)
  const [schedule, setSchedule] = useState<ScheduleEntry[]>(loadSchedule)
  const [day, setDay] = useState(() => new Date().getDay())
  const [editing, setEditing] = useState<ScheduleEntry | null>(null)
  const [theme, setThemeState] = useState<ThemePref>("system")

  useEffect(() => {
    saveSchedule(schedule)
  }, [schedule])

  // Always start from the top level
  useEffect(() => {
    if (p.isOpen) {
      setSchedule(loadSchedule())
      setThemeState(readTheme())
      setPanel(p.startPanel ?? "home")
      setDay(new Date().getDay())
    }
  }, [p.isOpen, p.startPanel])

  const back = panel === "home" ? undefined : () => setPanel(panel === "reminder-edit" ? "reminders" : panel === "reset" || panel === "backup" ? "sync" : "home")

  const upsert = (entries: ScheduleEntry[]) => {
    setSchedule((prev) => {
      const next = [...prev]
      for (const e of entries) {
        const at = next.findIndex((x) => x.id === e.id)
        if (at === -1) next.push(e)
        else next[at] = e
      }
      return next
    })
  }

  const saveReminders = (entries: ScheduleEntry[]) => {
    upsert(entries)
    setDay(entries[0].day)
    setPanel("reminders")
    const granted = typeof Notification !== "undefined" && Notification.permission === "granted"
    p.onToast(granted ? (entries.length > 1 ? `${entries.length} reminders saved` : "Reminder saved") : "Saved. Turn on notifications to get it.")
  }

  const deleteReminder = (id: string) => {
    const gone = schedule.find((e) => e.id === id)
    setSchedule((prev) => prev.filter((e) => e.id !== id))
    setPanel("reminders")
    p.onToast(
      "Reminder deleted",
      gone
        ? () => {
            setSchedule((prev) => [...prev, gone])
          }
        : undefined,
    )
  }

  const fromTimetable = () => {
    const made = entriesFromTimetable(p.subjects, schedule)
    if (made.length === 0) return p.onToast("Your timetable has no classes yet")
    upsert(made)
    p.onToast(`Added ${made.length} ${made.length === 1 ? "reminder" : "reminders"}, 10 min before each class`)
  }

  const saveFullBackup = () => {
    downloadText(`college-tracker-backup-${localDate()}.json`, buildBackup({ subjects: p.subjects, tasks: p.tasks, tags: p.tags, mates: p.mates, holidays: p.holidays ?? [], scheduleOverrides: p.scheduleOverrides ?? [], reminders: schedule }))
    p.onToast("Backup saved to your downloads")
  }

  const perm = p.notificationPermission
  const notifStatus: { text: string; tone: "good" | "bad" | "mute" } = !p.notificationSupported
    ? { text: "Unavailable", tone: "mute" }
    : perm === "granted"
      ? { text: "On", tone: "good" }
      : perm === "denied"
        ? { text: "Blocked", tone: "bad" }
        : { text: "Off", tone: "mute" }

  const close = () => p.onClose()
  const then = (fn: () => void) => () => {
    close()
    fn()
  }

  return (
    <Sheet open={p.isOpen} onClose={close} title={TITLES[panel]} onBack={back}
      headerActions={<div className="flex items-center gap-1.5">
        <button type="button" onClick={then(p.demoActive ? p.onExitDemo : p.onTryDemo)} aria-label={p.demoActive ? "Exit demo" : "Start demo"} title={p.demoActive ? "Exit demo" : "Try a demo"} className="h-8 px-3 rounded-full bg-secondary text-[12px] font-semibold text-mute hover:text-ink inline-flex items-center gap-1.5"><Sparkle weight="duotone" className="w-3.5 h-3.5"/>{p.demoActive ? "Exit demo" : "Demo"}</button>
        <button type="button" onClick={() => setPanel("tips-terms")} aria-label="Tips, privacy and terms" title="Tips, privacy and terms" className="w-8 h-8 grid place-items-center rounded-full bg-secondary text-mute hover:text-ink"><Info weight="bold" className="w-4 h-4"/></button>
      </div>}>

      {panel === "home" && (
        <div className="space-y-5">
          <section>
            <h3 className={label}>Account & data</h3>
            <ul className={groupClass}>
              <Row
                icon={<UserCircle weight="duotone" className={icon} />}
                avatar
                title="Account"
                hint={p.sync.account ? p.sync.account.email : "Profile, sign-in, backups and reset"}
                status={p.sync.account ? { text: p.sync.status === "offline" ? "Offline" : p.sync.status === "synced" ? "Up to date" : "Signed in", tone: p.sync.status === "offline" ? "bad" : p.sync.status === "synced" ? "good" : "mute" } : undefined}
                onClick={() => setPanel("sync")}
              />
            </ul>
          </section>


          <section>
            <h3 className={label}>Your day</h3>
            <ul className={groupClass}>
              <Row
                icon={<CalendarPlus weight="duotone" className={icon} />}
                title="Import timetable"
                hint="Add subjects and classes from a photo"
                onClick={then(p.onImportTimetable)}
              />
              <Row
                icon={<Tag weight="duotone" className={icon} />}
                title="Tags"
                hint={p.tags.length ? `${p.tags.length} ${p.tags.length === 1 ? "tag" : "tags"}` : "Group your subjects"}
                onClick={() => setPanel("tags")}
              />
              <Row
                icon={<BellRinging weight="duotone" className={icon} />}
                title="Class reminders"
                hint={schedule.length ? `${schedule.length} ${schedule.length === 1 ? "reminder" : "reminders"} set` : "A nudge before your classes"}
                onClick={() => setPanel("reminders")}
              />
              <Row
                icon={<Bell weight="duotone" className={icon} />}
                title="Notifications"
                hint="Allow or block alerts on this device"
                status={notifStatus}
                onClick={() => setPanel("notifications")}
              />
            </ul>
          </section>

          <section>
            <h3 className={label}>Improve College Tracker</h3>
            <ul className={groupClass}>
              <Row
                icon={<Star weight="duotone" className={icon} />}
                title="Rate the app"
                hint="Leave a quick rating for the developer"
                onClick={() => p.onOpenFeedback("rating")}
              />
              <Row
                icon={<Bug weight="duotone" className={icon} />}
                title="Report a bug"
                hint="Tell us what went wrong"
                onClick={() => p.onOpenFeedback("bug")}
              />
              <Row
                icon={<Lightbulb weight="duotone" className={icon} />}
                title="Request a feature"
                hint="Share an idea or suggestion"
                onClick={() => p.onOpenFeedback("suggestion")}
              />
            </ul>
          </section>


          <section>
            <h3 className={label}>Appearance</h3>
            <div className="rounded-2xl bg-secondary p-3.5">
              <div className="flex items-center gap-3.5 mb-3">
                <span className="w-9 h-9 rounded-xl bg-card text-ink grid place-items-center flex-shrink-0">
                  <CircleHalf weight="duotone" className={icon} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[15px] font-semibold leading-snug">Theme</span>
                  <span className="block text-[12.5px] text-mute leading-snug">Light is the default. Dark is optional.</span>
                </span>
              </div>
              <Segmented
                label="Theme"
                value={theme}
                onChange={(v) => {
                  setThemeState(v)
                  setTheme(v)
                }}
                options={[
                  { id: "light", label: "Light" },
                  { id: "dark", label: "Dark" },
                  { id: "system", label: "System" },
                ]}
              />
            </div>
          </section>

          <section className="space-y-2 pt-1">
            <button onClick={() => setPanel("tips-terms")} className="block text-[13px] text-mute px-1">Tips, privacy and terms</button>
            <button onClick={then(p.onShowWelcome)} className="block text-[13px] text-mute px-1">Show the welcome tour</button>
            {DEV_TOOLS && (
              <button onClick={() => setShowDev(!showDev)} aria-expanded={showDev} className="block text-[13px] text-mute px-1">
                {showDev ? "Hide" : "Show"} developer tools
              </button>
            )}
            {DEV_TOOLS && showDev && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button onClick={() => setPanel("scan")} className={`${tintButton} col-span-2`}>Scan check-in: QR code and test tools</button>
                <button onClick={p.onTestNotification} className={tintButton}>Test notification</button>
                <button onClick={p.onTestFcm} className={tintButton}>Test FCM token</button>
                <button onClick={then(p.onSimulateReply)} className={`${tintButton} col-span-2`}>Simulate a mate replying “yes, I covered you”</button>
                <button onClick={then(p.onSimulateIncoming)} className={`${tintButton} col-span-2`}>Simulate a mate pinging you</button>
                <button onClick={then(p.onSimulateWrapped)} className={`${tintButton} col-span-2`}>Queue Wrapped for Saturday</button>
                <button onClick={p.onShowSyncNudge} className={`${tintButton} col-span-2`}>Test Google sync reminder</button>
                <button onClick={p.onResetConsent} className={`${tintButton} col-span-2`}>Replay privacy and terms gate</button>
                <button onClick={() => p.onPreviewFeedbackAnimation("thanks")} className={`${tintButton} col-span-2`}>Preview developer thank-you animation</button>
                <button onClick={() => p.onPreviewFeedbackAnimation("bug")} className={`${tintButton} col-span-2`}>Preview bug-swat animation</button>
                <a href="/developer-feedback" target="_blank" rel="noreferrer" className={`${tintButton} col-span-2`}>Open feedback dashboard</a>
              </div>
            )}
          </section>
        </div>
      )}

      {panel === "reminders" && (
        <RemindersList
          subjects={p.subjects}
          schedule={schedule}
          day={day}
          onDay={setDay}
          onAdd={() => {
            setEditing(null)
            setPanel("reminder-edit")
          }}
          onEdit={(e) => {
            setEditing(e)
            setPanel("reminder-edit")
          }}
          onFromTimetable={fromTimetable}
        />
      )}

      {panel === "reminder-edit" && (
        <ReminderEditor
          key={editing?.id ?? "new"}
          subjects={p.subjects}
          editing={editing}
          defaultDay={day}
          onSave={saveReminders}
          onDelete={deleteReminder}
        />
      )}

      {panel === "notifications" && (
        <NotificationsPanel
          supported={p.notificationSupported}
          permission={p.notificationPermission}
          isSubscribed={p.isSubscribed}
          onEnable={p.onEnableNotifications}
          onToast={(m) => p.onToast(m)}
        />
      )}

      {panel === "tags" && <TagsPanel tags={p.tags} subjects={p.subjects} onAdd={p.onAddTag} onDelete={p.onDeleteTag} />}

      {panel === "backup" && (
        <div className="space-y-6">
          <BackupPanel
            onSaveFull={saveFullBackup}
            onImportData={async (d) => {
              // The reminders are replaced only once the data was (after its safety copy); a refusal leaves them alone
              const ok = await p.onImportData(d)
              if (ok && d.full && d.reminders) setSchedule(d.reminders)
              return ok
            }}
            onToast={(m) => p.onToast(m)}
          />
          <RestorePoints
            onRestore={async (d, known) => {
              // A point saved before reminders / tags / mates were kept in it says nothing about them: those are left as they are
              const unrecorded: ("tags" | "mates" | "holidays" | "scheduleOverrides")[] = [...(known.tags ? [] : (["tags"] as const)), ...(known.mates ? [] : (["mates"] as const)), ...(known.holidays ? [] : (["holidays"] as const)), ...(known.scheduleOverrides ? [] : (["scheduleOverrides"] as const))]
              const ok = await p.onImportData({ ...d, full: known.reminders, unrecorded })
              if (ok && known.reminders) setSchedule(d.reminders)
              return ok
            }}
            onToast={(m) => p.onToast(m)}
          />
        </div>
      )}

      {panel === "sync" && (
        <div className="space-y-5">
          <SyncPanel sync={p.sync} onToast={(m) => p.onToast(m)} />
          <section className="space-y-3">
            <h3 className={label}>Your data</h3>
            <div className={groupClass}>
              <Row
                icon={<FloppyDisk weight="duotone" className={icon} />}
                title="Backup & restore"
                hint="Export a copy or restore saved records"
                onClick={() => setPanel("backup")}
              />
              <Row
                icon={<Trash weight="duotone" className={icon} />}
                title="Reset all data"
                hint="Start a new year from scratch"
                danger
                onClick={() => setPanel("reset")}
              />
            </div>
          </section>
        </div>
      )}

      {panel === "tips-terms" && <div className="space-y-5">
        <p className="text-[14px] leading-relaxed text-mute">Keep a recent backup, confirm that sync completed on another device, and test notification permissions on the device where you need alerts.</p>
        <section className="rounded-2xl bg-secondary p-4">
          <label className="flex items-start gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={p.usageAnalyticsEnabled}
              onChange={(e) => p.onUsageAnalyticsChange(e.target.checked)}
              className="mt-1 accent-current"
              aria-label="Share pseudonymous app usage analytics"
            />
            <span className="flex-1">
              <span className="block text-[15px] font-semibold">{p.usageAnalyticsEnabled ? "App-usage analytics are on" : "App-usage analytics are off"}</span>
              <span className="block text-[13px] leading-relaxed text-mute mt-1">Optional counts for app opens, screens, attendance actions, subjects and tasks. The analytics log excludes names, attendance values and dates. Your choice is saved on this browser.</span>
            </span>
          </label>
          <p className="text-[12px] text-mute mt-3">{p.usageAnalyticsEnabled ? "Thanks for opting in. You can turn this off at any time." : "The tracker works normally with this setting off."}</p>
        </section>
        <TermsContent/>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2"><button onClick={p.onResetConsent} className={tintButton}>Show required notice again</button><button onClick={() => setPanel("sync")} className={`${tintButton} bg-ink text-paper`}>Set up Google sync</button></div>
      </div>}

      {panel === "scan" && (
        <ScanPanel
          testCount={p.subjects.filter(isTestSubject).length}
          onAddTest={p.onAddTestTimetable}
          onRemoveTest={p.onRemoveTestTimetable}
          onSimulateScan={then(p.onSimulateScan)}
          onPreviewAnimation={then(p.onPreviewScan)}
          onToast={(m) => p.onToast(m)}
        />
      )}

      {panel === "reset" && (
        <ResetPanel
          subjects={p.subjects.length}
          tasks={p.tasks.length}
          tags={p.tags.length}
          mates={p.mates.length}
          onToast={(m) => p.onToast(m)}
          onReset={async () => {
            const ok = await p.onResetAllData()
            if (ok) setSchedule([]) // the reminders on screen follow what is now stored: none
            if (ok) close() // a refused reset stays open, with the reason shown
            return ok
          }}
        />
      )}
    </Sheet>
  )
}
