"use client"

import { useEffect, useState } from "react"
import { ShieldCheck } from "@phosphor-icons/react"

export const CONSENT_VERSION = "attendance-terms-consent-v3"

export function TermsContent() {
  return <div className="space-y-4 text-[14px] leading-relaxed text-mute">
    <section><h3 className="text-[16px] font-semibold text-ink mb-1">What is saved</h3><p>Attendance Tracker saves the subjects, timetable, attendance marks, tasks, reminders and Mates you add. A local copy is stored in this browser so your tracker can work without a cloud account.</p></section>
    <section><h3 className="text-[16px] font-semibold text-ink mb-1">Google sign-in and sync</h3><p>If you turn on Google sync, your data is uploaded to the configured cloud service (Firebase is the production backend in this build) so it can be used across signed-in devices. Your data may be processed by service providers that operate sign-in, hosting, database and notification features.</p></section>
    <section><h3 className="text-[16px] font-semibold text-ink mb-1">Mates, Pings and sharing</h3><p>Mates and connected Pings use account identifiers and the information needed to connect and answer attendance questions. WhatsApp/share links include the classes you choose and can be answered by anyone who has that private link. A response can change the selected attendance records, so share links only with intended recipients.</p><p className="mt-2">For product improvement, temporary Mate invites and public share links record when a link is created, opened, and used or answered, along with the sender and recipient display names already shown on the link. This feature does not intentionally collect the recipient&apos;s IP address, precise location or device fingerprint. Counts can be approximate. A verified developer account can view these link-usage statistics. Analytics events are cleaned up when the dashboard is opened after they are older than 90 days.</p></section>
    <section><h3 className="text-[16px] font-semibold text-ink mb-1">Optional app-usage analytics</h3><p>This is a separate, optional choice. If you opt in, the app records broad events such as opening the app, viewing one of its main screens, marking or clearing an attendance entry, adding or completing a task, and creating or editing a subject. It stores a pseudonymous Firebase account ID, a random tab-session ID, the event category, the screen category, and a server timestamp. It does not intentionally record subject names, task titles, attendance values, attendance dates, notes, email addresses, IP addresses, precise location, or device/browser fingerprints in these analytics records. A verified developer can inspect the events to calculate active users, repeat use and feature popularity. Records older than 90 days are removed when the developer analytics dashboard is opened. You can leave this unchecked and still use the app.</p></section>
    <section><h3 className="text-[16px] font-semibold text-ink mb-1">Privacy promise</h3><p>The app is not designed to sell your data or share it with advertisers. This does not mean the app never sends data anywhere: cloud sync, authentication, social features, links and notifications require processing by the relevant services. Do not add information that the app does not need.</p></section>
    <section><h3 className="text-[16px] font-semibold text-ink mb-1">Backups and control</h3><p>Local-only data does not automatically appear on another device. Use Settings → Sync and wait for an up-to-date status, and keep a full export from Backup &amp; restore if the records matter to you. Do not clear browser data until you have verified a current backup. Reset and replacement actions show their own warnings; cloud copies may need to be managed separately.</p></section>
    <section><h3 className="text-[16px] font-semibold text-ink mb-1">Notifications</h3><p>Notifications depend on browser/device permission, connectivity, service-worker support and server configuration. Scheduled reminders may only run while the app is open; delivery when the app is closed is not guaranteed. Test notifications on the device where you need them.</p></section>
    <section><h3 className="text-[16px] font-semibold text-ink mb-1">Common questions</h3><p><b className="text-ink">Will you sell my data?</b> The app is not designed to sell personal data or share it with advertisers.</p><p><b className="text-ink">Does data leave my device?</b> Only when you use features such as sync, sign-in, Mates, Pings or notifications, according to their settings.</p><p><b className="text-ink">Do I have to turn on sync?</b> No, but local-only data may be lost if this browser&apos;s storage is cleared or its device is lost.</p><p><b className="text-ink">Are attendance suggestions official?</b> No. Check your college timetable, holidays and attendance records against official information.</p><p><b className="text-ink">What does a Ping do?</b> A response can update the selected attendance record; it is not independent verification of attendance.</p></section>
    <section><h3 className="text-[16px] font-semibold text-ink mb-1">Terms and limitations</h3><p>Use the app for personal organization. It is supplied as-is and may be unavailable or contain errors. This plain-language notice is not a formally reviewed legal privacy policy or legal advice.</p></section>
  </div>
}

export default function TermsGate({ open, onAgree }: { open: boolean; onAgree: (usageAnalyticsEnabled: boolean) => void }) {
  const [checked, setChecked] = useState(false)
  const [usageAnalyticsChecked, setUsageAnalyticsChecked] = useState(true)

  useEffect(() => {
    if (!open) {
      setChecked(false)
      return
    }
    // Default to enabled as requested, while honoring an explicit previous opt-out.
    try {
      setUsageAnalyticsChecked(localStorage.getItem("attendance-usage-analytics-consent") !== "0")
    } catch {
      setUsageAnalyticsChecked(true)
    }
  }, [open])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-[100] bg-black/55 flex items-center justify-center p-3 sm:p-6">
      <section role="dialog" aria-modal="true" aria-labelledby="terms-heading" className="w-full max-w-xl h-[94dvh] max-h-[860px] rounded-[28px] bg-card shadow-2xl overflow-hidden flex flex-col">
        <header className="px-5 pt-5 pb-3 border-b border-ink/10 flex gap-3 items-center flex-shrink-0">
          <span className="w-11 h-11 rounded-xl bg-info/10 text-info grid place-items-center flex-shrink-0"><ShieldCheck className="w-6 h-6" /></span>
          <div className="min-w-0">
            <h2 id="terms-heading" className="text-[22px] font-bold tracking-tight">Your data and how the app works</h2>
            <p className="text-[13px] text-mute mt-1">Choose your preferences, then review the notice below.</p>
          </div>
        </header>

        <div className="px-5 py-3 border-b border-ink/10 bg-card space-y-3 flex-shrink-0">
          <label className="flex items-start gap-2.5 text-[13px] leading-snug text-ink">
            <input type="checkbox" checked={usageAnalyticsChecked} onChange={(e) => setUsageAnalyticsChecked(e.target.checked)} className="mt-0.5 accent-current flex-shrink-0" />
            <span><b>Share optional usage analytics</b><span className="block text-mute mt-0.5">Preselected to help improve the app. This records broad feature-use events, not subject names or attendance values. You can switch it off.</span></span>
          </label>
          <label className="flex items-start gap-2.5 text-[13px] leading-snug text-ink">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.target.checked)} className="mt-0.5 accent-current flex-shrink-0" />
            <span><b>I agree to the data and usage notice</b><span className="block text-mute mt-0.5">Required to continue using the app.</span></span>
          </label>
        </div>

        <div tabIndex={0} aria-label="Scrollable privacy and terms notice" className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-5 py-4">
          <TermsContent />
          <p className="mt-4 text-[12px] text-mute">End of notice.</p>
        </div>

        <footer className="border-t border-ink/10 px-5 py-4 bg-card flex-shrink-0">
          <button disabled={!checked} onClick={() => onAgree(usageAnalyticsChecked)} className="w-full h-[50px] rounded-2xl bg-ink text-paper text-[16px] font-semibold disabled:opacity-35">
            Agree and continue
          </button>
        </footer>
      </section>
    </div>
  )
}
