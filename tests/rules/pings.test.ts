import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest"
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing"
import { Timestamp, collection, deleteDoc, doc, getDoc, getDocs, serverTimestamp, setDoc, updateDoc, type Firestore } from "firebase/firestore"
import fs from "node:fs"
import { answerPing, createPing, finalizePing, leasePing, removePing, type NewPing } from "@/lib/ping-server"
import type { PingItem } from "@/lib/types"

/**
 * The Ping rules, run against the real Firestore emulator with the real firestore.rules file.
 * Every "cannot" here is the SERVER refusing: the client in these tests behaves as badly as it likes.
 */
let env: RulesTestEnvironment
const ASHA = "uid-asha" // the one who was away and asks
const RAHUL = "uid-rahul" // the mate who is asked
const MALLORY = "uid-mallory" // someone else entirely
// The testing library hands back the compat flavour of Firestore; the modular functions accept it at run time
const asDb = (db: unknown) => db as Firestore
const asha = () => asDb(env.authenticatedContext(ASHA).firestore())
const rahul = () => asDb(env.authenticatedContext(RAHUL).firestore())
const mallory = () => asDb(env.authenticatedContext(MALLORY).firestore())

const day = (daysAgo: number) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10)
const item = (key = "dbms@09:00", over: Partial<PingItem> = {}): PingItem => ({ key, subjectId: "dbms", name: "DBMS", t: "09:00", answer: null, ...over })
const ping = (over: Partial<NewPing> = {}): NewPing => ({
  id: "ping-0001-aaaa",
  from: { uid: ASHA, name: "Asha" },
  to: { uid: RAHUL, name: "Rahul" },
  date: day(1),
  items: [item(), item("path@14:00", { subjectId: "path", name: "Pathology", t: "14:00" })],
  requestId: "req-asha-rahul",
  ...over,
})
const answers = (p: NewPing, a: ("yes" | "no")[]): PingItem[] => p.items.map((i, n) => ({ ...i, answer: a[n] ?? "no" }))

/** Writes straight to the database, bypassing the rules, to set up states the app could not produce itself */
const seed = (fn: (db: Firestore) => Promise<void>) => env.withSecurityRulesDisabled((c) => fn(asDb(c.firestore())))
const rawPing = (p: NewPing, extra: Record<string, unknown> = {}) => ({
  from: p.from.uid, to: p.to.uid, fromName: p.from.name, toName: p.to.name, participants: [p.from.uid, p.to.uid],
  requestId: p.requestId, date: p.date, items: p.items, status: "asking", createdAt: Timestamp.now(), ...extra,
})
/** Reads straight from the database (rules off), so a test can see what really got stored */
const read = async (id: string) => {
  let out: Record<string, unknown> | undefined
  await env.withSecurityRulesDisabled(async (c) => void (out = (await getDoc(doc(asDb(c.firestore()), "pings", id))).data()))
  return out
}
const count = async () => {
  let n = 0
  await env.withSecurityRulesDisabled(async (c) => void (n = (await getDocs(collection(asDb(c.firestore()), "pings"))).size))
  return n
}

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-ping", firestore: { rules: fs.readFileSync("firestore.rules", "utf8") } })
})
afterAll(() => env.cleanup())
beforeEach(async () => {
  await env.clearFirestore()
  await seed(async (db) => {
    await setDoc(doc(db, "requests/req-asha-rahul"), { from: ASHA, to: RAHUL, fromName: "Asha", toName: "Rahul", participants: [ASHA, RAHUL], status: "accepted" })
    await setDoc(doc(db, "requests/req-pending"), { from: ASHA, to: MALLORY, fromName: "Asha", toName: "Mallory", participants: [ASHA, MALLORY], status: "pending" })
  })
})

describe("creating a Ping", () => {
  it("an asker can create one for an accepted mate, and the server stamps the time", async () => {
    expect(await createPing(asha(), ping())).toBe("created")
    const d = await read("ping-0001-aaaa")
    expect(d).toMatchObject({ from: ASHA, to: RAHUL, status: "asking" })
    expect(d?.createdAt).toBeTruthy()
  })

  it("8. cannot manufacture a Ping involving someone they aren't connected to", async () => {
    await assertFails(createPing(asha(), ping({ to: { uid: MALLORY, name: "Mallory" }, requestId: "req-pending" }))) // pending, not accepted
    await assertFails(createPing(mallory(), ping({ from: { uid: MALLORY, name: "Mallory" } }))) // using someone else's connection
    await assertFails(createPing(asha(), ping({ to: { uid: MALLORY, name: "Mallory" } }))) // the connection is not between these two
    await assertFails(createPing(asha(), ping({ requestId: "no-such-request" })))
  })

  it("cannot be created as someone else, or to oneself", async () => {
    await assertFails(createPing(rahul(), ping())) // Rahul pretending to be Asha
    await assertFails(createPing(asha(), ping({ to: { uid: ASHA, name: "Asha" } })))
  })

  it("cannot be created already answered, with extra fields, or with bad classes", async () => {
    const ref = (db: Firestore) => doc(db, "pings", "ping-0002-bbbb")
    const base = { ...rawPing(ping({ id: "ping-0002-bbbb" })), createdAt: serverTimestamp() }
    await assertSucceeds(setDoc(ref(asha()), base))
    await env.clearFirestore()
    await seed((db) => setDoc(doc(db, "requests/req-asha-rahul"), { from: ASHA, to: RAHUL, fromName: "Asha", toName: "Rahul", participants: [ASHA, RAHUL], status: "accepted" }))
    await assertFails(setDoc(ref(asha()), { ...base, status: "answered" }))
    await assertFails(setDoc(ref(asha()), { ...base, status: "processed" }))
    await assertFails(setDoc(ref(asha()), { ...base, claimedBy: "sneaky-device-1" }))
    await assertFails(setDoc(ref(asha()), { ...base, items: [item("a", { answer: "yes" })] })) // pre-filled answer
    await assertFails(setDoc(ref(asha()), { ...base, items: [{ ...item("a"), extra: "x" }] }))
    await assertFails(setDoc(ref(asha()), { ...base, items: [] }))
    await assertFails(setDoc(ref(asha()), { ...base, items: Array.from({ length: 9 }, (_, i) => item(`k${i}`)) }))
    await assertFails(setDoc(ref(asha()), { ...base, items: [item("a", { name: "x".repeat(61) })] }))
    await assertFails(setDoc(ref(asha()), { ...base, items: [{ ...item("a"), t: 900 }] })) // a time that isn't text
    await assertFails(setDoc(ref(asha()), { ...base, createdAt: Timestamp.fromMillis(Date.now() + 86_400_000 * 9) })) // not the server's time
  })

  it("must be for a recent class day (not months ago, not far ahead)", async () => {
    await assertSucceeds(createPing(asha(), ping({ id: "ping-today-0001", date: day(0) })))
    await assertSucceeds(createPing(asha(), ping({ id: "ping-2days-0001", date: day(2) })))
    await assertFails(createPing(asha(), ping({ id: "ping-old-000001", date: day(6) })))
    await assertFails(createPing(asha(), ping({ id: "ping-future-0001", date: day(-4) })))
  })

  it("the largest legal Ping (8 classes) is created and answered within the server's evaluation limits", async () => {
    const twelve = Array.from({ length: 8 }, (_, n) => item(`subject${n}@0${n % 10}:00`, { subjectId: `subject${n}`, name: `Subject number ${n}`, t: `0${n % 10}:00` }))
    const big = ping({ id: "ping-eight-0001", items: twelve })
    await assertSucceeds(createPing(asha(), big))
    await assertSucceeds(answerPing(rahul(), "ping-eight-0001", twelve.map((i, n) => ({ ...i, answer: n % 2 ? "yes" : "no" }))))
    expect(await leasePing(asha(), "ping-eight-0001", "device-phone-001")).toBe(true)
    expect(await finalizePing(asha(), "ping-eight-0001")).toBe("processed")
  })

  it("the id has to be a plain token", async () => {
    await assertFails(createPing(asha(), ping({ id: "short" })))
    await assertFails(createPing(asha(), ping({ id: "has spaces in it" })))
    await assertFails(createPing(asha(), ping({ id: "dots.are.not.allowed" })))
  })
})

describe("14/15/16. creating the same Ping again never makes a second one", () => {
  it("a retry with the same id resolves to the Ping that is already there", async () => {
    expect(await createPing(asha(), ping())).toBe("created")
    expect(await createPing(asha(), ping())).toBe("existing") // the first attempt had landed; the app just never heard
    expect(await count()).toBe(1)
  })

  it("a double tap (two at once) is one Ping", async () => {
    const results = await Promise.all([createPing(asha(), ping()), createPing(asha(), ping())])
    expect(results.sort()).toEqual(["created", "existing"])
    expect(await count()).toBe(1)
  })

  it("it still resolves once the mate has already answered it", async () => {
    await createPing(asha(), ping())
    await answerPing(rahul(), "ping-0001-aaaa", answers(ping(), ["yes", "no"]))
    expect(await createPing(asha(), ping())).toBe("existing")
    expect((await read("ping-0001-aaaa"))?.status).toBe("answered") // the retry did not reset it
  })

  it("a different request under the same id is refused, not merged", async () => {
    await createPing(asha(), ping())
    await expect(createPing(asha(), ping({ date: day(0) }))).rejects.toBeTruthy()
    await expect(createPing(asha(), ping({ items: [item("another@11:00")] }))).rejects.toBeTruthy()
  })
})

describe("answering a Ping", () => {
  beforeEach(async () => void (await createPing(asha(), ping())))

  it("the mate can answer yes / no on each class", async () => {
    await assertSucceeds(answerPing(rahul(), "ping-0001-aaaa", answers(ping(), ["yes", "no"])))
    const d = await read("ping-0001-aaaa")
    expect(d?.status).toBe("answered")
    expect((d?.items as PingItem[]).map((i) => i.answer)).toEqual(["yes", "no"])
  })

  it("5. the mate cannot change the class, the subject, the time or the day", async () => {
    const p = ping()
    const tamper = (mutate: (items: PingItem[]) => PingItem[]) => answerPing(rahul(), "ping-0001-aaaa", mutate(answers(p, ["yes", "yes"])))
    await assertFails(tamper((i) => [{ ...i[0], subjectId: "someone-elses" }, i[1]])) // redirect the yes to another subject
    await assertFails(tamper((i) => [{ ...i[0], name: "Physics" }, i[1]]))
    await assertFails(tamper((i) => [{ ...i[0], t: "16:00" }, i[1]]))
    await assertFails(tamper((i) => [{ ...i[0], key: "other@09:00" }, i[1]]))
    await assertFails(tamper((i) => [i[0]])) // dropping a class
    await assertFails(tamper((i) => [...i, item("extra@17:00", { answer: "yes" })])) // adding one
    await assertFails(tamper((i) => [i[1], i[0]])) // reordering so the answers land on different classes
    const d = await read("ping-0001-aaaa")
    expect(d?.status).toBe("asking") // nothing got through
  })

  it("cannot change who asked, who was asked, or the day", async () => {
    const ref = doc(rahul(), "pings", "ping-0001-aaaa")
    const ok = { items: answers(ping(), ["yes", "yes"]), status: "answered", respondedAt: serverTimestamp() }
    await assertFails(updateDoc(ref, { ...ok, from: RAHUL }))
    await assertFails(updateDoc(ref, { ...ok, to: MALLORY }))
    await assertFails(updateDoc(ref, { ...ok, participants: [RAHUL, MALLORY] }))
    await assertFails(updateDoc(ref, { ...ok, date: day(0) }))
    await assertFails(updateDoc(ref, { ...ok, requestId: "req-pending" }))
    await assertFails(updateDoc(ref, { ...ok, createdAt: Timestamp.now() }))
    await assertFails(updateDoc(ref, { ...ok, fromName: "Someone" }))
  })

  it("only yes or no is accepted as an answer", async () => {
    const ref = doc(rahul(), "pings", "ping-0001-aaaa")
    const bad = (a: unknown) => ({ items: ping().items.map((i) => ({ ...i, answer: a })), status: "answered", respondedAt: serverTimestamp() })
    await assertFails(updateDoc(ref, bad("maybe")))
    await assertFails(updateDoc(ref, bad(null)))
    await assertFails(updateDoc(ref, bad(true)))
  })

  it("the mate cannot skip straight to processed, or backdate the reply", async () => {
    const ref = doc(rahul(), "pings", "ping-0001-aaaa")
    await assertFails(updateDoc(ref, { status: "processed", processedAt: serverTimestamp() }))
    await assertFails(updateDoc(ref, { items: answers(ping(), ["yes", "yes"]), status: "answered", respondedAt: Timestamp.fromMillis(Date.now() - 86_400_000) }))
  })

  it("6. nobody else can answer: not a stranger, not the asker", async () => {
    await assertFails(answerPing(mallory(), "ping-0001-aaaa", answers(ping(), ["yes", "yes"])))
    await assertFails(answerPing(asha(), "ping-0001-aaaa", answers(ping(), ["yes", "yes"]))) // answering your own request
    await assertFails(answerPing(asDb(env.unauthenticatedContext().firestore()), "ping-0001-aaaa", answers(ping(), ["yes", "yes"])))
    expect((await read("ping-0001-aaaa"))?.status).toBe("asking")
  })

  it("cannot be answered twice", async () => {
    await assertSucceeds(answerPing(rahul(), "ping-0001-aaaa", answers(ping(), ["no", "no"])))
    await assertFails(answerPing(rahul(), "ping-0001-aaaa", answers(ping(), ["yes", "yes"]))) // changing a no to a yes afterwards
  })

  it("cannot be answered once the connection has ended", async () => {
    await seed((db) => deleteDoc(doc(db, "requests/req-asha-rahul")))
    await assertFails(answerPing(rahul(), "ping-0001-aaaa", answers(ping(), ["yes", "yes"])))
  })
})

describe("7. server-side expiry (3 days from the server's clock)", () => {
  const ageIt = (days: number) =>
    seed((db) => setDoc(doc(db, "pings", "ping-0001-aaaa"), rawPing(ping({ date: day(1) }), { createdAt: Timestamp.fromMillis(Date.now() - days * 86_400_000) })))

  it("a Ping just inside its life can be answered", async () => {
    await ageIt(2.9)
    await assertSucceeds(answerPing(rahul(), "ping-0001-aaaa", answers(ping(), ["yes", "no"])))
  })

  it("an expired Ping cannot be answered, whatever the app's clock says", async () => {
    await ageIt(3.1)
    await assertFails(answerPing(rahul(), "ping-0001-aaaa", answers(ping(), ["yes", "yes"])))
    expect((await read("ping-0001-aaaa"))?.status).toBe("asking")
  })

  it("an expired Ping cannot be turned into a valid one by editing its dates", async () => {
    await ageIt(5)
    const ref = doc(asha(), "pings", "ping-0001-aaaa")
    await assertFails(updateDoc(ref, { createdAt: serverTimestamp() })) // the asker cannot give it a new life
    await assertFails(updateDoc(ref, { date: day(0) }))
    await assertFails(updateDoc(ref, { status: "answered" }))
    await assertFails(answerPing(rahul(), "ping-0001-aaaa", answers(ping(), ["yes", "yes"])))
  })

  it("an answer given in time can still be applied later, but never changed", async () => {
    await createPing(asha(), ping())
    await answerPing(rahul(), "ping-0001-aaaa", answers(ping(), ["yes", "no"]))
    await seed((db) => updateDoc(doc(db, "pings", "ping-0001-aaaa"), { createdAt: Timestamp.fromMillis(Date.now() - 9 * 86_400_000) }))
    await assertSucceeds(leasePing(asha(), "ping-0001-aaaa", "device-asha-1").then((won) => expect(won).toBe(true)))
    await assertFails(answerPing(rahul(), "ping-0001-aaaa", answers(ping(), ["yes", "yes"])))
  })
})

describe("exactly-once processing: lease, then finalize", () => {
  const answered = async () => {
    await createPing(asha(), ping())
    await answerPing(rahul(), "ping-0001-aaaa", answers(ping(), ["yes", "no"]))
  }

  it("9. only one device can hold the lease at a time", async () => {
    await answered()
    expect(await leasePing(asha(), "ping-0001-aaaa", "device-phone-001")).toBe(true)
    expect(await leasePing(asha(), "ping-0001-aaaa", "device-laptop-01")).toBe(false) // the other device waits
    expect((await read("ping-0001-aaaa"))?.claimedBy).toBe("device-phone-001")
  })

  it("two devices racing for it: exactly one wins", async () => {
    await answered()
    const results = await Promise.all([leasePing(asha(), "ping-0001-aaaa", "device-phone-001"), leasePing(asha(), "ping-0001-aaaa", "device-laptop-01")])
    expect(results.filter(Boolean)).toHaveLength(1)
  })

  it("10. a device that crashed can take its own lease again straight away", async () => {
    await answered()
    expect(await leasePing(asha(), "ping-0001-aaaa", "device-phone-001")).toBe(true)
    expect(await leasePing(asha(), "ping-0001-aaaa", "device-phone-001")).toBe(true) // reopened after the crash
  })

  it("10. and the other device can take over once the lease has run out", async () => {
    await answered()
    expect(await leasePing(asha(), "ping-0001-aaaa", "device-phone-001")).toBe(true)
    await seed((db) => updateDoc(doc(db, "pings", "ping-0001-aaaa"), { claimedAt: Timestamp.fromMillis(Date.now() - 3 * 60_000) })) // 3 minutes ago
    expect(await leasePing(asha(), "ping-0001-aaaa", "device-laptop-01")).toBe(true)
    expect((await read("ping-0001-aaaa"))?.claimedBy).toBe("device-laptop-01")
  })

  it("a lease cannot be backdated or made to look free by the client", async () => {
    await answered()
    await leasePing(asha(), "ping-0001-aaaa", "device-phone-001")
    const ref = doc(asha(), "pings", "ping-0001-aaaa")
    await assertFails(updateDoc(ref, { claimedBy: "device-laptop-01", claimedAt: Timestamp.fromMillis(Date.now() - 86_400_000) }))
    await assertFails(updateDoc(ref, { claimedBy: "device-laptop-01", claimedAt: serverTimestamp() })) // still held by the phone
  })

  it("only the asker can lease or finalize", async () => {
    await answered()
    expect(await leasePing(rahul(), "ping-0001-aaaa", "device-rahul-01")).toBe(false)
    expect(await leasePing(mallory(), "ping-0001-aaaa", "device-evil-001")).toBe(false)
    await assertFails(finalizePing(rahul(), "ping-0001-aaaa"))
    await assertFails(finalizePing(mallory(), "ping-0001-aaaa"))
  })

  it("an unanswered Ping cannot be leased or finalized", async () => {
    await createPing(asha(), ping())
    expect(await leasePing(asha(), "ping-0001-aaaa", "device-phone-001")).toBe(false)
    await assertFails(finalizePing(asha(), "ping-0001-aaaa"))
  })

  it("9. finalizing works once; a second finalize is recognised as done, and a processed Ping is frozen", async () => {
    await answered()
    await leasePing(asha(), "ping-0001-aaaa", "device-phone-001")
    expect(await finalizePing(asha(), "ping-0001-aaaa")).toBe("processed")
    expect(await finalizePing(asha(), "ping-0001-aaaa")).toBe("already") // the other device, or a retry
    const ref = doc(asha(), "pings", "ping-0001-aaaa")
    await assertFails(updateDoc(ref, { status: "asking" }))
    await assertFails(updateDoc(ref, { status: "answered" }))
    await assertFails(updateDoc(ref, { claimedBy: "device-laptop-01", claimedAt: serverTimestamp() }))
    await assertFails(answerPing(rahul(), "ping-0001-aaaa", answers(ping(), ["no", "no"])))
    expect(await leasePing(asha(), "ping-0001-aaaa", "device-laptop-01")).toBe(false)
  })
})

describe("the previous version of the app keeps working while people update", () => {
  // These are the exact writes the app made before this change (an auto-generated id, then an answer, then the direct claim)
  it("can still send, answer and finish a Ping with the old kind of writes", async () => {
    const ref = doc(asha(), "pings", "Xk3f9Qp2LmZ7vB1nR8tY") // a Firestore auto-id
    await assertSucceeds(
      setDoc(ref, {
        from: ASHA, to: RAHUL, fromName: "Asha", toName: "Rahul", participants: [ASHA, RAHUL], requestId: "req-asha-rahul",
        date: day(1), items: [item()], status: "asking", createdAt: serverTimestamp(),
      }),
    )
    await assertSucceeds(updateDoc(doc(rahul(), "pings", "Xk3f9Qp2LmZ7vB1nR8tY"), { items: [item("dbms@09:00", { answer: "yes" })], status: "answered", respondedAt: serverTimestamp() }))
    await assertSucceeds(updateDoc(doc(asha(), "pings", "Xk3f9Qp2LmZ7vB1nR8tY"), { status: "processed", processedAt: serverTimestamp() }))
  })
})

describe("reading and deleting", () => {
  beforeEach(async () => void (await createPing(asha(), ping())))

  it("only the two people can read it", async () => {
    await assertSucceeds(getDoc(doc(asha(), "pings", "ping-0001-aaaa")))
    await assertSucceeds(getDoc(doc(rahul(), "pings", "ping-0001-aaaa")))
    await assertFails(getDoc(doc(mallory(), "pings", "ping-0001-aaaa")))
  })

  it("an answer cannot be thrown away before it has been applied", async () => {
    await answerPing(rahul(), "ping-0001-aaaa", answers(ping(), ["yes", "yes"]))
    await assertFails(removePing(asha(), "ping-0001-aaaa"))
    await assertFails(removePing(rahul(), "ping-0001-aaaa"))
    await leasePing(asha(), "ping-0001-aaaa", "device-phone-001")
    await finalizePing(asha(), "ping-0001-aaaa")
    await assertSucceeds(removePing(asha(), "ping-0001-aaaa")) // once it is processed it is just history
  })

  it("a waiting Ping can be withdrawn by either person, but not by a stranger", async () => {
    await assertFails(removePing(mallory(), "ping-0001-aaaa"))
    await assertSucceeds(removePing(asha(), "ping-0001-aaaa"))
  })
})
