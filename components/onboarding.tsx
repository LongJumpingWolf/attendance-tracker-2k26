"use client"

import { useEffect, useState } from "react"
import { BellRinging, CalendarPlus, Check, PencilSimple, UsersThree } from "@phosphor-icons/react"
import Sheet, { inputClass, primaryButton, tintButton, fieldLabel } from "./sheet"
import { entriesFromTimetable, loadSchedule, saveSchedule, syncPush } from "@/lib/reminders"
import type { Subject } from "@/lib/types"

interface Props {
  open: boolean
  /** Called when the tour ends, whether finished or skipped */
  onClose: () => void
  subjects: Subject[]
  currentName: string
  onSetName: (name: string) => void
  onImportTimetable: () => void
  onAddSubject: () => void
  notificationSupported: boolean
  notificationPermission: NotificationPermission | null
  onEnableNotifications: () => Promise<void>
  onOpenMates: () => void
  onToast: (message: string) => void
}

const STEPS = ["Welcome", "Your classes", "Reminders", "Your mates"]

function Choice({ icon, title, hint, onClick, done }: { icon: React.ReactNode; title: string; hint: string; onClick: () => void; done?: boolean }) {
  return (
    <button type="button" onClick={onClick} className="w-full flex items-center gap-3.5 rounded-2xl bg-secondary p-4 text-left active:scale-[0.99] transition">
      <span className={`w-11 h-11 rounded-xl grid place-items-center flex-shrink-0 ${done ? "bg-good/15 text-good" : "bg-card text-ink"}`}>{done ? <Check weight="bold" className="w-5 h-5" /> : icon}</span>
      <span className="min-w-0">
        <span className="block text-[16px] font-semibold leading-snug">{title}</span>
        <span className="block text-[13px] text-mute leading-snug">{hint}</span>
      </span>
    </button>
  )
}

export default function Onboarding(p: Props) {
  const [step, setStep] = useState(0)
  const [name, setName] = useState("")
  const [remindersMade, setRemindersMade] = useState(0)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (p.open) {
      setStep(0)
      setName(p.currentName === "You" ? "" : p.currentName)
      setRemindersMade(0)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.open])

  const hasTimetable = p.subjects.some((s) => s.slots?.length)
  const notifOn = p.notificationPermission === "granted"

  const next = () => {
    if (step === 0 && name.trim()) p.onSetName(name.trim())
    setStep((s) => Math.min(STEPS.length - 1, s + 1))
  }

  const enable = async () => {
    setBusy(true)
    try {
      await p.onEnableNotifications()
    } finally {
      setBusy(false)
    }
  }

  const makeReminders = () => {
    const existing = loadSchedule()
    const made = entriesFromTimetable(p.subjects, existing)
    if (made.length === 0) return p.onToast("Add your class times first")
    saveSchedule([...existing, ...made])
    made.forEach((e) => void syncPush(e))
    setRemindersMade(made.length)
  }

  return (
    <Sheet open={p.open} onClose={p.onClose} title={STEPS[step]} onBack={step > 0 ? () => setStep(step - 1) : undefined}>
      <div className="flex gap-1.5 mb-5" aria-hidden>
        {STEPS.map((s, i) => (
          <span key={s} className={`h-1 flex-1 rounded-full transition-colors ${i <= step ? "bg-ink" : "bg-ink/15"}`} />
        ))}
      </div>

      {step === 0 && (
        <div>
          <h3 className="text-[clamp(22px,6.4vw,28px)] font-bold tracking-tight leading-tight">Know exactly where you stand.</h3>
          <p className="text-[15px] text-mute mt-2 leading-snug">Track attendance per subject, see how many classes you can skip, and let your mates cover for you when you can&rsquo;t make it. It takes a minute to set up.</p>
          <label className="block mt-6">
            <span className={fieldLabel}>What should your friends call you?</span>
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && next()}
              placeholder="Your name"
              maxLength={40}
              className={inputClass}
            />
          </label>
          <p className="text-[13px] text-mute mt-2 leading-snug">Only shown to mates you connect with. You can skip this and add it later.</p>
          <button type="button" onClick={next} className={`${primaryButton} mt-6`}>
            Let&rsquo;s go
          </button>
        </div>
      )}

      {step === 1 && (
        <div>
          <p className="text-[15px] text-mute leading-snug mb-4">Add your subjects and when they meet. That puts each class on your Today screen at the right time.</p>
          <div className="space-y-2.5">
            <Choice icon={<CalendarPlus weight="duotone" className="w-6 h-6" />} title="Import from a timetable photo" hint="ChatGPT reads it, you paste the result" onClick={p.onImportTimetable} />
            <Choice icon={<PencilSimple weight="duotone" className="w-6 h-6" />} title="Add a subject myself" hint="Name, minimum attendance and class times" onClick={p.onAddSubject} />
          </div>
          {p.subjects.length > 0 && (
            <p className="mt-4 flex items-center gap-2 text-[14px] font-medium text-good">
              <Check weight="bold" className="w-4 h-4" /> {p.subjects.length} {p.subjects.length === 1 ? "subject" : "subjects"} added
            </p>
          )}
          <button type="button" onClick={next} className={`${p.subjects.length ? primaryButton : tintButton + " w-full h-[52px] text-[17px]"} mt-5`}>
            {p.subjects.length ? "Continue" : "Skip for now"}
          </button>
        </div>
      )}

      {step === 2 && (
        <div>
          <p className="text-[15px] text-mute leading-snug mb-4">Get a nudge before class so you never forget to mark it.</p>
          <div className="space-y-2.5">
            {p.notificationSupported && (
              <Choice
                icon={<BellRinging weight="duotone" className="w-6 h-6" />}
                title={notifOn ? "Notifications are on" : busy ? "Asking…" : "Turn on notifications"}
                hint={p.notificationPermission === "denied" ? "Blocked in your browser. You can allow them in its settings." : "Your browser will ask for permission"}
                done={notifOn}
                onClick={notifOn || p.notificationPermission === "denied" ? () => {} : enable}
              />
            )}
            <Choice
              icon={<CalendarPlus weight="duotone" className="w-6 h-6" />}
              title={remindersMade ? `${remindersMade} reminders added` : "Remind me before each class"}
              hint={hasTimetable ? "10 minutes before every class on your timetable" : "Needs class times: add them in the last step or later"}
              done={remindersMade > 0}
              onClick={remindersMade ? () => {} : makeReminders}
            />
          </div>
          <button type="button" onClick={next} className={`${primaryButton} mt-6`}>
            Continue
          </button>
        </div>
      )}

      {step === 3 && (
        <div>
          <span className="w-14 h-14 rounded-2xl bg-secondary grid place-items-center text-ink">
            <UsersThree weight="duotone" className="w-8 h-8" />
          </span>
          <h3 className="text-[22px] font-bold tracking-tight leading-tight mt-4">Proxy-mates have your back.</h3>
          <p className="text-[15px] text-mute mt-2 leading-snug">
            Connect with friends by QR code or link. When you miss a class, ping a mate: if they marked you present, one tap confirms it and it lands in your record. The Mates tab keeps track of who you owe.
          </p>
          <div className="grid gap-2 mt-6">
            <button
              type="button"
              onClick={() => {
                p.onClose()
                p.onOpenMates()
              }}
              className={primaryButton}
            >
              Connect a mate
            </button>
            <button type="button" onClick={p.onClose} className={`${tintButton} w-full h-[52px] text-[17px]`}>
              I&rsquo;ll do it later
            </button>
          </div>
        </div>
      )}
    </Sheet>
  )
}
