/**
 * Export-directory input/output (Phase 6C). An export directory holds:
 *   manifest.json            what was exported (counts, per-collection digests, source identity, timestamps)
 *   <collection>.ndjson      one JSON record per line, sorted by id
 * Everything in it is real user data: it lives in the git-ignored migration-output/ folder and must never be committed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, createWriteStream } from "node:fs"
import { join } from "node:path"
import { COLLECTIONS, digestOf } from "./export.mjs"

export function createExportWriter(dir) {
  mkdirSync(dir, { recursive: true })
  const streams = Object.fromEntries(COLLECTIONS.map((c) => [c, createWriteStream(join(dir, `${c}.ndjson`), { encoding: "utf8" })]))
  return {
    writeLine: (collection, line) => void streams[collection].write(line + "\n"),
    async finish(manifest) {
      await Promise.all(Object.values(streams).map((s) => new Promise((res) => s.end(res))))
      writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n")
    },
  }
}

/** Reads an export directory and re-checks it against its manifest (counts and per-collection digests) */
export function loadExport(dir) {
  const mf = join(dir, "manifest.json")
  if (!existsSync(mf)) throw new Error("not an export directory: manifest.json is missing")
  const manifest = JSON.parse(readFileSync(mf, "utf8"))
  const records = {}
  const integrity = []
  for (const c of COLLECTIONS) {
    const f = join(dir, `${c}.ndjson`)
    if (!existsSync(f)) {
      integrity.push(`export: ${c}.ndjson is missing`)
      records[c] = []
      continue
    }
    const lines = readFileSync(f, "utf8").split("\n").filter((l) => l.length > 0)
    records[c] = lines.map((l) => JSON.parse(l))
    const meta = manifest.collections?.[c]
    if (!meta) integrity.push(`export: the manifest has no entry for ${c}`)
    else {
      if (meta.count !== lines.length) integrity.push(`export: ${c} has ${lines.length} lines but the manifest says ${meta.count}`)
      if (meta.digest !== digestOf(lines)) integrity.push(`export: ${c} does not match its manifest digest (the file was changed after the export)`)
    }
  }
  return { manifest, records, integrity }
}

export function writeJson(dir, name, value) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), JSON.stringify(value, null, 2) + "\n")
}
export function writeText(dir, name, text) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), text)
}
export function writeNdjson(dir, name, rows) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, name), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""))
}
