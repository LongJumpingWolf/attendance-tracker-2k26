import { describe, expect, it } from "vitest"
import type { Task } from "@/lib/types"
import { dateAfterDays, deadlineRemindersForDate } from "@/lib/deadline-reminders"

const task = (overrides: Partial<Task> = {}): Task => ({
  id: "deadline-1",
  title: "Submit assignment",
  dueDate: "2026-10-30",
  remindDaysBefore: 3,
  ...overrides,
})

describe("deadline reminders for the Today carousel", () => {
  it("starts on the configured number of days before the deadline", () => {
    expect(deadlineRemindersForDate([task()], "2026-10-27").map((x) => x.daysUntilDue)).toEqual([3])
    expect(deadlineRemindersForDate([task({ remindDaysBefore: 2 })], "2026-10-27")).toEqual([])
  })

  it("defaults to one day before and includes the due date", () => {
    expect(deadlineRemindersForDate([task({ remindDaysBefore: undefined })], "2026-10-29")).toHaveLength(1)
    expect(deadlineRemindersForDate([task({ remindDaysBefore: 0 })], "2026-10-30")).toHaveLength(1)
    expect(deadlineRemindersForDate([task({ remindDaysBefore: 0 })], "2026-10-29")).toEqual([])
  })

  it("keeps an unresolved enabled reminder visible after the due date", () => {
    expect(deadlineRemindersForDate([task({ dueDate: "2026-10-25", remindDaysBefore: 0 })], "2026-10-27")[0]?.daysUntilDue).toBe(-2)
  })

  it("excludes completed, disabled, and currently snoozed reminders", () => {
    const tasks = [
      task({ id: "done", done: true }),
      task({ id: "off", remindDaysBefore: -1 }),
      task({ id: "snoozed", remindAgainOn: "2026-10-28" }),
      task({ id: "visible", remindAgainOn: "2026-10-27" }),
    ]
    expect(deadlineRemindersForDate(tasks, "2026-10-27").map((x) => x.task.id)).toEqual(["visible"])
  })

  it("orders the most urgent deadlines first", () => {
    const tasks = [
      task({ id: "later", title: "Later", dueDate: "2026-11-01" }),
      task({ id: "today", title: "Today", dueDate: "2026-10-27" }),
    ]
    expect(deadlineRemindersForDate(tasks, "2026-10-27").map((x) => x.task.id)).toEqual(["today", "later"])
  })

  it("adds calendar days without relying on the system timezone", () => {
    expect(dateAfterDays("2026-10-31", 1)).toBe("2026-11-01")
    expect(dateAfterDays("invalid", 1)).toBeNull()
  })
})
