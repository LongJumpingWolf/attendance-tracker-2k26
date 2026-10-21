"use client"

import { useEffect, useState } from "react"
import { MoonStars, SunHorizon } from "@phosphor-icons/react"
import Sheet, { primaryButton, tintButton } from "./sheet"
import DatePicker from "./date-picker"
import type { Subject } from "@/lib/types"
import { isSubjectSleeping, localDate } from "@/lib/attendance"

function addDays(n: number) {
  const d = new Date()
  d.setDate(d.getDate() + n)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

type SleepRange = { from: string; until: string | "forever" }
type Duration = "7" | "14" | "30" | "custom" | "forever"

export default function SleepSubjectSheet({
  subject, onClose, onSleep, onWake,
}: {
  subject: Subject | null
  onClose: () => void
  onSleep: (id: string, range: SleepRange) => void
  onWake: (id: string) => void
}) {
  const [duration, setDuration] = useState<Duration>("7")
  const [customFrom, setCustomFrom] = useState(localDate())
  const [customUntil, setCustomUntil] = useState(addDays(6))
  const [confirmWake, setConfirmWake] = useState(false)
  useEffect(() => {
    setDuration("7")
    setCustomFrom(localDate())
    setCustomUntil(addDays(6))
    setConfirmWake(false)
  }, [subject?.id])
  if (!subject) return null

  const today = localDate()
  const scheduled = Boolean(subject.sleeping && (subject.sleepUntil === "forever" || !subject.sleepUntil || subject.sleepUntil >= today))
  const currentlySleeping = isSubjectSleeping(subject, today)
  const from = duration === "custom" ? customFrom : today
  const until: SleepRange["until"] = duration === "forever" ? "forever" : duration === "custom" ? customUntil : addDays(Number(duration) - 1)
  const rangeInvalid = duration === "custom" && (!customFrom || !customUntil || customUntil < customFrom || customFrom < today)

  return (
    <Sheet open={!!subject} onClose={onClose} title={scheduled ? "Manage subject sleep" : "Put subject to sleep"}>
      <div className="space-y-5">
        <div className="rounded-2xl bg-secondary p-4 flex gap-3 items-start">
          <span className="w-11 h-11 rounded-xl bg-card grid place-items-center"><MoonStars className="w-6 h-6" /></span>
          <div>
            <p className="text-[16px] font-bold">{subject.name}</p>
            <p className="text-[13px] text-mute mt-1 leading-relaxed">Sleeping hides this subject&apos;s recurring classes from Today, Calendar and reminders during the selected dates. It never deletes the subject, attendance marks, or weekly timetable. You can wake it early.</p>
          </div>
        </div>

        {scheduled ? (
          <div className="rounded-2xl border border-ink/10 p-4">
            <p className="text-[13px] text-mute">Current sleep schedule</p>
            <p className="font-bold mt-1">{subject.sleepFrom && subject.sleepFrom > today ? `Starts ${subject.sleepFrom}` : currentlySleeping ? "Sleeping now" : "Scheduled"}</p>
            <p className="text-[13px] text-mute mt-1">{subject.sleepUntil === "forever" || !subject.sleepUntil ? "Until you wake it manually" : `Through ${subject.sleepUntil}; wakes the next day`}</p>
            {!confirmWake ? <button onClick={() => setConfirmWake(true)} className={`${tintButton} mt-4 w-full`}>Wake / cancel sleep</button> : (
              <div className="grid grid-cols-2 gap-2 mt-4"><button className={tintButton} onClick={() => setConfirmWake(false)}>Keep schedule</button><button className={primaryButton} onClick={() => { onWake(subject.id); onClose() }}><SunHorizon className="w-4 h-4" />Confirm wake</button></div>
            )}
          </div>
        ) : (
          <>
            <div>
              <h3 className="text-[15px] font-bold mb-2">How long?</h3>
              <div className="grid grid-cols-2 gap-2">
                {([{ id: "7", label: "1 week", detail: "7 days" }, { id: "14", label: "2 weeks", detail: "14 days" }, { id: "30", label: "1 month", detail: "30 days" }, { id: "custom", label: "Custom dates", detail: "Choose start and end" }, { id: "forever", label: "Forever", detail: "Wake manually" }] as const).map((option) => (
                  <button key={option.id} type="button" onClick={() => setDuration(option.id)} aria-pressed={duration === option.id} className={`text-left p-3 rounded-2xl border transition ${duration === option.id ? "border-ink bg-ink/[0.05] ring-1 ring-ink/20" : "border-ink/10 bg-card hover:bg-secondary"}`}>
                    <span className="block text-[14px] font-bold">{option.label}</span><span className="block text-[12px] text-mute mt-0.5">{option.detail}</span>
                  </button>
                ))}
              </div>
            </div>
            {duration === "custom" && (
              <div className="rounded-2xl border border-ink/[0.07] p-3.5 space-y-3">
                <p className="text-[13px] text-mute leading-snug">Choose both dates. The subject is hidden only from the start date through the end date, inclusive.</p>
                <div><p className="text-[13px] font-semibold mb-1.5">Sleep from</p><DatePicker label="Sleep start date" value={customFrom} minDate={today} onChange={(value) => { setCustomFrom(value); if (customUntil < value) setCustomUntil(value) }} /></div>
                <div><p className="text-[13px] font-semibold mb-1.5">Wake after</p><DatePicker label="Sleep end date" value={customUntil} minDate={customFrom || today} onChange={setCustomUntil} /></div>
              </div>
            )}
            <div className="rounded-xl bg-secondary px-3.5 py-3 text-[13px] text-mute">
              {duration === "forever" ? "This subject stays asleep until you wake it manually." : `Sleep period: ${from} through ${until}. The subject's attendance history is preserved.`}
            </div>
            <button disabled={rangeInvalid} onClick={() => { onSleep(subject.id, { from, until }); onClose() }} className={`${primaryButton} disabled:opacity-40`}>Confirm sleep</button>
          </>
        )}
      </div>
    </Sheet>
  )
}
