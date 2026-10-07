import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing"
import { Timestamp, addDoc, collection, doc, getDoc, runTransaction, serverTimestamp, setDoc, updateDoc, type Firestore } from "firebase/firestore"
import fs from "node:fs"
import { answerPing, createPing, finalizePing, leasePing } from "@/lib/ping-server"

/**
 * Pings that exist from BEFORE the current rules, and apps that are still the previous version.
 *
 * The rules can't re-check a document that was written under older rules, so what they must do is refuse to act on any
 * that falls outside what they now guarantee: a Ping with more than 8 classes (the old limit was 12), or one whose
 * creation time isn't in the past (the old rules never pinned it). And the previous version's own writes must keep working.
 * See the read-only review that found these: they are the cases an attacker would have to be sitting on.
 */
let env: RulesTestEnvironment
const ASKER = "uid-asker"
const RECEIVER = "uid-receiver"
const STRANGER = "uid-stranger"
const asDb = (db: unknown) => db as Firestore
const db = (uid: string) => asDb(env.authenticatedContext(uid).firestore())

const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
const item = (key: string, over: Record<string, unknown> = {}) => ({ key, subjectId: "dbms", name: "DBMS", t: "09:00", answer: null, ...over })
const classes = (n: number) => Array.from({ length: n }, (_, i) => item(`class-${i}@0${i % 10}:00`, { subjectId: `subject-${i}`, name: `Subject ${i}`, t: `0${i % 10}:00` }))
const answeredAs = (items: ReturnType<typeof classes>, answer: "yes" | "no") => items.map((i) => ({ ...i, answer }))

/** A Ping exactly as it would be sitting in the database, written without the rules (as the older rules/app left it) */
const seed = (id: string, over: Record<string, unknown> = {}) =>
  env.withSecurityRulesDisabled((c) =>
    setDoc(doc(asDb(c.firestore()), "pings", id), {
      from: ASKER, to: RECEIVER, fromName: "Asker", toName: "Receiver", participants: [ASKER, RECEIVER], requestId: "req-ar",
      date: day(1), items: [item("a")], status: "asking", createdAt: Timestamp.now(), ...over,
    }),
  )
const stored = async (id: string) => {
  let out: Record<string, unknown> | undefined
  await env.withSecurityRulesDisabled(async (c) => void (out = (await getDoc(doc(asDb(c.firestore()), "pings", id))).data()))
  return out
}

// What the previous version of the app wrote, verbatim (from git: lib/social.ts before this work)
const oldCreate = (uid: string, over: Record<string, unknown> = {}) =>
  addDoc(collection(db(uid), "pings"), { from: ASKER, to: RECEIVER, fromName: "Asker", toName: "Receiver", participants: [ASKER, RECEIVER], requestId: "req-ar", date: day(1), items: [item("a")], status: "asking", createdAt: serverTimestamp(), ...over })
const oldAnswer = (uid: string, id: string, items: unknown[]) => updateDoc(doc(db(uid), "pings", id), { items, status: "answered", respondedAt: serverTimestamp() })
const oldClaim = (uid: string, id: string) => {
  const d = db(uid) // one Firestore instance for the whole transaction
  return runTransaction(d, async (tx) => {
    const ref = doc(d, "pings", id)
    const snap = await tx.get(ref)
    if (!snap.exists() || snap.data().status !== "answered") return false
    tx.update(ref, { status: "processed", processedAt: serverTimestamp() })
    return true
  })
}

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-ping", firestore: { rules: fs.readFileSync("firestore.rules", "utf8") } })
})
afterAll(() => env.cleanup())
beforeEach(async () => {
  await env.clearFirestore()
  await env.withSecurityRulesDisabled((c) => setDoc(doc(asDb(c.firestore()), "requests/req-ar"), { from: ASKER, to: RECEIVER, participants: [ASKER, RECEIVER], status: "accepted" }))
})

describe("a legacy Ping with 9 to 12 classes (the old limit was 12)", () => {
  it("cannot be answered, whoever asks and however it is answered", async () => {
    for (const n of [9, 10, 11, 12]) {
      const id = `legacy-${n}-classes-0001`
      await seed(id, { items: classes(n) })
      await assertFails(oldAnswer(RECEIVER, id, answeredAs(classes(n), "yes"))) // an honest answer, with nothing altered
      await assertFails(oldAnswer(RECEIVER, id, answeredAs(classes(n), "no")))
      expect((await stored(id))?.status).toBe("asking") // untouched: it simply expires
    }
  })

  it("cannot have its later classes rewritten while being 'answered' (the attack the cap closes)", async () => {
    const id = "legacy-rewrite-0001"
    const nine = classes(9)
    await seed(id, { items: nine })
    const rewritten = nine.map((i, n) => (n === 8 ? { ...i, subjectId: "a-different-subject", name: "Rewritten", t: "23:59", answer: "yes" } : { ...i, answer: "no" }))
    await assertFails(oldAnswer(RECEIVER, id, rewritten))

    const id12 = "legacy-garbage-0001"
    const twelve = classes(12)
    await seed(id12, { items: twelve })
    await assertFails(oldAnswer(RECEIVER, id12, twelve.map((i, n) => (n >= 8 ? { ...i, subjectId: "x", answer: "garbage" } : { ...i, answer: "no" }))))
    expect((await stored(id12))?.items).toEqual(twelve)
  })

  it("cannot be touched through any other route either: not by a stranger, not by the asker taking it over", async () => {
    await seed("legacy-other-routes-1", { items: classes(10) })
    await assertFails(oldAnswer(STRANGER, "legacy-other-routes-1", answeredAs(classes(10), "yes")))
    await assertFails(oldAnswer(ASKER, "legacy-other-routes-1", answeredAs(classes(10), "yes")))
    await assertFails(updateDoc(doc(db(ASKER), "pings", "legacy-other-routes-1"), { items: answeredAs(classes(10), "yes"), status: "answered" }))
  })

  it("exactly 8 classes (the new limit) still works, so the cap isn't off by one", async () => {
    await seed("legacy-eight-classes-1", { items: classes(8) })
    await assertSucceeds(oldAnswer(RECEIVER, "legacy-eight-classes-1", answeredAs(classes(8), "yes")))
  })

  it("an answered legacy Ping (answered before the rules changed) can still be finished by its asker", async () => {
    await seed("legacy-answered-0001", { items: answeredAs(classes(10), "yes"), status: "answered", respondedAt: Timestamp.now() })
    expect(await leasePing(db(ASKER), "legacy-answered-0001", "device-phone-001")).toBe(true)
    expect(await finalizePing(db(ASKER), "legacy-answered-0001")).toBe("processed")
  })
})

describe("a Ping whose creation time is not in the past (the old rules never pinned createdAt)", () => {
  const answerable = (id: string) => oldAnswer(RECEIVER, id, [item("a", { answer: "yes" })])

  it("a far-future creation time cannot be used to dodge expiry", async () => {
    await seed("forged-year-ahead-01", { createdAt: Timestamp.fromMillis(Date.now() + 365 * 86_400_000) })
    await assertFails(answerable("forged-year-ahead-01"))
    await seed("forged-decade-ahead-1", { createdAt: Timestamp.fromMillis(Date.now() + 3650 * 86_400_000) })
    await assertFails(answerable("forged-decade-ahead-1"))
    expect((await stored("forged-year-ahead-01"))?.status).toBe("asking")
  })

  it("even a creation time only a little ahead of the server's clock is refused", async () => {
    await seed("forged-minute-ahead-1", { createdAt: Timestamp.fromMillis(Date.now() + 10 * 60_000) })
    await assertFails(answerable("forged-minute-ahead-1"))
  })

  it("a creation time that is simply wrong (missing, or not a timestamp) also fails closed", async () => {
    await env.withSecurityRulesDisabled((c) =>
      setDoc(doc(asDb(c.firestore()), "pings", "no-created-at-00001"), { from: ASKER, to: RECEIVER, fromName: "A", toName: "R", participants: [ASKER, RECEIVER], requestId: "req-ar", date: day(1), items: [item("a")], status: "asking" }),
    )
    await assertFails(answerable("no-created-at-00001"))
    await seed("created-as-text-0001", { createdAt: "yesterday" })
    await assertFails(answerable("created-as-text-0001"))
  })

  it("a real Ping, created moments ago or two days ago, is unaffected", async () => {
    await seed("created-just-now-001", { createdAt: Timestamp.now() })
    await assertSucceeds(answerable("created-just-now-001"))
    await seed("created-two-days-001", { createdAt: Timestamp.fromMillis(Date.now() - 2 * 86_400_000) })
    await assertSucceeds(answerable("created-two-days-001"))
  })

  it("and new Pings cannot be created with such a time in the first place", async () => {
    await assertFails(oldCreate(ASKER, { createdAt: Timestamp.fromMillis(Date.now() + 86_400_000) }))
    await assertFails(oldCreate(ASKER, { createdAt: Timestamp.fromMillis(Date.now() - 86_400_000) }))
  })
})

describe("the previous version of the app still works end to end", () => {
  it("creates, is answered, and is claimed, with exactly the writes it always made", async () => {
    const ref = await assertSucceeds(oldCreate(ASKER, { items: [item("a"), item("b")] }))
    await assertSucceeds(oldAnswer(RECEIVER, ref.id, [item("a", { answer: "yes" }), item("b", { answer: "no" })]))
    expect(await oldClaim(ASKER, ref.id)).toBe(true)
    const done = await stored(ref.id)
    expect(done).toMatchObject({ status: "processed" })
    expect((done?.items as { answer: string }[]).map((i) => i.answer)).toEqual(["yes", "no"])
  })

  it("claiming twice still processes once: the second claim finds nothing to do", async () => {
    const ref = await oldCreate(ASKER)
    await oldAnswer(RECEIVER, ref.id, [item("a", { answer: "yes" })])
    expect(await oldClaim(ASKER, ref.id)).toBe(true)
    expect(await oldClaim(ASKER, ref.id)).toBe(false)
  })

  it("an old client with the largest Ping it can now send (8 classes) works; one more is refused at creation", async () => {
    await assertSucceeds(oldCreate(ASKER, { items: classes(8) }))
    await assertFails(oldCreate(ASKER, { items: classes(9) }))
  })
})

describe("a normal Ping from the current app still works end to end", () => {
  it("creates, is answered, is leased and finalized, and a retry resolves to the same Ping", async () => {
    const ping = { id: "current-app-ping-01", from: { uid: ASKER, name: "Asker" }, to: { uid: RECEIVER, name: "Receiver" }, date: day(1), requestId: "req-ar", items: [item("a"), item("b")] } as never
    expect(await createPing(db(ASKER), ping)).toBe("created")
    expect(await createPing(db(ASKER), ping)).toBe("existing")
    await assertSucceeds(answerPing(db(RECEIVER), "current-app-ping-01", [item("a", { answer: "yes" }), item("b", { answer: "no" })] as never))
    expect(await leasePing(db(ASKER), "current-app-ping-01", "device-phone-001")).toBe(true)
    expect(await finalizePing(db(ASKER), "current-app-ping-01")).toBe("processed")
    expect((await stored("current-app-ping-01"))?.status).toBe("processed")
  })

  it("a full 8-class Ping from the current app can be created and answered", async () => {
    const eight = classes(8)
    await assertSucceeds(createPing(db(ASKER), { id: "current-app-eight-01", from: { uid: ASKER, name: "Asker" }, to: { uid: RECEIVER, name: "Receiver" }, date: day(0), requestId: "req-ar", items: eight } as never))
    await assertSucceeds(answerPing(db(RECEIVER), "current-app-eight-01", answeredAs(eight, "yes") as never))
  })
})
