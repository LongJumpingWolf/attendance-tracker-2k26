import type { WrappedData } from "./wrapped"

/**
 * Draws the week's wrapped as a 1080x1920 story-sized PNG. Plain canvas, so it needs no library and works offline.
 * Only the parts the week actually has data for are drawn, like in the story itself.
 */
const W = 1080
const H = 1920
const FONT = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif'

type Block = { label: string; value: string; sub?: string; big?: boolean }

function blocksFor(d: WrappedData): Block[] {
  const out: Block[] = []
  if (d.attended > 0) out.push({ label: "You showed up", value: String(d.attended), sub: d.pct !== null ? `times, ${d.pct}% of the classes you marked` : "times", big: true })
  if (d.attended > 0 && d.missed === 0) out.push({ label: "Zero absences", value: "Perfect week.", sub: "Not a single class missed" })
  else if (d.missed > 0) out.push({ label: "You skipped", value: String(d.missed), sub: d.missed === 1 ? "class" : "classes", big: true })
  if (d.best) out.push({ label: "Your best subject", value: d.best.name, sub: `${d.best.pct}% across ${d.best.classes} classes` })
  if (d.streak >= 2) out.push({ label: "Longest streak", value: String(d.streak), sub: "classes in a row without a miss", big: true })
  if (d.coverHero) out.push({ label: "Proxy-mate of the week", value: d.coverHero.name, sub: `covered you ${d.coverHero.count} ${d.coverHero.count === 1 ? "time" : "times"}` })
  return out.slice(0, 4)
}

/** Breaks text into lines no wider than maxWidth (at most maxLines, ending in an ellipsis if cut) */
function wrap(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, maxLines: number): string[] {
  const words = text.split(/\s+/)
  const lines: string[] = []
  let line = ""
  for (const w of words) {
    const test = line ? `${line} ${w}` : w
    if (ctx.measureText(test).width <= maxWidth || !line) line = test
    else {
      lines.push(line)
      line = w
    }
  }
  if (line) lines.push(line)
  if (lines.length > maxLines) {
    const kept = lines.slice(0, maxLines)
    kept[maxLines - 1] = kept[maxLines - 1].replace(/\s*\S*$/, "") + "…"
    return kept
  }
  return lines
}

export async function renderWrappedImage(d: WrappedData): Promise<Blob> {
  const canvas = document.createElement("canvas")
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext("2d")
  if (!ctx) throw new Error("Canvas isn't available")

  // Background: the same deep indigo to magenta as the story, with two soft glows
  const bg = ctx.createLinearGradient(0, 0, W * 0.4, H)
  bg.addColorStop(0, "#3730a3")
  bg.addColorStop(0.6, "#86198f")
  bg.addColorStop(1, "#9f1239")
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)
  for (const [x, y, r, a] of [
    [120, 200, 520, 0.14],
    [980, 1650, 620, 0.16],
  ] as const) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r)
    g.addColorStop(0, `rgba(255,255,255,${a})`)
    g.addColorStop(1, "rgba(255,255,255,0)")
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
  }

  ctx.textBaseline = "alphabetic"
  ctx.fillStyle = "#ffffff"
  const left = 96

  // Header
  ctx.globalAlpha = 0.85
  ctx.font = `600 44px ${FONT}`
  ctx.fillText(`${d.isCurrent ? "This week so far" : "Last week"} · ${d.rangeLabel}`, left, 200)
  ctx.globalAlpha = 1
  ctx.font = `900 190px ${FONT}`
  ctx.fillText("wrapped.", left - 6, 390)

  // Stats
  const blocks = blocksFor(d)
  let y = 560
  if (blocks.length === 0) {
    ctx.font = `600 56px ${FONT}`
    ctx.globalAlpha = 0.9
    ctx.fillText("A quiet week. Nothing was marked.", left, y + 60)
    ctx.globalAlpha = 1
  }
  for (const b of blocks) {
    ctx.globalAlpha = 0.85
    ctx.font = `600 44px ${FONT}`
    ctx.fillText(b.label, left, y)
    ctx.globalAlpha = 1
    if (b.big) {
      ctx.font = `900 210px ${FONT}`
      ctx.fillText(b.value, left - 8, y + 200)
      y += 200
    } else {
      ctx.font = `900 96px ${FONT}`
      const lines = wrap(ctx, b.value, W - left * 2, 2)
      lines.forEach((ln, i) => ctx.fillText(ln, left, y + 100 + i * 106))
      y += 100 + (lines.length - 1) * 106
    }
    if (b.sub) {
      ctx.globalAlpha = 0.85
      ctx.font = `600 42px ${FONT}`
      const subLines = wrap(ctx, b.sub, W - left * 2, 2)
      subLines.forEach((ln, i) => ctx.fillText(ln, left, y + 62 + i * 54))
      y += 62 + (subLines.length - 1) * 54
      ctx.globalAlpha = 1
    }
    y += 130
  }

  // Footer
  ctx.globalAlpha = 0.7
  ctx.font = `700 40px ${FONT}`
  ctx.fillText("College Tracker", left, H - 110)
  ctx.globalAlpha = 1

  return new Promise((resolve, reject) => canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't make the image"))), "image/png"))
}

/** Opens the phone's share sheet with the image, or saves it as a file where sharing files isn't supported */
export async function shareImage(blob: Blob, filename: string): Promise<"shared" | "saved" | "cancelled"> {
  const file = new File([blob], filename, { type: "image/png" })
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "My week, wrapped" })
      return "shared"
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError") return "cancelled"
      /* fall through to a plain download */
    }
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
  return "saved"
}
