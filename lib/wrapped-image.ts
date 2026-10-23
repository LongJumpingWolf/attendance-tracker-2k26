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

  // Stats. A week with several big numbers is taller than the image, so the blocks are measured first and the type
  // and spacing are scaled down together until everything fits above the footer.
  const blocks = blocksFor(d)
  const top = 560
  const bottom = H - 230 // the footer sits below this line
  const maxWidth = W - left * 2
  const paint = (scale: number, draw: boolean) => {
    let y = top
    for (const b of blocks) {
      const label = Math.round(44 * scale)
      ctx.font = `600 ${label}px ${FONT}`
      if (draw) {
        ctx.globalAlpha = 0.85
        ctx.fillText(b.label, left, y)
        ctx.globalAlpha = 1
      }
      if (b.big) {
        const size = Math.round(210 * scale)
        ctx.font = `900 ${size}px ${FONT}`
        if (draw) ctx.fillText(b.value, left - 8, y + size * 0.95)
        y += size * 0.95
      } else {
        const size = Math.round(96 * scale)
        const lineH = size * 1.1
        ctx.font = `900 ${size}px ${FONT}`
        const lines = wrap(ctx, b.value, maxWidth, 2)
        if (draw) lines.forEach((ln, i) => ctx.fillText(ln, left, y + size * 1.05 + i * lineH))
        y += size * 1.05 + (lines.length - 1) * lineH
      }
      if (b.sub) {
        const size = Math.round(42 * scale)
        ctx.font = `600 ${size}px ${FONT}`
        const subLines = wrap(ctx, b.sub, maxWidth, 2)
        if (draw) {
          ctx.globalAlpha = 0.85
          subLines.forEach((ln, i) => ctx.fillText(ln, left, y + size * 1.5 + i * size * 1.3))
          ctx.globalAlpha = 1
        }
        y += size * 1.5 + (subLines.length - 1) * size * 1.3
      }
      y += 110 * scale
    }
    return y
  }
  if (blocks.length === 0) {
    ctx.font = `600 56px ${FONT}`
    ctx.globalAlpha = 0.9
    ctx.fillText("A quiet week. Nothing was marked.", left, top + 60)
    ctx.globalAlpha = 1
  } else {
    let scale = 1
    while (scale > 0.5 && paint(scale, false) > bottom) scale = Math.round((scale - 0.04) * 100) / 100
    paint(scale, true)
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
