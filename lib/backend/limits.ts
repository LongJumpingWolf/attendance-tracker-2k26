/**
 * The size of the stored sync document, measured the way Firestore counts it. Used to refuse an oversize write before
 * anything is sent. Pure arithmetic: no backend is involved, so it lives apart from the adapters.
 */

/** Firestore refuses documents over 1 MiB (1,048,576 bytes). Stay well under it, and under the 900,000-character cap in firestore.rules. */
export const DOC_LIMIT_BYTES = 800_000

/**
 * The size Firestore counts for the stored document: its name (each path part plus 1, plus 16), every field name (+1)
 * with its value (a string is its UTF-8 bytes + 1, a number is 8), and 32 for the document itself.
 */
export function firestoreDocBytes(owner: string, data: string): number {
  const utf8 = (s: string) => new TextEncoder().encode(s).length
  const name = utf8("syncs") + 1 + utf8(owner) + 1 + 16
  const fields = utf8("data") + 1 + utf8(data) + 1 + (utf8("rev") + 1 + 8) + (utf8("updatedAt") + 1 + 8)
  return name + fields + 32
}
