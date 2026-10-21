"use client"

import { useEffect, useRef, useState } from "react"
import { ShieldCheck } from "@phosphor-icons/react"

export const CONSENT_VERSION = "attendance-terms-consent-v1"

export function TermsContent() {
  return <div className="space-y-4 text-[14px] leading-relaxed text-mute">
    <section><h3 className="text-[16px] font-semibold text-ink mb-1">What is saved</h3><p>Attendance Tracker saves the subjects, timetable, attendance marks, tasks, reminders and Mates you add. A local copy is stored in this browser so your tracker can work without a cloud account.</p></section>
    <section><h3 className="text-[16px] font-semibold text-ink mb-1">Google sign-in and sync</h3><p>If you turn on Google sync, your data is uploaded to the configured cloud service (Firebase is the production backend in this build) so it can be used across signed-in devices. Your data may be processed by service providers that operate sign-in, hosting, database and notification features.</p></section>
    <section><h3 className="text-[16px] font-semibold text-ink mb-1">Mates, Pings and sharing</h3><p>Mates and connected Pings use account identifiers and the information needed to connect and answer attendance questions. WhatsApp/share links include the classes you choose and can be answered by anyone who has that private link. A response can change the selected attendance records, so share links only with intended recipients.</p></section>
    <section><h3 className="text-[16px] font-semibold text-ink mb-1">Privacy promise</h3><p>The app is not designed to sell your data or share it with advertisers. This does not mean the app never sends data anywhere: cloud sync, authentication, social features, links and notifications require processing by the relevant services. Do not add information that the app does not need.</p></section>
    <section><h3 className="text-[16px] font-semibold text-ink mb-1">Backups and control</h3><p>Local-only data does not automatically appear on another device. Use Settings → Sync and wait for an up-to-date status, and keep a full export from Backup &amp; restore if the records matter to you. Do not clear browser data until you have verified a current backup. Reset and replacement actions show their own warnings; cloud copies may need to be managed separately.</p></section>
    <section><h3 className="text-[16px] font-semibold text-ink mb-1">Notifications</h3><p>Notifications depend on browser/device permission, connectivity, service-worker support and server configuration. Scheduled reminders may only run while the app is open; delivery when the app is closed is not guaranteed. Test notifications on the device where you need them.</p></section>
    <section><h3 className="text-[16px] font-semibold text-ink mb-1">Common questions</h3><p><b className="text-ink">Will you sell my data?</b> The app is not designed to sell personal data or share it with advertisers.</p><p><b className="text-ink">Does data leave my device?</b> Only when you use features such as sync, sign-in, Mates, Pings or notifications, according to their settings.</p><p><b className="text-ink">Do I have to turn on sync?</b> No, but local-only data may be lost if this browser&apos;s storage is cleared or its device is lost.</p><p><b className="text-ink">Are attendance suggestions official?</b> No. Check your college timetable, holidays and attendance records against official information.</p><p><b className="text-ink">What does a Ping do?</b> A response can update the selected attendance record; it is not independent verification of attendance.</p></section>
    <section><h3 className="text-[16px] font-semibold text-ink mb-1">Terms and limitations</h3><p>Use the app for personal organization. It is supplied as-is and may be unavailable or contain errors. This plain-language notice is not a formally reviewed legal privacy policy or legal advice.</p></section>
  </div>
}

export default function TermsGate({ open, onAgree }: { open: boolean; onAgree: () => void }) {
  const [atEnd, setAtEnd] = useState(false)
  const [checked, setChecked] = useState(false)
  const scrollRegion = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) { setAtEnd(false); setChecked(false); return }
    const el = scrollRegion.current
    if (el && el.scrollHeight <= el.clientHeight + 12) setAtEnd(true)
  }, [open])
  if (!open) return null
  return <div className="fixed inset-0 z-[100] bg-black/55 flex items-center justify-center p-3 sm:p-6">
    <section role="dialog" aria-modal="true" aria-labelledby="terms-heading" className="w-full max-w-xl max-h-[94dvh] rounded-[28px] bg-card shadow-2xl overflow-hidden flex flex-col">
      <header className="px-5 pt-5 pb-3 border-b border-ink/10 flex gap-3 items-center"><span className="w-11 h-11 rounded-xl bg-info/10 text-info grid place-items-center flex-shrink-0"><ShieldCheck className="w-6 h-6"/></span><div><h2 id="terms-heading" className="text-[22px] font-bold tracking-tight">Your data and how the app works</h2><p className="text-[13px] text-mute mt-1">Please read this notice to continue.</p></div></header>
      <div ref={scrollRegion} tabIndex={0} aria-label="Scroll through privacy and terms" className="overflow-y-auto overscroll-contain px-5 py-4" onScroll={e=>{const el=e.currentTarget;if(el.scrollTop+el.clientHeight>=el.scrollHeight-12)setAtEnd(true)}}><TermsContent/><p className="mt-4 text-[12px] text-mute">End of notice. Scroll to this point before continuing.</p></div>
      <footer className="border-t border-ink/10 px-5 py-4 bg-card">{!atEnd&&<p className="text-[12px] text-mute mb-2">Scroll through the notice to enable agreement.</p>}<label className={`flex items-start gap-2.5 text-[13px] leading-snug ${atEnd?"text-ink":"text-mute"}`}><input type="checkbox" checked={checked} disabled={!atEnd} onChange={e=>setChecked(e.target.checked)} className="mt-0.5 accent-current"/><span>I have read and agree to this notice.</span></label><button disabled={!atEnd||!checked} onClick={onAgree} className="w-full h-[50px] rounded-2xl bg-ink text-paper text-[16px] font-semibold mt-3 disabled:opacity-35">Agree and continue</button></footer>
    </section>
  </div>
}
