/**
 * Firestore REST "typed value" decoding (pure, no network). The exporter stores documents in their typed REST form,
 * which is lossless; this module turns them into plain JSON for the transformation.
 *
 * Timestamps decode to { $ts: "<ISO string as Firestore sent it>" } so they can never be confused with a string field.
 * Integers decode to numbers (Firestore sends them as strings; a value beyond the safe range is kept as { $int: "..." }).
 */

export const isTs = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && typeof v.$ts === "string" && Object.keys(v).length === 1

export function decodeValue(v) {
  if (v === null || typeof v !== "object") throw new Error("not a Firestore value")
  if ("stringValue" in v) return v.stringValue
  if ("integerValue" in v) {
    const n = Number(v.integerValue)
    return Number.isSafeInteger(n) ? n : { $int: String(v.integerValue) }
  }
  if ("doubleValue" in v) return typeof v.doubleValue === "number" ? v.doubleValue : Number(v.doubleValue)
  if ("booleanValue" in v) return v.booleanValue
  if ("nullValue" in v) return null
  if ("timestampValue" in v) return { $ts: v.timestampValue }
  if ("mapValue" in v) return decodeFields(v.mapValue.fields ?? {})
  if ("arrayValue" in v) return (v.arrayValue.values ?? []).map(decodeValue)
  if ("referenceValue" in v) return { $ref: v.referenceValue }
  if ("bytesValue" in v) return { $bytes: v.bytesValue }
  if ("geoPointValue" in v) return { $geo: v.geoPointValue }
  throw new Error(`unsupported Firestore value type: ${Object.keys(v).join(",")}`)
}

export function decodeFields(fields) {
  const out = {}
  for (const [k, v] of Object.entries(fields ?? {})) out[k] = decodeValue(v)
  return out
}

/** The document id from a full Firestore resource name ".../documents/<collection>/<id>" */
export const docIdFromName = (name) => name.slice(name.lastIndexOf("/") + 1)

/** A timestamp field as an ISO string exactly as Firestore sent it, or null when it is missing or not a timestamp */
export const tsIso = (v) => (isTs(v) ? v.$ts : null)

/** Milliseconds since the epoch for a timestamp, or null */
export const tsMs = (v) => {
  const iso = tsIso(v)
  if (iso === null) return null
  const t = Date.parse(iso)
  return Number.isNaN(t) ? null : t
}
