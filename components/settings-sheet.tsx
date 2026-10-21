"use client"

import { useEffect, useState } from "react"
import { ArrowsClockwise, BellRinging, Bell, CalendarPlus, CaretRight, CircleHalf, FloppyDisk, Sparkle, Tag, Trash, Info } from "@phosphor-icons/react"
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
  sync: "Sync between browsers",
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
  onShowSyncNudge: () => void
  onOpenFeedback: () => void
  onPreviewFeedbackAnimation: () => void
}

function Row({
  icon,
  title,
  hint,
  onClick,
  danger,
  status,
}: {
  icon: React.ReactNode
  title: string
  hint: string
  onClick: () => void
  danger?: boolean
  status?: { text: string; tone: "good" | "bad" | "mute" }
}) {
  return (
    <li>
      <button onClick={onClick} className="w-full flex items-center gap-3.5 px-4 py-3 text-left min-h-[64px] active:bg-ink/[0.04] transition">
        <span className={`w-10 h-10 rounded-xl grid place-items-center flex-shrink-0 ${danger ? "bg-bad/10 text-bad" : "bg-card text-ink"}`}>{icon}</span>
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

  const back = panel === "home" ? undefined : () => setPanel(panel === "reminder-edit" ? "reminders" : "home")

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
      headerActions={<button type="button" onClick={() => setPanel("tips-terms")} aria-label="Tips, privacy and terms" title="Tips, privacy and terms" className="w-8 h-8 grid place-items-center rounded-full bg-secondary text-mute hover:text-ink"><Info weight="bold" className="w-4 h-4"/></button>}>

      {panel === "home" && (
        <div className="space-y-6">
          <section>
            <div className="rounded-2xl bg-secondary p-3.5 flex items-center gap-3.5">
              <span className="w-10 h-10 rounded-xl bg-card text-ink grid place-items-center flex-shrink-0">
                <Sparkle weight="duotone" className={icon} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-[16px] font-semibold leading-snug">{p.demoActive ? "Viewing demo data" : "Try a demo"}</span>
                <span className="block text-[13px] text-mute leading-snug">
                  {p.demoActive ? "Get your own data back any time." : "See the app filled in with a full sample term, with a guided tour."}
                </span>
              </span>
              <button onClick={then(p.demoActive ? p.onExitDemo : p.onTryDemo)} className={`${tintButton} flex-shrink-0`}>
                {p.demoActive ? "Exit" : "Start"}
              </button>
            </div>
          </section>

          <section>
            <h3 className={label}>Appearance</h3>
            <div className="rounded-2xl bg-secondary p-3.5">
              <div className="flex items-center gap-3.5 mb-3">
                <span className="w-10 h-10 rounded-xl bg-card text-ink grid place-items-center flex-shrink-0">
                  <CircleHalf weight="duotone" className={icon} />
                </span>
                <span className="min-w-0">
                  <span className="block text-[16px] font-semibold leading-snug">Theme</span>
                  <span className="block text-[13px] text-mute leading-snug">System follows your phone&rsquo;s setting</span>
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
                  { id: "system", label: "System" },
                  { id: "light", label: "Light" },
                  { id: "dark", label: "Dark" },
                ]}
              />
            </div>
          </section>

          <section>
            <h3 className={label}>Reminders</h3>
            <ul className={groupClass}>
              <Row
                icon={<BellRinging weight="duotone" className={icon} />}
                title="Class reminders"
                hint={schedule.length ? `${schedule.length} ${schedule.length === 1 ? "reminder" : "reminders"} set` : "A nudge around your classes while the app is open"}
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
            <h3 className={label}>Your data</h3>
            <ul className={groupClass}>
              <Row
                icon={<CalendarPlus weight="duotone" className={icon} />}
                title="Import timetable"
                hint="Add subjects and classes from a photo"
                onClick={then(p.onImportTimetable)}
              />
              <Row
                icon={<ArrowsClockwise weight="duotone" className={icon} />}
                title="Sync between browsers"
                hint={p.sync.account ? `Signed in as ${p.sync.account.email}` : "Sign in to use your data in any browser"}
                status={p.sync.account ? { text: p.sync.status === "offline" ? "Offline" : "On", tone: p.sync.status === "offline" ? "bad" : "good" } : undefined}
                onClick={() => setPanel("sync")}
              />
              <Row
                icon={<Tag weight="duotone" className={icon} />}
                title="Tags"
                hint={p.tags.length ? `${p.tags.length} ${p.tags.length === 1 ? "tag" : "tags"}` : "Group your subjects"}
                onClick={() => setPanel("tags")}
              />
              <Row
                icon={<FloppyDisk weight="duotone" className={icon} />}
                title="Backup & restore"
                hint="Export your data, or bring it back"
                onClick={() => setPanel("backup")}
              />
            </ul>
          </section>

          <section>
            <ul className={groupClass}>
              <Row
                icon={<Trash weight="duotone" className={icon} />}
                title="Reset all data"
                hint="Start a new year from scratch"
                danger
                onClick={() => setPanel("reset")}
              />
            </ul>
          </section>

          <section className="space-y-2">
            <button onClick={p.onOpenFeedback} className="block text-[14px] text-mute px-1">Rate app / report a bug</button>
            <button onClick={() => setPanel("tips-terms")} className="block text-[14px] text-mute px-1">Tips, privacy and terms</button>
            <button onClick={then(p.onShowWelcome)} className="block text-[14px] text-mute px-1">Show the welcome tour</button>
            {DEV_TOOLS && (
              <button onClick={() => setShowDev(!showDev)} aria-expanded={showDev} className="block text-[14px] text-mute px-1">
                {showDev ? "Hide" : "Show"} developer tools
              </button>
            )}
            {DEV_TOOLS && showDev && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <button onClick={() => setPanel("scan")} className={`${tintButton} col-span-2`}>
                  Scan check-in: QR code and test tools
                </button>
                <button onClick={p.onTestNotification} className={tintButton}>
                  Test notification
                </button>
                <button onClick={p.onTestFcm} className={tintButton}>
                  Test FCM token
                </button>
                <button onClick={then(p.onSimulateReply)} className={`${tintButton} col-span-2`}>
                  Simulate a mate replying &ldquo;yes, I covered you&rdquo;
                </button>
                <button onClick={then(p.onSimulateIncoming)} className={`${tintButton} col-span-2`}>
                  Simulate a mate pinging you
                </button>
                <button onClick={then(p.onSimulateWrapped)} className={`${tintButton} col-span-2`}>Queue Wrapped for Saturday</button>
                <button onClick={p.onShowSyncNudge} className={`${tintButton} col-span-2`}>Test Google sync reminder</button>
                <button onClick={p.onResetConsent} className={`${tintButton} col-span-2`}>Replay privacy and terms gate</button>
                <button onClick={p.onPreviewFeedbackAnimation} className={`${tintButton} col-span-2`}>Preview developer thanks / bug-swat animation</button>
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

      {panel === "sync" && <SyncPanel sync={p.sync} onToast={(m) => p.onToast(m)} />}

      {panel === "tips-terms" && <div className="space-y-5"><p className="text-[14px] leading-relaxed text-mute">Keep a recent backup, confirm that sync completed on another device, and test notification permissions on the device where you need alerts.</p><TermsContent/><div className="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-2"><button onClick={p.onResetConsent} className={tintButton}>Show required notice again</button><button onClick={() => setPanel("sync")} className={`${tintButton} bg-ink text-paper`}>Set up Google sync</button></div></div>}

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
