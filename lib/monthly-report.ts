import type { ScheduleOverride, Subject } from "./types"
import { isSubjectSleeping } from "./attendance"

const esc = (value: unknown) => String(value ?? "").replace(/[&<>\"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
const pad2 = (value: number) => String(value).padStart(2, "0")
const dateKey = (year: number, month: number, day: number) => `${year}-${pad2(month + 1)}-${pad2(day)}`
const FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'SF Pro Display', Inter, 'Segoe UI', system-ui, sans-serif"
type Mark = "P" | "A"
type DayState = "present" | "absent" | "unmarked" | "cancelled" | "no-class"

/** Produce a varied but rotationally symmetric kaleidoscope from local SVG geometry only. */
function kaleidoscope(seedText: string) {
  let seed = 2166136261
  for (const char of seedText) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0
  const rand = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296 }
  const palette = ["#c5ddd0", "#e9d9b9", "#d6c7e7", "#e9c8bd", "#d4e1e9", "#a9c8bb", "#f0e7d7"]
  const shapes: string[] = []
  const cx = 790, cy = 155
  // Pick a small set of parameters per export, then repeat the exact geometry around the center.
  // This gives each export a different true kaleidoscope rather than an unstructured collection of random shapes.
  const symmetry = [8, 12, 16][Math.floor(rand() * 3)]
  const angleStep = 360 / symmetry
  const outer = 157 + rand() * 43
  const width = 25 + rand() * 12
  const rotation = Math.floor(rand() * 12) * (angleStep / 12)
  const paletteOffset = Math.floor(rand() * palette.length)
  const colorAt = (index: number) => palette[(index + paletteOffset + palette.length) % palette.length]

  for (let sector = 0; sector < symmetry; sector++) {
    const angle = sector * angleStep + rotation
    const color = colorAt(sector % 4)
    const opacity = (0.29 + rand() * 0.10).toFixed(2)
    shapes.push(`<path d="M 0 0 C ${-width} -35 ${-width * 1.5} -${outer * 0.48} 0 -${outer} C ${width * 1.5} -${outer * 0.48} ${width} -35 0 0 Z" transform="translate(${cx} ${cy}) rotate(${angle.toFixed(2)})" fill="${color}" fill-opacity="${opacity}" stroke="#ffffff" stroke-opacity=".34" stroke-width="1.5"/>`)
  }

  const rings = [57, 91, 128, 169, 208]
  rings.forEach((radius, ring) => {
    const size = 6 + ring * 1.2 + rand() * 2.5
    for (let sector = 0; sector < symmetry; sector++) {
      const angle = sector * angleStep + (ring % 2 ? angleStep / 2 : 0) + rotation
      const x = cx, y = cy - radius
      const color = colorAt((sector % 4) + ring * 2)
      shapes.push(`<circle cx="${x}" cy="${y}" r="${size.toFixed(1)}" transform="rotate(${angle.toFixed(2)} ${cx} ${cy})" fill="${color}" fill-opacity=".78"/>`)
      if ((sector + ring) % 2 === 0) {
        shapes.push(`<path d="M ${x} ${y - size * 1.65} L ${x + size} ${y} L ${x} ${y + size * 1.65} L ${x - size} ${y} Z" transform="rotate(${angle.toFixed(2)} ${cx} ${cy})" fill="${colorAt(sector + ring + 2)}" fill-opacity=".72"/>`)
      }
    }
  })
  shapes.push(`<circle cx="${cx}" cy="${cy}" r="37" fill="#fbf7ee" fill-opacity=".92" stroke="#8aa99b" stroke-opacity=".52" stroke-width="2"/><circle cx="${cx}" cy="${cy}" r="16" fill="#8aa99b" fill-opacity=".78"/>`)
  return shapes.join("")
}

function stateForDate(
  date: string,
  dayOfWeek: number,
  subject: Subject,
  marksByDate: Map<string, Map<string, Mark>>,
  overridesByDate: Map<string, ScheduleOverride[]>,
): { state: DayState; replaced: boolean; cancelledSome: boolean; scheduled: number } {
  // A sleeping subject contributes no scheduled classes on dates inside its sleep range.
  if (isSubjectSleeping(subject, date)) return { state: "no-class", replaced: false, cancelledSome: false, scheduled: 0 }

  const recurringSlots = (subject.slots ?? []).filter((slot) => slot.day === dayOfWeek)
  const changes = overridesByDate.get(date) ?? []
  const recurringStarts = new Set(recurringSlots.map((slot) => slot.start))
  // Ignore stale/malformed overrides whose start time no longer belongs to a recurring slot.
  const cancelledStarts = new Set(changes.filter((o) => o.kind === "cancelled" && recurringStarts.has(o.start)).map((o) => o.start))
  const replacedStarts = new Set(changes.filter((o) => o.kind === "substitute" && recurringStarts.has(o.start)).map((o) => o.start))
  const activeSlots = recurringSlots.filter((slot) => !cancelledStarts.has(slot.start))
  const scheduled = activeSlots.length
  const cancelledSome = cancelledStarts.size > 0
  const replaced = replacedStarts.size > 0
  const cancelledAll = recurringSlots.length > 0 && scheduled === 0 && cancelledSome
  if (cancelledAll) return { state: "cancelled", replaced, cancelledSome, scheduled }

  const marks = marksByDate.get(date) ?? new Map<string, Mark>()
  if (scheduled > 0) {
    const states = activeSlots.map((slot) => marks.get(slot.start) ?? (recurringSlots.length === 1 ? marks.get("") : undefined))
    // A day has one circle. It is green/red only if every remaining scheduled class is consistently marked;
    // partial or mixed attendance stays neutral instead of misrepresenting the day.
    if (states.every((state) => state === "P")) return { state: "present", replaced, cancelledSome, scheduled }
    if (states.every((state) => state === "A")) return { state: "absent", replaced, cancelledSome, scheduled }
    return { state: "unmarked", replaced, cancelledSome, scheduled }
  }

  // No recurring slot today: retain older/manual marks even if the weekly timetable has since changed.
  // If those marks disagree, a single calendar circle cannot truthfully show green or red, so use neutral grey.
  if (recurringSlots.length === 0 && marks.size > 0) {
    const values = [...marks.values()]
    if (values.every((mark) => mark === "P")) return { state: "present", replaced, cancelledSome, scheduled: 0 }
    if (values.every((mark) => mark === "A")) return { state: "absent", replaced, cancelledSome, scheduled: 0 }
    return { state: "unmarked", replaced, cancelledSome, scheduled: 0 }
  }
  return { state: "no-class", replaced, cancelledSome, scheduled }
}

/** Builds the actual report SVG independently, so calendar geometry and status labels can be tested. */
export function buildMonthlySubjectReportSvg(subject: Subject, overrides: ScheduleOverride[] = [], now = new Date()): string {
  const year = now.getFullYear(), month = now.getMonth()
  const monthName = now.toLocaleDateString(undefined, { month: "long", year: "numeric" })
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const firstMondayIndex = (new Date(year, month, 1).getDay() + 6) % 7
  const monthPrefix = `${year}-${pad2(month + 1)}-`
  // Latest record wins for each (date, class start), matching markFor() in the live app.
  const marksByDate = new Map<string, Map<string, Mark>>()
  for (const entry of subject.log ?? []) {
    const current = marksByDate.get(entry.d) ?? new Map<string, Mark>()
    current.set(entry.t ?? "", entry.s)
    marksByDate.set(entry.d, current)
  }
  const monthOverrides = overrides.filter((o) => o.originalSubjectId === subject.id && o.date.startsWith(monthPrefix))
  const overridesByDate = new Map<string, ScheduleOverride[]>()
  for (const override of monthOverrides) {
    const current = overridesByDate.get(override.date) ?? []
    current.push(override)
    overridesByDate.set(override.date, current)
  }

  const rows = Math.ceil((firstMondayIndex + daysInMonth) / 7)
  const rowGap = rows === 6 ? 65 : 78
  const firstRowY = 673
  const lastRowY = firstRowY + (rows - 1) * rowGap
  const calendarTop = 500
  const legendY = lastRowY + 68
  const calendarBottom = legendY + 48
  const footerY = calendarBottom + 53
  const width = 1000
  const height = footerY + 48

  const dayStates = new Map<string, ReturnType<typeof stateForDate>>()
  let scheduledCount = 0
  for (let day = 1; day <= daysInMonth; day++) {
    const date = dateKey(year, month, day)
    const state = stateForDate(date, new Date(year, month, day).getDay(), subject, marksByDate, overridesByDate)
    dayStates.set(date, state)
    scheduledCount += state.scheduled
  }

  const monthTags = subject.tags?.filter(Boolean) ?? []
  const rawTagText = monthTags.length > 1 ? `${monthTags[0]} +${monthTags.length - 1}` : monthTags[0] ?? "Untagged subject"
  const tagText = rawTagText.length > 30 ? `${rawTagText.slice(0, 27)}…` : rawTagText
  const generated = now.toLocaleString(undefined, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })
  const bannerShapes = kaleidoscope(`${subject.id}:${year}-${month + 1}:${now.getTime()}`)
  const safeName = esc(subject.name)
  const subjectFontSize = Math.max(31, Math.min(52, 620 / Math.max(1, subject.name.length)))
  const total = Math.max(0, subject.attended) + Math.max(0, subject.missed)
  const pct = total ? Math.round(Math.max(0, subject.attended) / total * 100) : 0

  const calendarParts: string[] = []
  const weekdays = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"]
  const firstX = 95, colGap = 135, radius = 29
  weekdays.forEach((day, i) => calendarParts.push(`<text x="${firstX + i * colGap}" y="625" text-anchor="middle" font-size="15" font-weight="700" fill="#73737a">${day}</text>`))
  for (let day = 1; day <= daysInMonth; day++) {
    const date = dateKey(year, month, day)
    const { state, replaced, cancelledSome } = dayStates.get(date)!
    const cell = (firstMondayIndex + day - 1)
    const x = firstX + (cell % 7) * colGap
    const y = firstRowY + Math.floor(cell / 7) * rowGap
    const fill = state === "present" ? "#35b76e" : state === "absent" ? "#ed555b" : state === "unmarked" || state === "cancelled" ? "#dedee1" : "#f5f2ec"
    const stroke = replaced ? "#7966c2" : cancelledSome ? "#9c9ca2" : "none"
    const strokeWidth = replaced || cancelledSome ? 3 : 0
    const dash = cancelledSome ? 'stroke-dasharray="5 4"' : ""
    const textFill = state === "present" || state === "absent" ? "#ffffff" : "#202024"
    const description = state === "cancelled" ? "Cancelled lecture" : replaced && cancelledSome ? "Replaced and cancelled lecture(s)" : replaced ? "Replaced lecture" : cancelledSome ? "Includes cancelled lecture" : state === "present" ? "Present" : state === "absent" ? "Absent" : state === "unmarked" ? "Scheduled, not fully marked" : "No scheduled class"
    calendarParts.push(`<circle cx="${x}" cy="${y}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" ${dash}/><text x="${x}" y="${y + 7}" text-anchor="middle" font-size="21" font-weight="${state === "present" || state === "absent" ? 700 : 500}" fill="${textFill}"><title>${esc(`${date} · ${description}`)}</title>${day}</text>`)
  }

  const legendItems = [
    { x: 75, fill: "#35b76e", stroke: "none", label: "Present" },
    { x: 247, fill: "#ed555b", stroke: "none", label: "Absent" },
    { x: 408, fill: "#dedee1", stroke: "none", label: "Not marked" },
    { x: 610, fill: "#dedee1", stroke: "#9c9ca2", dash: 'stroke-dasharray="4 3"', label: "Cancelled" },
    { x: 800, fill: "#f5f2ec", stroke: "#7966c2", label: "Replaced" },
  ]
  const legend = legendItems.map((item) => `<circle cx="${item.x}" cy="${legendY}" r="8" fill="${item.fill}" stroke="${item.stroke}" stroke-width="${item.stroke === "none" ? 0 : 2.5}" ${item.dash ?? ""}/><text x="${item.x + 14}" y="${legendY + 5}" font-size="13" fill="#606068">${item.label}</text>`).join("")

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" font-family="${FONT}"><defs>
    <linearGradient id="page-bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#fbf7f0"/><stop offset="1" stop-color="#f0edf6"/></linearGradient>
    <linearGradient id="banner-bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#f8f0e5"/><stop offset="1" stop-color="#e5e5dd"/></linearGradient>
    <pattern id="banner-grid" width="28" height="28" patternUnits="userSpaceOnUse"><path d="M28 0H0V28" fill="none" stroke="#82998d" stroke-opacity=".08" stroke-width="1"/></pattern>
    <clipPath id="banner-clip"><rect x="30" y="25" width="940" height="270" rx="28"/></clipPath>
  </defs>
  <rect width="100%" height="100%" fill="#f2f1f7"/>
  <g clip-path="url(#banner-clip)"><rect x="30" y="25" width="940" height="270" fill="url(#banner-bg)"/><rect x="30" y="25" width="940" height="270" fill="url(#banner-grid)"/><g transform="translate(30 25)">${bannerShapes}</g><rect x="30" y="25" width="940" height="270" fill="url(#banner-bg)" fill-opacity=".14"/></g>
  <rect x="65" y="54" width="${Math.max(180, Math.min(390, tagText.length * 10 + 38))}" height="34" rx="17" fill="#dcebe0"/>
  <text x="${65 + Math.max(180, Math.min(390, tagText.length * 10 + 38)) / 2}" y="76" text-anchor="middle" font-size="14" font-weight="750" fill="#263b31">${esc(tagText.toLocaleUpperCase())}</text>
  <text x="65" y="140" font-size="${subjectFontSize.toFixed(1)}" font-weight="750" letter-spacing="-1.1" fill="#171719">${safeName}</text>
  <text x="65" y="187" font-size="32" font-weight="450" fill="#606066">Monthly Report</text>
  <rect x="65" y="215" width="258" height="48" rx="24" fill="#ffffff" fill-opacity=".86"/>
  <text x="194" y="245" text-anchor="middle" font-size="18" font-weight="650" fill="#202024">${esc(monthName)}</text>

  <rect x="30" y="310" width="940" height="170" rx="24" fill="#fff" stroke="#e6e3e9"/>
  <line x1="265" y1="338" x2="265" y2="453" stroke="#e9e5e3"/><line x1="500" y1="338" x2="500" y2="453" stroke="#e9e5e3"/><line x1="735" y1="338" x2="735" y2="453" stroke="#e9e5e3"/>
  <text x="147" y="382" text-anchor="middle" font-size="43" font-weight="750" fill="#171719">${pct}%</text><text x="147" y="410" text-anchor="middle" font-size="15" fill="#686870">Current attendance</text><text x="147" y="434" text-anchor="middle" font-size="14" fill="#686870">${Math.max(0, subject.attended)}/${total} marked</text>
  <text x="382" y="382" text-anchor="middle" font-size="39" font-weight="750" fill="#171719">${Math.max(0, subject.requirement)}%</text><text x="382" y="416" text-anchor="middle" font-size="16" fill="#686870">Required</text>
  <text x="617" y="382" text-anchor="middle" font-size="39" font-weight="750" fill="#171719">${scheduledCount}</text><text x="617" y="416" text-anchor="middle" font-size="15" fill="#686870">Scheduled this month</text>
  <text x="852" y="382" text-anchor="middle" font-size="39" font-weight="750" fill="#171719">${Math.max(0, subject.attended)}</text><text x="852" y="416" text-anchor="middle" font-size="15" fill="#686870">Attended overall</text>

  <rect x="30" y="${calendarTop}" width="940" height="${calendarBottom - calendarTop}" rx="24" fill="#fff" stroke="#e6e3e9"/>
  <text x="65" y="555" font-size="26" font-weight="750" letter-spacing="-.45" fill="#171719">${esc(monthName)}</text>
  ${calendarParts.join("")}
  ${legend}
  <text x="65" y="${footerY}" font-size="14" fill="#66666d">Generated on ${esc(generated)}</text>
  <text x="935" y="${footerY}" text-anchor="end" font-size="14" font-weight="700" fill="#222226">Attendance Tracker · ${safeName} · ${esc(monthName)}</text>
  </svg>`
}

// The Web Share API is a singleton UI on most browsers. A second invocation while a
// share sheet is open rejects with InvalidStateError, so guard the whole render/share flow.
let monthlyReportActionInFlight = false

function isNamedError(error: unknown, name: string): boolean {
  return !!error && typeof error === "object" && "name" in error && (error as { name?: unknown }).name === name
}

function savePngFallback(blob: Blob, fileName: string) {
  const pngUrl = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = pngUrl
  anchor.download = fileName
  anchor.style.display = "none"
  document.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  window.setTimeout(() => URL.revokeObjectURL(pngUrl), 3000)
}

export type MonthlyReportActionResult = "shared" | "downloaded" | "cancelled" | "busy"

export async function downloadMonthlySubjectReport(
  subject: Subject,
  overrides: ScheduleOverride[] = [],
  now = new Date(),
): Promise<MonthlyReportActionResult> {
  // Ignore rapid double taps from the same or another SubjectDetail instance.
  if (monthlyReportActionInFlight) return "busy"
  monthlyReportActionInFlight = true

  let svgUrl: string | null = null
  try {
    const year = now.getFullYear(), month = now.getMonth()
    const monthName = now.toLocaleDateString(undefined, { month: "long", year: "numeric" })
    const svg = buildMonthlySubjectReportSvg(subject, overrides, now)
    const width = 1000
    svgUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml;charset=utf-8" }))
    const image = new Image()
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve()
      image.onerror = () => reject(new Error("Could not render monthly report image"))
      image.src = svgUrl!
    })
    const viewBoxMatch = svg.match(/viewBox="0 0 (\d+) (\d+)"/)
    const height = Number(viewBoxMatch?.[2] ?? 1240)
    const canvas = document.createElement("canvas")
    canvas.width = width * 2
    canvas.height = height * 2
    const context = canvas.getContext("2d")
    if (!context) throw new Error("Canvas is unavailable in this browser")
    context.scale(2, 2)
    context.drawImage(image, 0, 0, width, height)
    const pngBlob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("PNG export failed")), "image/png"))
    const safeName = subject.name.replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") || "subject"
    const fileName = `${safeName}-${year}-${pad2(month + 1)}-monthly-report.png`
    // Some older browser contexts can render the PNG but do not expose the File constructor.
    // Keep those browsers on the normal PNG download path instead of failing before the fallback.
    const file = typeof File === "undefined" ? null : new File([pngBlob], fileName, { type: "image/png" })

    let canShareFile = !!file && typeof navigator.share === "function"
    if (canShareFile && file && navigator.canShare) {
      try {
        canShareFile = navigator.canShare({ files: [file] }) === true
      } catch {
        // Some browsers expose canShare but throw for file types they cannot share.
        canShareFile = false
      }
    }
    if (!canShareFile) {
      savePngFallback(pngBlob, fileName)
      return "downloaded"
    }

    try {
      // `file` is non-null whenever canShareFile is true.
      await navigator.share({ files: [file!], title: `${subject.name} monthly report`, text: `${subject.name} · ${monthName}` })
      return "shared"
    } catch (shareError) {
      // Canceling the system share sheet is an expected user action. Never turn it into
      // an unsolicited file download or a noisy console error.
      if (isNamedError(shareError, "AbortError")) return "cancelled"

      // This includes InvalidStateError (another share UI has not completed) and
      // NotAllowedError (some browsers lose user activation during image rendering).
      // The PNG is still useful, so save it instead of surfacing an unhandled rejection.
      savePngFallback(pngBlob, fileName)
      return "downloaded"
    }
  } catch (error) {
    // Rendering failures are genuine failures; the caller shows an accessible message.
    console.error("Could not create monthly report image", error)
    throw error instanceof Error ? error : new Error("Could not create monthly report image")
  } finally {
    if (svgUrl) URL.revokeObjectURL(svgUrl)
    monthlyReportActionInFlight = false
  }
}
