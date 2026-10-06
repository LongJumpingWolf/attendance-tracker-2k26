"use client"

import { useEffect, useState } from "react"
import type { FullBackupData } from "@/lib/backup"
import { deleteRestorePoint, listRestorePoints, type RestorePoint } from "@/lib/restore-points"
import { tintButton } from "./sheet"

const label = "text-[12px] font-medium uppercase tracking-wider text-mute mb-2 px-1"

const when = (at: number) =>
  new Date(at).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })

/** Automatic copies of this device's data, saved just before a sync, join, restore or reset could change it */
export default function RestorePoints({ onRestore, onToast }: { onRestore: (data: FullBackupData) => void; onToast: (message: string) => void }) {
  const [points, setPoints] = useState<RestorePoint[] | null>(null)
  const [confirming, setConfirming] = useState<string | null>(null)

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
              {when(p.at)} · {p.data.subjects.length} {p.data.subjects.length === 1 ? "subject" : "subjects"}, {p.data.tasks.length}{" "}
              {p.data.tasks.length === 1 ? "deadline" : "deadlines"}
            </p>
            {confirming === p.id ? (
              <div className="mt-3">
                <p className="text-[13px] text-mute leading-snug">This replaces what is on this device now. A restore point of it is saved first.</p>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <button onClick={() => setConfirming(null)} className={tintButton}>
                    Cancel
                  </button>
                  <button
                    onClick={() => {
                      setConfirming(null)
                      onRestore(p.data)
                      onToast("Restored")
                      void listRestorePoints().then(setPoints)
                    }}
                    className={tintButton}
                  >
                    Restore
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
