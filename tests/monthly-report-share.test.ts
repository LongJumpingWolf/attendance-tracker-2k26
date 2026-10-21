import { afterEach, describe, expect, it, vi } from "vitest"
import { downloadMonthlySubjectReport } from "@/lib/monthly-report"
import type { Subject } from "@/lib/types"

const subject: Subject = {
  id: "physiology",
  name: "Physiology",
  attended: 15,
  missed: 5,
  requirement: 75,
  glowColor: "#35b76e",
  tags: ["Pre-clinical"],
  slots: [{ day: 4, start: "09:00", end: "10:00" }],
  log: [{ d: "2026-10-01", s: "P", t: "09:00" }],
}

function setupBrowser(share: ReturnType<typeof vi.fn>, canShare = true) {
  const clickedAnchors: Array<{ href: string; download: string; click: ReturnType<typeof vi.fn> }> = []
  let objectUrl = 0
  vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:monthly-report-${++objectUrl}`)
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

  class MockImage {
    onload: (() => void) | null = null
    onerror: (() => void) | null = null
    set src(_value: string) { queueMicrotask(() => this.onload?.()) }
  }

  const documentMock = {
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
    createElement: (tag: string) => {
      if (tag === "canvas") return {
        width: 0,
        height: 0,
        getContext: () => ({ scale: vi.fn(), drawImage: vi.fn() }),
        toBlob: (callback: (blob: Blob | null) => void) => callback(new Blob(["png"], { type: "image/png" })),
      }
      if (tag === "a") {
        const anchor = { href: "", download: "", style: {} as Record<string, string>, click: vi.fn(), remove: vi.fn() }
        clickedAnchors.push(anchor)
        return anchor
      }
      throw new Error(`Unexpected element: ${tag}`)
    },
  }

  vi.stubGlobal("Image", MockImage)
  vi.stubGlobal("document", documentMock as unknown as Document)
  vi.stubGlobal("window", { setTimeout: vi.fn(() => 1) } as unknown as Window & typeof globalThis)
  vi.stubGlobal("navigator", {
    share,
    canShare: vi.fn(() => canShare),
  } as unknown as Navigator)
  return { clickedAnchors }
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe("monthly report native sharing", () => {
  it("ignores a second action while the first share sheet is still active", async () => {
    let resolveShare!: () => void
    const sharePromise = new Promise<void>((resolve) => { resolveShare = resolve })
    const share = vi.fn(() => sharePromise)
    const { clickedAnchors } = setupBrowser(share)

    const first = downloadMonthlySubjectReport(subject, [], new Date(2026, 9, 21, 17, 35))
    const second = await downloadMonthlySubjectReport(subject, [], new Date(2026, 9, 21, 17, 35))
    expect(second).toBe("busy")
    await vi.waitFor(() => expect(share).toHaveBeenCalledTimes(1))
    resolveShare()
    expect(await first).toBe("shared")
    expect(clickedAnchors).toHaveLength(0)
  })

  it("falls back to a PNG download when the browser reports InvalidStateError", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("An earlier share has not yet completed", "InvalidStateError"))
    const { clickedAnchors } = setupBrowser(share)
    const result = await downloadMonthlySubjectReport(subject, [], new Date(2026, 9, 21, 17, 35))
    expect(result).toBe("downloaded")
    expect(clickedAnchors).toHaveLength(1)
    expect(clickedAnchors[0].download).toBe("Physiology-2026-10-monthly-report.png")
    expect(clickedAnchors[0].click).toHaveBeenCalledTimes(1)
  })

  it("does not unexpectedly download a file when the user cancels the share sheet", async () => {
    const share = vi.fn().mockRejectedValue(new DOMException("Share dismissed", "AbortError"))
    const { clickedAnchors } = setupBrowser(share)
    const result = await downloadMonthlySubjectReport(subject, [], new Date(2026, 9, 21, 17, 35))
    expect(result).toBe("cancelled")
    expect(clickedAnchors).toHaveLength(0)
  })

  it("downloads directly when file sharing is not supported", async () => {
    const share = vi.fn()
    const { clickedAnchors } = setupBrowser(share, false)
    const result = await downloadMonthlySubjectReport(subject, [], new Date(2026, 9, 21, 17, 35))
    expect(result).toBe("downloaded")
    expect(share).not.toHaveBeenCalled()
    expect(clickedAnchors).toHaveLength(1)
  })

  it("downloads the PNG if this browser context has no File constructor", async () => {
    const share = vi.fn()
    const { clickedAnchors } = setupBrowser(share, true)
    vi.stubGlobal("File", undefined)
    const result = await downloadMonthlySubjectReport(subject, [], new Date(2026, 9, 21, 17, 35))
    expect(result).toBe("downloaded")
    expect(share).not.toHaveBeenCalled()
    expect(clickedAnchors).toHaveLength(1)
  })
})
