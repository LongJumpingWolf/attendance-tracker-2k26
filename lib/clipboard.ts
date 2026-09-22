/**
 * Copies text to the clipboard. Returns whether it worked.
 *
 * The modern clipboard API only exists on secure pages (https or localhost). Open the dev server from a phone
 * over http://192.168.x.x and it is missing entirely, so every "Copy" button silently did nothing. When it isn't
 * available this falls back to the older select-and-copy method, which works on any page.
 */
export async function copyText(text: string): Promise<boolean> {
  if (typeof window !== "undefined" && window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      /* permission refused: try the older way */
    }
  }
  return legacyCopy(text)
}

function legacyCopy(text: string): boolean {
  if (typeof document === "undefined") return false
  const field = document.createElement("textarea")
  field.value = text
  field.setAttribute("readonly", "") // keeps the on-screen keyboard from opening on phones
  field.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none;font-size:16px"
  document.body.appendChild(field)

  // Whatever the person had selected is put back afterwards
  const selection = document.getSelection()
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null

  field.select()
  field.setSelectionRange(0, text.length) // iOS ignores select() alone
  let ok = false
  try {
    ok = document.execCommand("copy")
  } catch {
    ok = false
  }
  document.body.removeChild(field)
  if (previous && selection) {
    selection.removeAllRanges()
    selection.addRange(previous)
  }
  return ok
}
