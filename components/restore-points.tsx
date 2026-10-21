"use client"

import { useEffect, useState } from "react"
import type { FullBackupData } from "@/lib/backup"
import { contents, deleteRestorePoint, listRestorePoints, type RestorePoint } from "@/lib/restore-points"
import { MESSAGES, runGuarded } from "@/lib/safe-replace"
import { tintButton } from "./sheet"

const label = "text-[12px] font-medium uppercase tracking-wider text-mute mb-2 px-1"

const when = (at: number) =>
  new Date(at).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })

const unrecordedNote = (p: RestorePoint): string => {
  const left = [p.remindersKnown === false && "reminders", p.tagsKnown === false && "tags", p.matesKnown === false && "mates", p.holidaysKnown === false && "holidays", p.scheduleOverridesKnown === false && "timetable changes"].filter(Boolean)
  return left.length ? ` This older copy didn’t include ${left.join(", ")}, so yours are left as they are.` : ""
}

/** Automatic copies of this device's data, saved just before a sync, join, restore or reset could change it */
export default function RestorePoints({ onRestore, onToast }: { onRestore: (data: FullBackupData, known: { reminders: boolean; tags: boolean; mates: boolean; holidays: boolean; scheduleOverrides: boolean }) => Promise<boolean>; onToast: (message: string) => void }) {
  const [points, setPoints] = useState<RestorePoint[] | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)
  const [working, setWorking] = useState(false)

  useEffect(() => {
    void listRestorePoints().then(setPoints)
  }, [])

  if (!points || points.length === 0) {
    return (
      <section>
        <h3 className={label}>Restore points</h3>
        <p className="rounded-2xl bg-secondary p-4 text-[13px] text-mute leading-snug">
          None yet. Before a sync, a restore or a reset could change your data, a copy is saved here automatically.
        </p>
      </section>
    )
  }

  return (
    <section>
      <h3 className={label}>Restore points</h3>
      <ul className="space-y-2">
        {points.map((p) => (
          <li key={p.id} className="rounded-2xl bg-secondary p-3.5">
            <p className="text-[15px] font-semibold leading-snug">{p.reason}</p>
            <p className="text-[13px] text-mute leading-snug">
              {when(p.at)} · {contents(p)}
            </p>
            {confirming === p.id ? (
              <div className="mt-3">
                <p className="text-[13px] text-mute leading-snug">
                  This replaces what is on this device now. A restore point of it is saved first.
                  {unrecordedNote(p)}
                </p>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <button onClick={() => setConfirming(null)} disabled={working} className={tintButton}>
                    Cancel
                  </button>
                  <button
                    disabled={working}
                    onClick={async () => {
                      setWorking(true)
                      // "Restored" only once it really was; otherwise the confirmation stays and the reason is shown
                      await runGuarded(
                        () => onRestore(p.data, { reminders: p.remindersKnown !== false, tags: p.tagsKnown !== false, mates: p.matesKnown !== false, holidays: p.holidaysKnown !== false, scheduleOverrides: p.scheduleOverridesKnown !== false }),
                        () => {
                          setConfirming(null)
                          onToast("Restored")
                        },
                        () => onToast(MESSAGES.restoreFailed),
                      )
                      setWorking(false)
                      void listRestorePoints().then(setPoints)
                    }}
                    className={tintButton}
                  >
                    {working ? "Restoring…" : "Restore"}
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex gap-4 mt-2.5">
                <button onClick={() => setConfirming(p.id)} className="text-[14px] font-medium">
                  Restore
                </button>
                <button
                  onClick={() => void deleteRestorePoint(p.id).then(() => listRestorePoints().then(setPoints))}
                  className="text-[14px] text-mute"
                >
                  Delete
                </button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}
