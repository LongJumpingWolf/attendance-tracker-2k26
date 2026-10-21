import { describe, expect, it } from "vitest"
import { buildMonthlySubjectReportSvg } from "@/lib/monthly-report"
import type { ScheduleOverride, Subject } from "@/lib/types"

const makeSubject = (slots: Subject["slots"] = [{ day: 4, start: "09:00", end: "10:00" }]): Subject => ({
  id: "physiology",
  name: "Physiology",
  attended: 15,
  missed: 5,
  requirement: 75,
  glowColor: "#35b76e",
  tags: ["Pre-clinical"],
  slots,
  log: [
    { d: "2026-10-01", s: "P", t: "09:00" },
    { d: "2026-10-08", s: "A", t: "09:00" },
  ],
})

describe("monthly subject report SVG", () => {
  it("uses the app's sans-serif style and report summary labels", () => {
    const svg = buildMonthlySubjectReportSvg(makeSubject(), [], new Date(2026, 9, 21, 17, 35))
    expect(svg).toContain("system-ui")
    expect(svg).not.toContain('font-family="Times New Roman')
    expect(svg).not.toMatch(/,\s*serif"/i)
    expect(svg).toContain("Monthly Report")
    expect(svg).toContain("PRE-CLINICAL")
    expect(svg).toContain("Current attendance")
    expect(svg).toContain("Scheduled this month")
  })

  it("keeps calendar circles, legend and footer inside the calculated SVG height for a six-row month", () => {
    const svg = buildMonthlySubjectReportSvg(makeSubject([{ day: 6, start: "09:00", end: "10:00" }]), [], new Date(2026, 7, 21, 17, 35))
    const height = Number(svg.match(/viewBox="0 0 1000 (\d+)"/)?.[1])
    const circleYs = [...svg.matchAll(/<circle cx="\d+" cy="(\d+)" r="29"/g)].map((m) => Number(m[1]))
    expect(height).toBeGreaterThan(1100)
    expect(Math.max(...circleYs) + 29).toBeLessThan(height)
    const legendY = Number(svg.match(/<circle cx="75" cy="(\d+)" r="8"/)?.[1])
    expect(legendY + 5).toBeLessThan(height)
    expect(svg).toContain("Generated on")
    expect(svg).toContain("Attendance Tracker · Physiology · August 2026")
  })

  it("uses solid green/red fills, neutral unmarked days, dashed cancellations and purple replacement outlines", () => {
    const subject = makeSubject()
    const overrides: ScheduleOverride[] = [
      { id: "cancel", date: "2026-10-29", originalSubjectId: subject.id, start: "09:00", kind: "cancelled" },
      { id: "replace", date: "2026-10-22", originalSubjectId: subject.id, start: "09:00", kind: "substitute", substituteSubjectId: "anatomy" },
    ]
    const svg = buildMonthlySubjectReportSvg(subject, overrides, new Date(2026, 9, 21, 17, 35))
    expect(svg).toContain('fill="#35b76e"')
    expect(svg).toContain('fill="#ed555b"')
    expect(svg).toContain('stroke-dasharray="5 4"')
    expect(svg).toContain('stroke="#7966c2"')
    expect(svg).toContain("Cancelled")
    expect(svg).toContain("Replaced")
  })


  it("does not count sleeping dates as scheduled and uses the latest mark per class time", () => {
    const subject = {
      ...makeSubject([
        { day: 4, start: "09:00", end: "10:00" },
        { day: 4, start: "10:00", end: "11:00" },
      ]),
      sleeping: true,
      sleepFrom: "2026-10-01",
      sleepUntil: "2026-10-31",
      log: [
        { d: "2026-10-01", s: "P" as const, t: "09:00" },
        { d: "2026-10-01", s: "A" as const, t: "10:00" },
        { d: "2026-10-08", s: "P" as const, t: "09:00" },
      ],
    }
    const svg = buildMonthlySubjectReportSvg(subject, [], new Date(2026, 9, 21, 17, 35))
    expect(svg).toContain("Scheduled this month")
    // A subject asleep for all October dates contributes no scheduled classes, despite old marks in the log.
    expect(svg).toContain('<text x="617" y="382" text-anchor="middle" font-size="39" font-weight="750" fill="#171719">0</text>')
    // In the report SVG the date number includes a title describing sleeping dates as no scheduled class.
    expect(svg).toContain("2026-10-01 · No scheduled class")
  })


  it("excludes subject sleep dates from the month's scheduled count despite historical log entries", () => {
    const subject = {
      ...makeSubject(),
      sleeping: true,
      sleepFrom: "2026-10-01",
      sleepUntil: "2026-10-31",
      log: [
        { d: "2026-10-01", s: "P" as const, t: "09:00" },
        { d: "2026-10-08", s: "A" as const, t: "09:00" },
      ],
    }
    const svg = buildMonthlySubjectReportSvg(subject, [], new Date(2026, 9, 21, 17, 35))
    expect(svg).toContain('<text x="617" y="382" text-anchor="middle" font-size="39" font-weight="750" fill="#171719">0</text>')
    expect(svg).toContain("2026-10-01 · No scheduled class")
  })

  it("summarizes different class marks on the same date as neutral instead of counting every date mark as a single status", () => {
    const subject = {
      ...makeSubject([
        { day: 4, start: "09:00", end: "10:00" },
        { day: 4, start: "10:00", end: "11:00" },
      ]),
      log: [
        { d: "2026-10-01", s: "P" as const, t: "09:00" },
        { d: "2026-10-01", s: "A" as const, t: "10:00" },
      ],
    }
    const svg = buildMonthlySubjectReportSvg(subject, [], new Date(2026, 9, 21, 17, 35))
    expect(svg).toContain("2026-10-01 · Scheduled, not fully marked")
  })

  it("escapes untrusted subject names and tags before embedding them in SVG", () => {
    const subject = { ...makeSubject(), name: '<script>alert("x")</script>', tags: ["<b>custom</b>"] }
    const svg = buildMonthlySubjectReportSvg(subject, [], new Date(2026, 9, 21))
    expect(svg).not.toContain("<script>")
    expect(svg).toContain("&lt;script&gt;")
    expect(svg).toContain("&lt;B&gt;CUSTOM&lt;/B&gt;")
  })
})
