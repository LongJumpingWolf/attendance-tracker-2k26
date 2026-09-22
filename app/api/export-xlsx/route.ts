import ExcelJS from "exceljs"
import { type NextRequest, NextResponse } from "next/server"

interface ExportRequest {
  subjects: any[]
  tasks: any[]
  notifications: any[]
  tags: string[]
}

export async function POST(request: NextRequest) {
  try {
    const body: ExportRequest = await request.json()

    // Dynamically import jszip
    const JSZip = (await import("jszip")).default
    const zip = new JSZip()

    // Create Attendance/Subjects workbook
    if (body.subjects && body.subjects.length > 0) {
      const attendanceWb = new ExcelJS.Workbook()
      const attendanceSheet = attendanceWb.addWorksheet("Attendance")

      const headers = ["Subject Name", "Attended", "Missed", "Total Classes", "Requirement %", "Status", "Tags"]
      const headerRow = attendanceSheet.addRow(headers)

      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } }
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FF1f2937" },
        }
        cell.alignment = { horizontal: "center", vertical: "middle" }
      })

      body.subjects.forEach((subject) => {
        const total = subject.attended + subject.missed
        const percentage = total > 0 ? Math.round((subject.attended / total) * 100) : 0
        const status = percentage >= subject.requirement ? "✓ Above requirement" : "✗ Below requirement"

        const row = attendanceSheet.addRow([
          subject.name,
          subject.attended,
          subject.missed,
          total,
          `${percentage}%`,
          status,
          subject.tags?.join(", ") || "",
        ])

        // Color status column
        const statusCell = row.getCell(6)
        if (status.includes("Above")) {
          statusCell.font = { color: { argb: "FF22c55e" }, bold: true }
        } else {
          statusCell.font = { color: { argb: "FFef4444" }, bold: true }
        }
      })

      // Auto-fit columns
      headers.forEach((_, index) => {
        attendanceSheet.getColumn(index + 1).width = 18
      })

      const attendanceBuffer = await attendanceWb.xlsx.writeBuffer()
      zip.file("01-Attendance-Tracker.xlsx", attendanceBuffer)
    }

    // Create Exams & Assignments workbook
    if (body.tasks && body.tasks.length > 0) {
      const tasksWb = new ExcelJS.Workbook()
      const tasksSheet = tasksWb.addWorksheet("Tasks")

      const headers = ["Title", "Type", "Due Date", "Days Remaining", "Reminder Days Before", "Status"]
      const headerRow = tasksSheet.addRow(headers)

      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } }
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FF1f2937" },
        }
        cell.alignment = { horizontal: "center", vertical: "middle" }
      })

      const today = new Date()
      today.setHours(0, 0, 0, 0)

      body.tasks.forEach((task) => {
        const dueDate = new Date(task.dueDate)
        dueDate.setHours(0, 0, 0, 0)
        const daysUntil = Math.ceil((dueDate.getTime() - today.getTime()) / (1000 * 60 * 60 * 24))

        const status = daysUntil < 0 ? "Overdue" : daysUntil === 0 ? "Today" : `${daysUntil} days left`

        const formattedDate = new Date(task.dueDate).toLocaleDateString("en-GB")

        const row = tasksSheet.addRow([
          task.title,
          "Deadline",
          formattedDate,
          daysUntil,
          task.remindDaysBefore || 0,
          status,
        ])

        const statusCell = row.getCell(6)
        if (status === "Overdue") {
          statusCell.font = { color: { argb: "FFef4444" }, bold: true }
        } else if (status === "Today") {
          statusCell.font = { color: { argb: "FFeab308" }, bold: true }
        }
      })

      headers.forEach((_, index) => {
        tasksSheet.getColumn(index + 1).width = 20
      })

      const tasksBuffer = await tasksWb.xlsx.writeBuffer()
      zip.file("02-Exams-Assignments.xlsx", tasksBuffer)
    }

    // Create Notifications workbook
    if (body.notifications && body.notifications.length > 0) {
      const notificationsWb = new ExcelJS.Workbook()
      const notificationsSheet = notificationsWb.addWorksheet("Notifications")

      const headers = ["Type", "Title", "Description", "Timestamp"]
      const headerRow = notificationsSheet.addRow(headers)

      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } }
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FF1f2937" },
        }
        cell.alignment = { horizontal: "center", vertical: "middle" }
      })

      body.notifications.forEach((notif) => {
        const row = notificationsSheet.addRow([
          notif.type.charAt(0).toUpperCase() + notif.type.slice(1),
          notif.title,
          notif.description,
          notif.timestamp,
        ])

        const typeCell = row.getCell(1)
        if (notif.type === "reminder") {
          typeCell.font = { color: { argb: "FF3b82f6" }, bold: true }
        } else if (notif.type === "backup") {
          typeCell.font = { color: { argb: "FFf97316" }, bold: true }
        }
      })

      headers.forEach((_, index) => {
        notificationsSheet.getColumn(index + 1).width = 25
      })

      const notificationsBuffer = await notificationsWb.xlsx.writeBuffer()
      zip.file("05-Notifications.xlsx", notificationsBuffer)
    }

    // Create Tags workbook if there are any tags
    if (body.tags && body.tags.length > 0) {
      const tagsWb = new ExcelJS.Workbook()
      const tagsSheet = tagsWb.addWorksheet("Tags")

      const headers = ["Tag Name"]
      const headerRow = tagsSheet.addRow(headers)

      headerRow.eachCell((cell) => {
        cell.font = { bold: true, color: { argb: "FFFFFFFF" } }
        cell.fill = {
          type: "pattern",
          pattern: "solid",
          fgColor: { argb: "FF1f2937" },
        }
        cell.alignment = { horizontal: "center", vertical: "middle" }
      })

      body.tags.forEach((tag) => {
        tagsSheet.addRow([tag])
      })

      tagsSheet.getColumn(1).width = 30

      const tagsBuffer = await tagsWb.xlsx.writeBuffer()
      zip.file("06-Tags.xlsx", tagsBuffer)
    }

    // Generate the ZIP file
    const zipBlob = await zip.generateAsync({ type: "blob" })
    const zipBuffer = await zipBlob.arrayBuffer()

    const timestamp = new Date().toISOString().split("T")[0]

    return new Response(zipBuffer, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename=college-tracker-backup-${timestamp}.zip`,
      },
    })
  } catch (error) {
    console.error("[v0] Export error:", error)
    return NextResponse.json(
      { error: `Failed to export data: ${error instanceof Error ? error.message : String(error)}` },
      { status: 500 },
    )
  }
}
