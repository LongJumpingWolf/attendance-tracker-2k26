"use client"

import { useRef, useState } from "react"
import {
  Bell,
  BellRinging,
  BellSlash,
  CaretDown,
  DownloadSimple,
  Trash,
  UploadSimple,
  WarningCircle,
  Plus,
} from "@phosphor-icons/react"
import { inputClass, primaryButton, tintButton } from "./sheet"
import { importNotificationSchedule, sendLocalNotification } from "@/lib/notifications"
import { parseBackupFile, type BackupData } from "@/lib/backup-import"
import type { Subject } from "@/lib/types"

const group = "rounded-2xl bg-secondary overflow-hidden divide-y divide-ink/[0.08]"
const note = "text-[13px] text-mute leading-snug px-1"

/* ---------- notifications ---------- */

interface NotificationsProps {
  supported: boolean
  permission: NotificationPermission | null
  onEnable: () => Promise<void>
  onToast: (message: string) => void
}

export function NotificationsPanel({ supported, permission, onEnable, onToast }: NotificationsProps) {
  const [busy, setBusy] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [json, setJson] = useState("")
  const [errors, setErrors] = useState<string[]>([])
  const [importing, setImporting] = useState(false)

  const on = permission === "granted"
  const blocked = permission === "denied"

  const enable = async () => {
    setBusy(true)
    try {
      await onEnable()
    } finally {
      setBusy(false)
    }
  }

  const test = async () => {
    try {
      await sendLocalNotification("Class reminder", { body: "This is what your reminders will look like." })
      onToast("Test notification sent")
    } catch {
      onToast("Couldn't show a notification")
    }
  }

  const runImport = async () => {
    setErrors([])
    setImporting(true)
    const r = await importNotificationSchedule(json)
    setImporting(false)
    if (r.success) {
      setJson("")
      onToast("Reminder schedule imported")
    } else setErrors(r.errors)
  }

  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-secondary p-5 text-center">
        <span
          className={`mx-auto w-16 h-16 rounded-full grid place-items-center ${
            on ? "bg-good/15 text-good" : blocked ? "bg-bad/10 text-bad" : "bg-ink/[0.08] text-ink"
          }`}
        >
          {on ? <BellRinging weight="fill" className="w-8 h-8" /> : blocked || !supported ? <BellSlash weight="fill" className="w-8 h-8" /> : <Bell weight="fill" className="w-8 h-8" />}
        </span>
        <h3 className="text-[20px] font-bold tracking-tight mt-3">
          {!supported ? "Not available here" : on ? "Notifications are on" : blocked ? "Notifications are blocked" : "Notifications are off"}
        </h3>
        <p className="text-[14px] text-mute mt-1.5 leading-snug max-w-[19rem] mx-auto">
          {!supported
            ? "This browser or device can't show notifications. Installing the app to your home screen may help."
            : on
              ? "Your class reminders can reach you, even when the app is closed."
              : blocked
                ? "You said no earlier, so the browser won't ask again. Tap the lock icon in the address bar, set Notifications to Allow, then come back."
                : "Turn them on to get a nudge before class and to be told when a mate replies."}
        </p>
        {supported && !on && !blocked && (
          <button onClick={enable} disabled={busy} className={`${primaryButton} mt-4 disabled:opacity-50`}>
            {busy ? "Asking…" : "Turn on notifications"}
          </button>
        )}
        {on && (
          <button onClick={test} className={`${tintButton} mt-4 w-full h-12 bg-card text-[16px]`}>
            Send me a test
          </button>
        )}
      </div>

      <div>
        <button
          onClick={() => setAdvanced(!advanced)}
          aria-expanded={advanced}
          className="w-full flex items-center justify-between rounded-2xl bg-secondary px-4 py-3.5 text-left"
        >
          <span>
            <span className="block text-[16px] font-semibold">Import a reminder schedule</span>
            <span className="block text-[13px] text-mute">Advanced: paste a schedule as JSON</span>
          </span>
          <CaretDown weight="bold" className={`w-4 h-4 text-mute transition-transform ${advanced ? "rotate-180" : ""}`} />
        </button>
        {advanced && (
          <div className="mt-3">
            <textarea
              value={json}
              onChange={(e) => {
                setJson(e.target.value)
                setErrors([])
              }}
              spellCheck={false}
              rows={6}
              placeholder={'{ "timezone": "Asia/Kolkata", "subjects": [ { "title": "Pathology", "message": "Class starts", "schedule": { "monday": ["10:00"] } } ] }'}
              className="w-full rounded-xl bg-secondary p-3 text-[13px] leading-snug font-mono outline-none placeholder:text-mute focus:ring-1 focus:ring-ink/40"
            />
            {errors.map((e) => (
              <p key={e} className="text-[13px] text-bad mt-1">
                {e}
              </p>
            ))}
            <p className={`${note} mt-2`}>This replaces the push schedule stored on the server for this device.</p>
            <button onClick={runImport} disabled={importing || !json.trim()} className={`${primaryButton} mt-3 disabled:opacity-40`}>
              {importing ? "Importing…" : "Import schedule"}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

/* ---------- tags ---------- */

interface TagsProps {
  tags: string[]
  subjects: Subject[]
  onAdd: (tag: string) => void
  onDelete: (tag: string) => void
}

export function TagsPanel({ tags, subjects, onAdd, onDelete }: TagsProps) {
  const [draft, setDraft] = useState("")
  const [confirm, setConfirm] = useState<string | null>(null)

  const add = () => {
    const t = draft.trim()
    if (!t || tags.includes(t)) return setDraft("")
    onAdd(t)
    setDraft("")
  }

  return (
    <div>
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())}
          placeholder="New tag, e.g. Theory"
          className={inputClass}
        />
        <button onClick={add} disabled={!draft.trim()} aria-label="Add tag" className="w-12 h-12 rounded-xl bg-ink text-paper grid place-items-center flex-shrink-0 disabled:opacity-35">
          <Plus weight="bold" className="w-5 h-5" />
        </button>
      </div>

      {tags.length === 0 ? (
        <p className="text-[15px] text-mute leading-snug mt-6 text-center">No tags yet. Tags let you group subjects, like Theory or Practical.</p>
      ) : (
        <ul className={`${group} mt-5`}>
          {tags.map((t) => {
            const uses = subjects.filter((s) => s.tags?.includes(t)).length
            return (
              <li key={t} className="flex items-center gap-3 px-4 py-3 min-h-[56px]">
                <span className="min-w-0 flex-1">
                  <span className="block text-[16px] font-semibold truncate">{t}</span>
                  <span className="block text-[13px] text-mute">
                    {uses} {uses === 1 ? "subject" : "subjects"}
                  </span>
                </span>
                {confirm === t ? (
                  <span className="flex gap-1.5">
                    <button onClick={() => setConfirm(null)} className="h-9 px-3.5 rounded-full bg-card text-[14px] font-semibold text-mute">
                      Keep
                    </button>
                    <button
                      onClick={() => {
                        onDelete(t)
                        setConfirm(null)
                      }}
                      className="h-9 px-3.5 rounded-full bg-bad text-paper text-[14px] font-semibold"
                    >
                      Delete
                    </button>
                  </span>
                ) : (
                  <button onClick={() => setConfirm(t)} aria-label={`Delete ${t}`} className="w-9 h-9 rounded-full grid place-items-center text-mute hover:text-bad">
                    <Trash weight="regular" className="w-5 h-5" />
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      )}
      {tags.length > 0 && <p className={`${note} mt-3`}>Deleting a tag removes it from every subject that uses it. The subjects stay.</p>}
    </div>
  )
}

/* ---------- backup and restore ---------- */

interface BackupProps {
  /** The lossless JSON backup */
  onSaveFull: () => void
  /** The older spreadsheet export (ZIP of Excel files) */
  onExport: () => Promise<void>
  onImportData: (data: BackupData) => void
  onToast: (message: string) => void
}

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`

export function BackupPanel({ onSaveFull, onExport, onImportData, onToast }: BackupProps) {
  const [exporting, setExporting] = useState(false)
  const [reading, setReading] = useState(false)
  const [pending, setPending] = useState<BackupData | null>(null)
  const input = useRef<HTMLInputElement>(null)

  const doExport = async () => {
    setExporting(true)
    try {
      await onExport()
    } finally {
      setExporting(false)
    }
  }

  const pick = async (file: File | undefined) => {
    if (!file) return
    setReading(true)
    try {
      const data = await parseBackupFile(file)
      if (data.subjects.length === 0 && data.tasks.length === 0 && data.tags.length === 0 && !data.mates?.length) onToast("That file has no data the app recognises")
      else setPending(data)
    } catch (e) {
      onToast(e instanceof Error && e.message ? e.message : "Couldn't read that file. Use a backup exported from this app.")
    } finally {
      setReading(false)
      if (input.current) input.current.value = ""
    }
  }

  if (pending) {
    const parts = [
      count(pending.subjects.length, "subject", "subjects"),
      count(pending.tasks.length, "deadline", "deadlines"),
      count(pending.tags.length, "tag", "tags"),
      ...(pending.full ? [count(pending.mates?.length ?? 0, "proxy-mate", "proxy-mates"), count(pending.reminders?.length ?? 0, "reminder", "reminders")] : []),
    ]
    return (
      <div>
        <div className="rounded-2xl bg-secondary p-5">
          <span className="w-12 h-12 rounded-full bg-warn/15 text-warn grid place-items-center">
            <WarningCircle weight="fill" className="w-6 h-6" />
          </span>
          <h3 className="text-[20px] font-bold tracking-tight mt-3">Replace your data?</h3>
          <p className="text-[15px] text-mute mt-1.5 leading-snug">This backup has {parts.join(", ")}. Restoring it replaces what is in the app now.</p>
          {pending.full ? (
            <p className="text-[13px] text-mute mt-2 leading-snug">Full backup: class days, every mark, plans, mates and reminders come back exactly as saved.</p>
          ) : (
            <p className="text-[13px] text-mute mt-2 leading-snug">
              This is an older spreadsheet backup. It has no class days, mark history, mates or reminders. Subjects with the same name keep their class days and history; mates and reminders stay as they are.
            </p>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2 mt-4">
          <button onClick={() => setPending(null)} className={`${tintButton} h-[52px] text-[17px]`}>
            Cancel
          </button>
          <button
            onClick={() => {
              onImportData(pending)
              onToast("Backup restored")
              setPending(null)
            }}
            className="h-[52px] rounded-2xl bg-ink text-paper text-[17px] font-semibold"
          >
            Restore
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <button onClick={onSaveFull} className="w-full text-left rounded-2xl bg-secondary p-4 flex items-center gap-4">
        <span className="w-12 h-12 rounded-2xl bg-ink text-paper grid place-items-center flex-shrink-0">
          <DownloadSimple weight="bold" className="w-6 h-6" />
        </span>
        <span className="min-w-0">
          <span className="block text-[17px] font-semibold">Save a full backup</span>
          <span className="block text-[13px] text-mute leading-snug">One file with everything: subjects, class days, every mark, deadlines, tags, mates and reminders.</span>
        </span>
      </button>

      <button onClick={() => input.current?.click()} disabled={reading} className="w-full text-left rounded-2xl bg-secondary p-4 flex items-center gap-4 disabled:opacity-60">
        <span className="w-12 h-12 rounded-2xl bg-card text-ink grid place-items-center flex-shrink-0">
          <UploadSimple weight="bold" className="w-6 h-6" />
        </span>
        <span className="min-w-0">
          <span className="block text-[17px] font-semibold">{reading ? "Reading…" : "Restore from a backup"}</span>
          <span className="block text-[13px] text-mute leading-snug">Pick a backup file. You&rsquo;ll see what&rsquo;s inside before anything changes.</span>
        </span>
      </button>
      <input ref={input} type="file" accept=".json,.zip,.csv" onChange={(e) => pick(e.target.files?.[0])} className="hidden" />

      <button onClick={doExport} disabled={exporting} className="block mx-auto pt-2 text-[15px] font-medium text-mute disabled:opacity-50">
        {exporting ? "Preparing…" : "Export spreadsheets (ZIP) instead"}
      </button>
      <p className={`${note} pt-1 text-center`}>Keep a backup somewhere safe before you switch phones or start a new year.</p>
    </div>
  )
}

/* ---------- reset ---------- */

interface ResetProps {
  subjects: number
  tasks: number
  tags: number
  mates: number
  onReset: () => void
}

export function ResetPanel({ subjects, tasks, tags, mates, onReset }: ResetProps) {
  const [sure, setSure] = useState(false)
  return (
    <div>
      <div className="rounded-2xl bg-bad/[0.07] p-5">
        <span className="w-12 h-12 rounded-full bg-bad/15 text-bad grid place-items-center">
          <Trash weight="fill" className="w-6 h-6" />
        </span>
        <h3 className="text-[20px] font-bold tracking-tight mt-3">Start fresh</h3>
        <p className="text-[15px] text-mute mt-1.5 leading-snug">This deletes everything on this device. It can&rsquo;t be undone, so export a backup first if you might want it.</p>
        <ul className="mt-3 space-y-1 text-[15px]">
          <li>{count(subjects, "subject", "subjects")} with all their attendance</li>
          <li>{count(tasks, "deadline", "deadlines")}</li>
          <li>{count(tags, "tag", "tags")}</li>
          <li>{count(mates, "proxy-mate", "proxy-mates")} and your favour ledger</li>
        </ul>
      </div>
      {sure ? (
        <div className="grid grid-cols-2 gap-2 mt-4">
          <button onClick={() => setSure(false)} className={`${tintButton} h-[52px] text-[17px]`}>
            Cancel
          </button>
          <button onClick={onReset} className="h-[52px] rounded-2xl bg-bad text-paper text-[17px] font-semibold">
            Yes, delete all
          </button>
        </div>
      ) : (
        <button onClick={() => setSure(true)} className="w-full mt-4 h-[52px] rounded-2xl bg-bad/10 text-bad text-[17px] font-semibold">
          Reset all data
        </button>
      )}
    </div>
  )
}

