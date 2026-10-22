import { afterEach, describe, expect, it, vi } from "vitest"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { getAttendance, localDate, markFor, markWithUndo, skipVerdict, withSet } from "@/lib/attendance"
import { cloudPut } from "@/lib/cloud-sync"
import { dbDel, dbGet, dbSet } from "@/lib/db"
import { mergeData } from "@/lib/merge"
import { applyPingResult } from "@/lib/ping-apply"
import { processAnswered } from "@/lib/ping-processing"
import { LEASE_MS } from "@/lib/ping-server"
import { MAX_PING_ITEMS, PING_EXPIRES_DAYS, PING_HISTORY_DAYS } from "@/lib/pings"
import { deleteRestorePoint, listRestorePoints, saveRestorePoint } from "@/lib/restore-points"
import type { FullBackupData } from "@/lib/backup"
import type { Mate, Ping, Subject } from "@/lib/types"

/**
 * MIGRATION INVARIANTS.
 *
 * The backend migration (Firebase -> Supabase, see MIGRATION_PLAN.md) must not change what the app does. These tests pin
 * the things that must stay true through every phase. Protected-file hashes were reviewed and rebased on main at 37a5199
 * after approved post-migration changes; behavior assertions below remain the regression checks.
 *
 * Do not "update the expected value to make it green". The only legitimate edit is the deliberate, reviewed one described
 * on the protected-files guard below.
 */
const ROOT = path.resolve(import.meta.dirname, "..")

/** A tiny stand-in for browser storage. Node has no IndexedDB, so lib/db.ts uses its localStorage fallback here. (The real IndexedDB path is exercised by the browser e2e suites.) */
function stubStorage() {
  const m = new Map<string, string>()
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  })
  return m
}
afterEach(() => vi.unstubAllGlobals())

const subject = (over: Partial<Subject> = {}): Subject => ({
  id: "dbms", name: "DBMS", attended: 0, missed: 0, requirement: 75, glowColor: "#000", tags: [], ...over,
})
const backup = (subjects: Subject[], extra: Partial<FullBackupData> = {}): FullBackupData => ({ subjects, tasks: [], tags: [], mates: [], reminders: [], ...extra })

// ---------------------------------------------------------------------------------------------------------------------
describe("the files the migration must not change are unchanged", () => {
  /**
   * tests/migration-protected.json holds a SHA-256 of each protected file (line endings normalised, so Windows and Linux
   * checkouts agree). A migration phase that has a real reason to change one of these files must:
   *   1. say so in the commit message and explain why behaviour is unchanged, then
   *   2. regenerate the file with:   UPDATE_PROTECTED=1 npx vitest run tests/migration-invariants.test.ts
   * and have the diff of that JSON reviewed. Nothing else should ever touch it.
   */
  const FILE = path.join(ROOT, "tests", "migration-protected.json")
  const PROTECTED = [
    // attendance semantics
    "lib/attendance.ts", "lib/scan.ts",
    // offline-first storage, merge, backup, restore points
    "lib/db.ts", "lib/merge.ts", "lib/backup.ts", "lib/backup-import.ts", "lib/restore-points.ts",
    // Ping rules of the game: processing order, what an answer does, ids, constants
    "lib/ping-processing.ts", "lib/ping-apply.ts", "lib/ping-id.ts", "lib/pings.ts",
    // identity: friends are keyed by uid; auth behaviour
    "lib/identity.ts", "lib/social-session.ts", "lib/account.ts", "lib/realtime.ts",
    // the Firebase adapter: the only file that calls Firestore. Phase 6A adds the shadow infrastructure beside it and must not change it.
    "lib/backend/firebase/index.ts",
    // the sync orchestration (offline, retry, merge-before-push)
    "hooks/use-cloud-sync.ts",
    // the production security boundary and the (not yet deployed) functions
    "firestore.rules", "firestore.indexes.json", "functions/index.js", "functions/pings.js", "functions/ping-handlers.js", "functions/ping-messages.js",
    // the service worker: offline shell and the push contract
    "public/sw.js",
  ]
  const hash = (rel: string) => crypto.createHash("sha256").update(fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n")).digest("hex")

  if (process.env.UPDATE_PROTECTED === "1") {
    it("(regenerating tests/migration-protected.json)", () => {
      fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(PROTECTED.map((f) => [f, hash(f)])), null, 2) + "\n")
    })
  } else {
    const expected = JSON.parse(fs.readFileSync(FILE, "utf8")) as Record<string, string>
    it("the protected list and the recorded hashes name the same files", () => {
      expect(Object.keys(expected).sort()).toEqual([...PROTECTED].sort())
    })
    for (const rel of PROTECTED) {
      it(`${rel} is byte-for-byte what the migration started from`, () => {
        expect(hash(rel), `${rel} changed. If this is deliberate, follow the procedure in this test file and have it reviewed.`).toBe(expected[rel])
      })
    }
  }
})

// ---------------------------------------------------------------------------------------------------------------------
describe("Firebase is still the backend, and nothing has been wired to Supabase", () => {
  const sources = (dir: string): string[] =>
    fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = path.posix.join(dir, e.name)
      return e.isDirectory() ? sources(rel) : /\.(ts|tsx|js|mjs)$/.test(e.name) ? [rel] : []
    })

  it("no application source imports or mentions Supabase, except inside the backend adapter boundary (lib/backend)", () => {
    // Phase 4A added the repository boundary: Supabase may be named only under lib/backend/ (the contracts, the selector and the
    // inactive adapter). UI, hooks and the rest of lib must never import it directly. Any wider use must update this test, saying so.
    const offenders = ["app", "components", "hooks", "lib"]
      .flatMap(sources)
      .filter((f) => !f.startsWith("lib/backend/"))
      .filter((f) => /supabase/i.test(fs.readFileSync(path.join(ROOT, f), "utf8")))
    expect(offenders).toEqual([])
  })

  it("only the Supabase CLI (dev) is installed, with a local project directory and no committed remote link", () => {
    // Phase 2 added the CLI and `supabase init`; Phase 2B added the local schema migrations. A client package (@supabase/*) must update this test in the same commit, saying so.
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"))
    expect(Object.keys(pkg.dependencies ?? {}).filter((n) => /supabase/i.test(n))).toEqual([])
    expect(Object.keys(pkg.devDependencies ?? {}).filter((n) => /supabase/i.test(n))).toEqual(["supabase"])
    expect(fs.existsSync(path.join(ROOT, "supabase", "config.toml"))).toBe(true)
    expect(fs.existsSync(path.join(ROOT, "supabase", "migrations"))).toBe(true)
    const trackedLink = spawnSync("git", ["ls-files", "--error-unmatch", "supabase/.temp/project-ref"], { cwd: ROOT, stdio: "ignore" })
    expect(trackedLink.status).not.toBe(0)
  })

  it("the Firebase project and the deployed rules file are still in place", () => {
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, ".firebaserc"), "utf8")).projects.default).toBe("attendance-tracker-2k26")
    expect(fs.existsSync(path.join(ROOT, "firestore.rules"))).toBe(true)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe("attendance semantics are unchanged (golden values, worked out by hand from the formulas)", () => {
  // [attended, missed, requirement] -> [pct, status, canSkip, needed, verdict]
  const table: [number, number, number, number, string, number | null, number | null, string][] = [
    [0, 0, 75, 0, "new", null, null, "nodata"],
    [3, 1, 75, 75, "edge", 0, null, "attend"], // exactly on the line: no skips left
    [9, 1, 75, 90, "safe", 2, null, "skip"], // floor((9 - 7.5) / .75) = 2
    [2, 2, 75, 50, "risk", 0, 4, "attend"], // 6/8 = 75%: four more
    [7, 3, 75, 70, "risk", 0, 2, "attend"], // 9/12 = 75%: two more
    [74, 26, 75, 74, "risk", 0, 4, "attend"],
    [373, 127, 75, 75, "edge", 0, null, "attend"], // 74.6% ROUNDS to 75, so it is not "risk": the rounded figure decides
    [5, 0, 100, 100, "edge", 0, null, "attend"],
    [4, 1, 100, 80, "risk", 0, null, "attend"], // can never get back to 100%
    [1, 1, 0, 50, "safe", null, null, "skip"], // no minimum set
  ]
  for (const [a, m, req, pct, status, canSkip, needed, verdict] of table) {
    it(`${a} attended, ${m} missed, ${req}% required -> ${pct}% ${status}`, () => {
      const info = getAttendance(a, m, req)
      expect({ pct: info.pct, status: info.status, canSkip: info.canSkip, needed: info.needed, verdict: skipVerdict(info) }).toEqual({ pct, status, canSkip, needed, verdict })
    })
  }

  it("marking: a double tap changes nothing, changing a mark MOVES the count, clearing removes it", () => {
    const base = subject()
    const present = withSet(base, "2026-10-06", "P", { t: "09:00" })
    expect(present).toMatchObject({ attended: 1, missed: 0 })
    expect(withSet(present, "2026-10-06", "P", { t: "09:00" })).toBe(present) // same object: nothing happened
    const absent = withSet(present, "2026-10-06", "A", { t: "09:00" })
    expect(absent).toMatchObject({ attended: 0, missed: 1 })
    expect(absent.log).toHaveLength(1) // replaced, not appended
    const cleared = withSet(absent, "2026-10-06", null, { t: "09:00" })
    expect(cleared).toMatchObject({ attended: 0, missed: 0 })
    expect(markFor(cleared, "2026-10-06", "09:00")).toBeNull()
  })

  it("two classes on one day are separate marks, and undo reverts exactly the class that was marked", () => {
    const s0 = subject()
    const first = withSet(s0, "2026-10-06", "P", { t: "09:00" })
    const { next, undo } = markWithUndo(first, "2026-10-06", "A", { t: "14:00" })
    expect(markFor(next, "2026-10-06", "09:00")).toBe("P")
    expect(markFor(next, "2026-10-06", "14:00")).toBe("A")
    const back = undo(next)
    expect(markFor(back, "2026-10-06", "14:00")).toBeNull()
    expect(markFor(back, "2026-10-06", "09:00")).toBe("P") // the other class is untouched
    expect({ attended: back.attended, missed: back.missed }).toEqual({ attended: 1, missed: 0 })
  })

  it("an older mark in the same class is restored by undo (the previous state, not 'cleared')", () => {
    const marked = withSet(subject(), "2026-10-06", "A", { t: "09:00" })
    const { next, undo } = markWithUndo(marked, "2026-10-06", "P", { t: "09:00" })
    expect(markFor(next, "2026-10-06", "09:00")).toBe("P")
    expect(markFor(undo(next), "2026-10-06", "09:00")).toBe("A")
  })

  it("the log keeps the last 400 entries while the counters keep counting (counters, not the log, are the truth)", () => {
    let s = subject()
    for (let i = 0; i < 450; i++) s = withSet(s, localDate(new Date(2025, 0, 1 + i)), "P", { t: "09:00" })
    expect(s.log).toHaveLength(400)
    expect(s.attended).toBe(450)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe("three-way merge is unchanged", () => {
  const withMarks = (marks: [string, "P" | "A"][]) => marks.reduce((s, [d, st]) => withSet(s, d, st, { t: "09:00" }), subject())

  it("two devices that each marked a different day offline both keep their mark", () => {
    const base = backup([withMarks([["2026-10-05", "P"]])])
    const local = backup([withMarks([["2026-10-05", "P"], ["2026-10-06", "P"]])])
    const remote = backup([withMarks([["2026-10-05", "P"], ["2026-10-07", "A"]])])
    const { data, conflicts } = mergeData(base, local, remote)
    const merged = data.subjects[0]
    expect(conflicts).toBe(0)
    expect(["2026-10-05", "2026-10-06"].map((d) => markFor(merged, d, "09:00"))).toEqual(["P", "P"])
    expect(markFor(merged, "2026-10-07", "09:00")).toBe("A")
    expect({ attended: merged.attended, missed: merged.missed }).toEqual({ attended: 2, missed: 1 })
  })

  it("the same mark made on both devices counts once", () => {
    const base = backup([subject()])
    const both = backup([withMarks([["2026-10-06", "P"]])])
    const merged = mergeData(base, both, both).data.subjects[0]
    expect(merged.attended).toBe(1)
  })

  it("a change made only on this device survives while the other device changed something else (the rename too)", () => {
    const base = backup([withMarks([["2026-10-06", "P"]])])
    const local = backup([withMarks([["2026-10-06", "A"]])])
    const remote = backup([{ ...withMarks([["2026-10-06", "P"]]), name: "Renamed elsewhere" }])
    const r = mergeData(base, local, remote)
    expect(r.conflicts).toBe(0)
    expect(markFor(r.data.subjects[0], "2026-10-06", "09:00")).toBe("A")
    expect(r.data.subjects[0].name).toBe("Renamed elsewhere")
  })

  it("a true clash (both devices changed the same class differently) keeps this device's value and counts a conflict", () => {
    const base = backup([withMarks([["2026-10-06", "P"]])])
    const local = backup([withMarks([["2026-10-06", "A"]])])
    const remote = backup([{ ...withMarks([["2026-10-06", "P"]]), log: [] , attended: 0 }]) // the other device cleared it
    const r = mergeData(base, local, remote)
    expect(r.conflicts).toBeGreaterThan(0)
    expect(markFor(r.data.subjects[0], "2026-10-06", "09:00")).toBe("A")
  })

  it("merging an already merged copy changes nothing (no ping-pong between devices)", () => {
    const base = backup([withMarks([["2026-10-05", "P"]])])
    const local = backup([withMarks([["2026-10-05", "P"], ["2026-10-06", "P"]])])
    const remote = backup([withMarks([["2026-10-05", "P"], ["2026-10-07", "A"]])])
    const once = mergeData(base, local, remote).data
    const twice = mergeData(base, once, once).data
    expect(twice).toEqual(once)
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe("local storage and restore points stay intact", () => {
  it("the IndexedDB layer round-trips values and deletes them (its localStorage fallback, in Node)", async () => {
    stubStorage()
    await dbSet("subjects", [subject({ attended: 3 })])
    expect(await dbGet<Subject[]>("subjects")).toEqual([subject({ attended: 3 })])
    await dbDel("subjects")
    expect(await dbGet("subjects")).toBeUndefined() // a missing key reads as undefined
  })

  it("restore points: newest first, never trimmed, empty and duplicate copies skipped, only deleted on request", async () => {
    stubStorage()
    await saveRestorePoint("empty", backup([]))
    expect(await listRestorePoints()).toEqual([])
    for (let i = 1; i <= 30; i++) await saveRestorePoint(`point ${i}`, backup([subject({ attended: i })]))
    await saveRestorePoint("same as newest", backup([subject({ attended: 30 })]))
    const all = await listRestorePoints()
    expect(all).toHaveLength(30) // nothing was trimmed, and the duplicate was not added
    expect(all[0].reason).toBe("point 30")
    expect(all[29].reason).toBe("point 1")
    await deleteRestorePoint(all[10].id)
    const after = await listRestorePoints()
    expect(after).toHaveLength(29)
    expect(after.map((p) => p.id)).not.toContain(all[10].id)
  })
})

describe("offline mode: a backend that cannot be reached never throws into the app", () => {
  it("a failed upload reports 'unavailable' and does not throw", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))
    await expect(cloudPut("owner123", "{}", null)).resolves.toEqual({ ok: false, reason: "unavailable" })
  })
})

// ---------------------------------------------------------------------------------------------------------------------
describe("Ping rules of the game are unchanged", () => {
  it("the constants: at most 8 classes, 3 days to answer, a 2-minute lease, 30 days of history", () => {
    expect({ MAX_PING_ITEMS, PING_EXPIRES_DAYS, LEASE_MS, PING_HISTORY_DAYS }).toEqual({ MAX_PING_ITEMS: 8, PING_EXPIRES_DAYS: 3, LEASE_MS: 120_000, PING_HISTORY_DAYS: 30 })
  })

  const ping = (id: string, over: Partial<Ping> = {}): Ping => ({
    id, from: "me", to: "rahul-uid", fromName: "Me", toName: "Rahul", participants: ["me", "rahul-uid"], date: "2026-10-06",
    items: [{ key: "dbms@09:00", subjectId: "dbms", name: "DBMS", t: "09:00", answer: "yes" }], status: "answered", ...over,
  })

  it("exactly-once order: lease, then apply (and verify), then finalize, each once", async () => {
    const calls: string[] = []
    const result = await processAnswered(ping("order-ping-0001"), {
      lease: async () => (calls.push("lease"), true),
      apply: async () => (calls.push("apply"), true),
      finalize: async () => void calls.push("finalize"),
    })
    expect(result).toBe("processed")
    expect(calls).toEqual(["lease", "apply", "finalize"])
  })

  it("a Ping is never finalized unless the result was safely saved, and never applied without the lease", async () => {
    const finalize = vi.fn(async () => {})
    expect(await processAnswered(ping("unsaved-ping-0001"), { lease: async () => true, apply: async () => false, finalize })).toBe("apply-failed")
    const apply = vi.fn(async () => true)
    expect(await processAnswered(ping("no-lease-ping-0001"), { lease: async () => false, apply, finalize })).toBe("not-leased")
    expect(finalize).not.toHaveBeenCalled()
    expect(apply).not.toHaveBeenCalled()
  })

  it("running the same answer twice credits one favour and one mark, not two", () => {
    const sub = subject({ attended: 4, missed: 1, slots: [{ day: 2, start: "09:00", end: "10:00", kind: "Lecture" }] })
    const rahul: Mate = { id: "m1", name: "Rahul", uid: "rahul-uid", covered: 0, repaid: 0 }
    const once = applyPingResult([sub], [rahul], ping("twice-ping-0001"))
    const twice = applyPingResult(once.subjects, once.mates, ping("twice-ping-0001"))
    expect(once.mates[0].covered).toBe(1)
    expect(twice.mates[0].covered).toBe(1)
    expect(twice.subjects[0].attended).toBe(once.subjects[0].attended)
  })
})

describe("friend identity is the uid, not the name", () => {
  it("an answer is credited to the connected mate with that uid, even if the name differs", () => {
    const sub = subject({ attended: 4, missed: 1, slots: [{ day: 2, start: "09:00", end: "10:00", kind: "Lecture" }] })
    const mates: Mate[] = [{ id: "m1", name: "Rahul (renamed)", uid: "rahul-uid", covered: 0, repaid: 0 }]
    const p: Ping = {
      id: "uid-ping-0001", from: "me", to: "rahul-uid", fromName: "Me", toName: "Rahul", participants: ["me", "rahul-uid"], date: "2026-10-06", status: "answered",
      items: [{ key: "dbms@09:00", subjectId: "dbms", name: "DBMS", t: "09:00", answer: "yes" }],
    }
    const r = applyPingResult([sub], mates, p)
    expect(r.mates).toHaveLength(1)
    expect(r.mates[0]).toMatchObject({ uid: "rahul-uid", covered: 1 })
  })

  it("a DIFFERENT connected person who happens to share the name is not credited", () => {
    const sub = subject({ attended: 4, missed: 1, slots: [{ day: 2, start: "09:00", end: "10:00", kind: "Lecture" }] })
    const mates: Mate[] = [{ id: "m1", name: "Rahul", uid: "someone-else-uid", covered: 0, repaid: 0 }]
    const p: Ping = {
      id: "uid-ping-0002", from: "me", to: "rahul-uid", fromName: "Me", toName: "Rahul", participants: ["me", "rahul-uid"], date: "2026-10-06", status: "answered",
      items: [{ key: "dbms@09:00", subjectId: "dbms", name: "DBMS", t: "09:00", answer: "yes" }],
    }
    const r = applyPingResult([sub], mates, p)
    expect(r.mates.find((m) => m.uid === "someone-else-uid")?.covered).toBe(0)
    expect(r.mates.find((m) => m.uid === "rahul-uid")?.covered).toBe(1)
  })
})
