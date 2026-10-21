"use client"

import { useState } from "react"
import type { CloudSync } from "@/hooks/use-cloud-sync"
import type { Choice, Counts } from "@/lib/signin-reconcile"
import Sheet, { tintButton } from "./sheet"

const label = "text-[12px] font-medium uppercase tracking-wider text-mute mb-2 px-1"
const card = "rounded-2xl bg-secondary p-4"

const ROWS: { key: keyof Counts; text: string }[] = [
  { key: "subjects", text: "Subjects" },
  { key: "marks", text: "Attendance marks" },
  { key: "tasks", text: "Deadlines" },
  { key: "tags", text: "Tags" },
  { key: "mates", text: "Mates" },
  { key: "reminders", text: "Reminders" },
]

const TITLES: Record<Choice, string> = {
  merge: "Combine both",
  device: "Use this device’s data",
  cloud: "Use my account’s data",
}
const ACTIONS: Record<Choice, string> = {
  merge: "Combine both",
  device: "Replace my account’s copy with this device’s data",
  cloud: "Replace this device’s data with my account’s",
}

/**
 * Shown right after a first sign-in on a device that already has data, when the account holds different data too (or the data
 * on this device belonged to another account). It compares the two, says plainly what each option does, and only runs the
 * person's choice. Everything it does is in lib/signin-reconcile.ts; this file is only the screen.
 */
export default function ReconcileSheet({ sync }: { sync: CloudSync }) {
  const st = sync.reconcile
  if (!st || !st.offer || st.declined) return null
  // A different comparison (the account changed while choosing) starts fresh: a new key resets the selection and the confirmation
  const key = `${st.offer.rev}|${JSON.stringify(st.offer.comparison.device)}|${JSON.stringify(st.offer.comparison.account)}`
  return <ReconcileBody key={key} sync={sync} />
}

function ReconcileBody({ sync }: { sync: CloudSync }) {
  const st = sync.reconcile
  const [choice, setChoice] = useState<Choice | null>(st?.offer.recommended ?? null)
  const [sure, setSure] = useState(false)
  // Why a choice was not started (another change is in progress, sync is paused): the controller answers with a message that is
  // not an error of the prompt itself, so it is shown here instead of being dropped
  const [notice, setNotice] = useState<string | null>(null)
  if (!st) return null
  const offer = st.offer
  const c = offer.comparison
  const opt = choice ? offer.options.find((o) => o.choice === choice) : undefined
  const needsSure = Boolean(opt?.destructive)
  const ready = Boolean(opt?.enabled) && (!needsSure || sure) && !st.working

  return (
    <Sheet open onClose={sync.declineReconcile} title="Combine your data">
      <div className="space-y-5" data-testid="reconcile-sheet">
        <p className="text-[14px] text-mute leading-snug">
          {offer.foreign
            ? "This device still holds data from a different account. It is only added to this account if you choose to."
            : `You’re signed in${sync.account?.email ? ` as ${sync.account.email}` : ""}. This device and your account both have data, and they aren’t the same.`}
        </p>

        <section>
          <h3 className={label}>What each side has</h3>
          <div className={`${card} text-[14px]`} role="table" aria-label="Comparison of this device and your account">
            <div className="grid grid-cols-[1.4fr_1fr_1fr_1fr] gap-x-2 text-[12px] text-mute font-medium pb-2" role="row">
              <span role="columnheader"></span>
              <span role="columnheader" className="text-right">This device</span>
              <span role="columnheader" className="text-right">Your account</span>
              <span role="columnheader" className="text-right">On both</span>
            </div>
            {ROWS.filter((r) => c.device[r.key] + c.account[r.key] > 0).map((r) => (
              <div key={r.key} className="grid grid-cols-[1.4fr_1fr_1fr_1fr] gap-x-2 py-1" role="row" data-row={r.key}>
                <span role="rowheader">{r.text}</span>
                <span className="text-right num">{c.device[r.key]}</span>
                <span className="text-right num">{c.account[r.key]}</span>
                <span className="text-right num">{c.both[r.key]}</span>
              </div>
            ))}
          </div>
        </section>

        {c.conflicts > 0 && (
          <section data-testid="reconcile-conflicts">
            <h3 className={label}>Where they disagree</h3>
            <div className={card}>
              <p className="text-[14px] leading-snug">
                {c.conflicts} {c.conflicts === 1 ? "value differs" : "values differ"}
                {c.conflictItems.length > 0 ? `, in: ${c.conflictItems.slice(0, 6).map((i) => i.name).join(", ")}${c.conflictItems.length > 6 ? "…" : ""}` : ""}.
              </p>
              <p className="text-[13px] text-mute mt-1 leading-snug">
                If you combine, this device’s version is kept and the other version is saved under Restore points, so nothing is lost. Choosing
                record by record isn’t available.
              </p>
            </div>
          </section>
        )}

        <section>
          <h3 className={label}>What would you like to do?</h3>
          <div className="space-y-2" role="radiogroup" aria-label="How to combine">
            {offer.options.map((o) => (
              <label
                key={o.choice}
                data-testid={`reconcile-option-${o.choice}`}
                className={`block rounded-2xl p-4 cursor-pointer ${choice === o.choice ? "bg-ink/10 ring-1 ring-ink/40" : "bg-secondary"} ${o.enabled ? "" : "opacity-50 cursor-not-allowed"}`}
              >
                <span className="flex items-start gap-3">
                  <input
                    type="radio"
                    name="reconcile-choice"
                    className="mt-1"
                    checked={choice === o.choice}
                    disabled={!o.enabled || st.working}
                    onChange={() => {
                      setChoice(o.choice)
                      setSure(false) // a confirmation never carries over to a different option
                    }}
                  />
                  <span className="min-w-0">
                    <span className="block text-[15px] font-semibold leading-snug">
                      {TITLES[o.choice]}
                      {offer.recommended === o.choice && <span className="ml-2 text-[11px] font-semibold rounded-full bg-good/15 text-good px-2 py-0.5">Recommended</span>}
                    </span>
                    <span className="block text-[13px] text-mute leading-snug mt-0.5">{o.note}</span>
                  </span>
                </span>
              </label>
            ))}
          </div>
        </section>

        {needsSure && opt?.enabled && (
          <label className="flex items-start gap-3 rounded-2xl bg-bad/10 p-4 text-[14px] leading-snug cursor-pointer">
            <input data-testid="reconcile-confirm" type="checkbox" className="mt-1" checked={sure} disabled={st.working} onChange={(e) => setSure(e.target.checked)} />
            <span>
              {choice === "cloud"
                ? "I understand this replaces the data on this device. A copy is saved under Restore points first."
                : "I understand this replaces my account’s copy. The copy it replaces is saved on this device under Restore points first, and other devices will follow."}
            </span>
          </label>
        )}

        {notice && !st.error && (
          <p role="status" data-testid="reconcile-notice" className="text-[14px] text-mute leading-snug">
            {notice}
          </p>
        )}

        {st.error && (
          <p role="alert" data-testid="reconcile-error" className="text-[14px] text-bad leading-snug">
            {st.error}
          </p>
        )}

        <div className="grid gap-2">
          <button
            data-testid="reconcile-apply"
            disabled={!ready}
            onClick={async () => {
              if (!choice) return
              setNotice(null)
              setNotice(await sync.chooseReconcile(choice, needsSure && sure))
            }}
            className="w-full min-h-[52px] h-auto rounded-2xl bg-ink text-paper text-[14px] font-semibold leading-snug whitespace-normal break-words px-4 py-3 hover:bg-ink/90 transition disabled:opacity-40"
          >
            {st.working ? "Working…" : choice ? ACTIONS[choice] : "Choose an option"}
          </button>
          <button data-testid="reconcile-later" disabled={st.working} onClick={sync.declineReconcile} className={tintButton}>
            Decide later
          </button>
          <p className="text-[12px] text-mute leading-snug px-1">
            Until you choose, this device keeps working on its own and nothing is sent to or taken from your account.
          </p>
        </div>
      </div>
    </Sheet>
  )
}
