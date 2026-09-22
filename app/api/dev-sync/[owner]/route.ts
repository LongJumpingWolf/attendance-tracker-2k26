import { type NextRequest } from "next/server"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * Development stand-in for the cloud store, so sync can be tried across a laptop and a phone on the same Wi-Fi
 * before Firebase is set up. It keeps everything in one file on this computer and is switched off in production,
 * where the real Firestore store is used instead.
 */
const FILE = path.join(os.tmpdir(), "college-tracker-dev-sync.json")
type Doc = { data: string; rev: number; updatedAt: number }

const off = () => process.env.NODE_ENV === "production"
const valid = (code: string) => /^[a-z0-9_]{3,80}$/.test(code) // the signed-in account id

async function readAll(): Promise<Record<string, Doc>> {
  try {
    return JSON.parse(await fs.readFile(FILE, "utf8"))
  } catch {
    return {}
  }
}

export async function GET(_req: NextRequest, ctx: { params: Promise<{ owner: string }> }) {
  const { owner: code } = await ctx.params
  if (off() || !valid(code)) return Response.json({ error: "not available" }, { status: 404 })
  const doc = (await readAll())[code]
  return doc ? Response.json(doc) : Response.json({ error: "not found" }, { status: 404 })
}

export async function PUT(req: NextRequest, ctx: { params: Promise<{ owner: string }> }) {
  const { owner: code } = await ctx.params
  if (off() || !valid(code)) return Response.json({ error: "not available" }, { status: 404 })
  const body = (await req.json()) as { data?: unknown; expectedRev?: number | null }
  if (typeof body.data !== "string" || body.data.length > 900_000) return Response.json({ error: "bad data" }, { status: 400 })

  const all = await readAll()
  const current = all[code]
  const expected = body.expectedRev ?? null
  // A write only lands if the sender has seen the latest version; otherwise they must pull first
  if ((current?.rev ?? null) !== expected) return Response.json({ error: "conflict", rev: current?.rev ?? null }, { status: 409 })

  const next: Doc = { data: body.data, rev: (current?.rev ?? 0) + 1, updatedAt: Date.now() }
  all[code] = next
  await fs.writeFile(FILE, JSON.stringify(all))
  return Response.json({ rev: next.rev })
}
