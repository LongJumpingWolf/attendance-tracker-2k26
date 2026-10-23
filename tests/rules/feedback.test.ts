import { afterAll, beforeAll, beforeEach, describe, it } from "vitest"
import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from "@firebase/rules-unit-testing"
import { collection, doc, getDoc, getDocs, query, serverTimestamp, setDoc, updateDoc, writeBatch, where, type Firestore } from "firebase/firestore"
import fs from "node:fs"

/**
 * Tickets (bug reports, feature requests, ratings) and their conversations, against the real emulator and rules.
 * Every "cannot" is the server refusing, whatever the client tries.
 */
let env: RulesTestEnvironment
const ME = "uid-me"
const OTHER = "uid-other"
const DEV_EMAIL = "adityavw2006@gmail.com"

const asDb = (db: unknown) => db as Firestore
const person = (uid: string): Firestore => asDb(env.authenticatedContext(uid, { email: `${uid}@example.com`, email_verified: true }).firestore())
const developer = (): Firestore => asDb(env.authenticatedContext("uid-dev", { email: DEV_EMAIL, email_verified: true }).firestore())
const seed = (fn: (db: Firestore) => Promise<void>) => env.withSecurityRulesDisabled((ctx) => fn(asDb(ctx.firestore())))

const ticket = (o: Record<string, unknown> = {}) => ({
  uid: ME, userEmail: null, userName: null, kind: "bug", rating: null, message: "It breaks", status: "open", seenByUser: false, createdAt: new Date(), ...o,
})
const newTicket = (db: Firestore, id: string, o: Record<string, unknown> = {}) => setDoc(doc(db, "feedback", id), { ...ticket(o), createdAt: serverTimestamp() })

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-ping", firestore: { rules: fs.readFileSync("firestore.rules", "utf8") } })
})
afterAll(() => env.cleanup())
beforeEach(() => env.clearFirestore())

describe("ratings", () => {
  it("lets a signed-in person create their one rating, under their own id only", async () => {
    await assertSucceeds(newTicket(person(ME), `rating-${ME}`, { kind: "rating", rating: 4, message: "" }))
    await assertFails(newTicket(person(ME), "rating-someone-else", { kind: "rating", rating: 4, message: "" }))
    await assertFails(newTicket(person(ME), "random-id", { kind: "rating", rating: 4, message: "" }))
  })

  it("lets them change it later, only to a real rating, and nothing else on the ticket", async () => {
    await seed((db) => setDoc(doc(db, "feedback", `rating-${ME}`), ticket({ kind: "rating", rating: 3, message: "" })))
    const db = person(ME)
    await assertSucceeds(updateDoc(doc(db, "feedback", `rating-${ME}`), { rating: 5, ratingUpdatedAt: serverTimestamp() }))
    await assertFails(updateDoc(doc(db, "feedback", `rating-${ME}`), { rating: 9, ratingUpdatedAt: serverTimestamp() }))
    await assertFails(updateDoc(doc(db, "feedback", `rating-${ME}`), { rating: 5, ratingUpdatedAt: serverTimestamp(), status: "resolved" }))
    await assertFails(updateDoc(doc(person(OTHER), "feedback", `rating-${ME}`), { rating: 1, ratingUpdatedAt: serverTimestamp() }))
  })

  it("lets someone who is not signed in rate once, without an account", async () => {
    await assertSucceeds(newTicket(asDb(env.unauthenticatedContext().firestore()), "anon-rating", { kind: "rating", uid: null, rating: 5, message: "" }))
  })

  it("lets them add as many notes as they like", async () => {
    await seed((db) => setDoc(doc(db, "feedback", `rating-${ME}`), ticket({ kind: "rating", rating: 3, message: "" })))
    const db = person(ME)
    for (let n = 0; n < 3; n++) {
      const batch = writeBatch(db)
      batch.set(doc(collection(db, "feedback", `rating-${ME}`, "messages")), { from: "user", text: `note ${n}`, createdAt: serverTimestamp() })
      batch.update(doc(db, "feedback", `rating-${ME}`), { status: "open", lastFrom: "user", lastMessageAt: serverTimestamp(), messageCount: n + 1 })
      await assertSucceeds(batch.commit())
    }
  })
})

describe("the conversation on a ticket", () => {
  beforeEach(() => seed((db) => setDoc(doc(db, "feedback", "t1"), ticket())))

  it("lets only the author and the developer read it", async () => {
    await assertSucceeds(getDoc(doc(person(ME), "feedback", "t1")))
    await assertSucceeds(getDoc(doc(developer(), "feedback", "t1")))
    await assertFails(getDoc(doc(person(OTHER), "feedback", "t1")))
    await assertFails(getDocs(collection(person(OTHER), "feedback", "t1", "messages")))
    await assertSucceeds(getDocs(query(collection(person(ME), "feedback"), where("uid", "==", ME))))
  })

  it("the developer's first reply is on the ticket; later replies are messages", async () => {
    const dev = developer()
    await assertSucceeds(updateDoc(doc(dev, "feedback", "t1"), { developerReply: "On it", status: "replied", repliedAt: serverTimestamp(), lastFrom: "developer", lastMessageAt: serverTimestamp(), devReplyCount: 1, seenByUser: false }))
    const batch = writeBatch(dev)
    batch.set(doc(collection(dev, "feedback", "t1", "messages")), { from: "developer", text: "Fixed in the next update", createdAt: serverTimestamp() })
    batch.update(doc(dev, "feedback", "t1"), { status: "resolved", lastFrom: "developer", lastMessageAt: serverTimestamp(), devReplyCount: 2, seenByUser: false })
    await assertSucceeds(batch.commit())
  })

  it("the developer can close and reopen a ticket without writing anything", async () => {
    await assertSucceeds(updateDoc(doc(developer(), "feedback", "t1"), { status: "resolved" }))
    await assertSucceeds(updateDoc(doc(developer(), "feedback", "t1"), { status: "open" }))
  })

  it("nobody else can reply as the developer, or touch the developer's fields", async () => {
    await assertFails(updateDoc(doc(person(ME), "feedback", "t1"), { developerReply: "self-praise", status: "replied", repliedAt: serverTimestamp() }))
    await assertFails(updateDoc(doc(person(OTHER), "feedback", "t1"), { status: "resolved" }))
    await assertFails(setDoc(doc(collection(person(ME), "feedback", "t1", "messages")), { from: "developer", text: "fake", createdAt: serverTimestamp() }))
  })

  it("the author can open the reply, and add to an open conversation", async () => {
    await seed((db) => updateDoc(doc(db, "feedback", "t1"), { developerReply: "On it", status: "replied", devReplyCount: 1, seenByUser: false }))
    const db = person(ME)
    await assertSucceeds(updateDoc(doc(db, "feedback", "t1"), { seenByUser: true }))
    const batch = writeBatch(db)
    batch.set(doc(collection(db, "feedback", "t1", "messages")), { from: "user", text: "Still happening", createdAt: serverTimestamp() })
    batch.update(doc(db, "feedback", "t1"), { status: "open", lastFrom: "user", lastMessageAt: serverTimestamp(), messageCount: 1 })
    await assertSucceeds(batch.commit())
  })

  it("the author cannot skip counting, change other fields, or write as someone else", async () => {
    const db = person(ME)
    await assertFails(updateDoc(doc(db, "feedback", "t1"), { status: "open", lastFrom: "user", lastMessageAt: serverTimestamp(), messageCount: 7 }))
    await assertFails(updateDoc(doc(db, "feedback", "t1"), { message: "rewritten" }))
    await assertFails(updateDoc(doc(db, "feedback", "t1"), { devReplyCount: 5 }))
    await assertFails(setDoc(doc(collection(db, "feedback", "t1", "messages")), { from: "developer", text: "x", createdAt: serverTimestamp() }))
    await assertFails(setDoc(doc(collection(person(OTHER), "feedback", "t1", "messages")), { from: "user", text: "x", createdAt: serverTimestamp() }))
  })

  it("messages cannot be edited or deleted", async () => {
    await seed((db) => setDoc(doc(db, "feedback", "t1", "messages", "m1"), { from: "user", text: "hi", createdAt: new Date() }))
    await assertFails(updateDoc(doc(person(ME), "feedback", "t1", "messages", "m1"), { text: "changed" }))
    await assertFails(updateDoc(doc(developer(), "feedback", "t1", "messages", "m1"), { text: "changed" }))
  })

  it("the fix check-in also works when the developer replied without closing, and never on an unanswered ticket", async () => {
    const db = person(ME)
    const fix = () => {
      const batch = writeBatch(db)
      batch.set(doc(collection(db, "feedback", "t1", "messages")), { from: "user", text: "", helpful: true, createdAt: serverTimestamp() })
      batch.update(doc(db, "feedback", "t1"), { fixFeedback: "up", lastFrom: "user", lastMessageAt: serverTimestamp(), messageCount: 1 })
      return batch.commit()
    }
    await assertFails(fix())
    await seed((s) => updateDoc(doc(s, "feedback", "t1"), { developerReply: "Try now", status: "replied", devReplyCount: 1 }))
    await assertSucceeds(fix())
  })

  it("a closed ticket takes no more messages, except one answer about the fix", async () => {
    await seed((db) => updateDoc(doc(db, "feedback", "t1"), { developerReply: "Fixed", status: "resolved", devReplyCount: 1, seenByUser: true }))
    const db = person(ME)
    const talk = writeBatch(db)
    talk.set(doc(collection(db, "feedback", "t1", "messages")), { from: "user", text: "one more thing", createdAt: serverTimestamp() })
    talk.update(doc(db, "feedback", "t1"), { status: "open", lastFrom: "user", lastMessageAt: serverTimestamp(), messageCount: 1 })
    await assertFails(talk.commit())

    const fix = writeBatch(db)
    fix.set(doc(collection(db, "feedback", "t1", "messages")), { from: "user", text: "Works now, thanks", helpful: true, createdAt: serverTimestamp() })
    fix.update(doc(db, "feedback", "t1"), { fixFeedback: "up", lastFrom: "user", lastMessageAt: serverTimestamp(), messageCount: 1 })
    await assertSucceeds(fix.commit())

    await seed((s) => updateDoc(doc(s, "feedback", "t1"), { messageCount: 1 }))
    const again = writeBatch(db)
    again.set(doc(collection(db, "feedback", "t1", "messages")), { from: "user", text: "and again", helpful: false, createdAt: serverTimestamp() })
    again.update(doc(db, "feedback", "t1"), { fixFeedback: "down", lastFrom: "user", lastMessageAt: serverTimestamp(), messageCount: 2 })
    await assertFails(again.commit())
  })
})

describe("what a report may contain, and who may use the rating ids", () => {
  const IMG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ=="

  it("accepts a real compressed screenshot and refuses anything else in that field", async () => {
    await assertSucceeds(newTicket(person(ME), "with-image", { imageData: IMG }))
    await assertFails(newTicket(person(ME), "tracker", { imageData: "https://evil.example/pixel.png" }))
    await assertFails(newTicket(person(ME), "script", { imageData: "data:text/html;base64,PHNjcmlwdD4=" }))
  })

  it("nobody can create someone else's rating id as another kind of ticket, or as an anonymous rating", async () => {
    await assertFails(newTicket(person(OTHER), `rating-${ME}`, { uid: OTHER, kind: "bug" }))
    await assertFails(newTicket(env.unauthenticatedContext().firestore() as unknown as Firestore, `rating-${ME}`, { kind: "rating", uid: null, rating: 5, message: "" }))
    await assertFails(newTicket(person(OTHER), `rating-${ME}`, { uid: OTHER, kind: "rating", rating: 5, message: "" }))
    await assertSucceeds(newTicket(person(ME), `rating-${ME}`, { kind: "rating", rating: 4, message: "" }))
  })
})

describe("profiles and invites", () => {
  it("a profile holds a name and nothing else, and an invite is bounded", async () => {
    const db = person(ME)
    await assertSucceeds(setDoc(doc(db, "users", ME), { name: "Aditya", updatedAt: serverTimestamp() }))
    await assertFails(setDoc(doc(db, "users", ME), { name: "Aditya", updatedAt: serverTimestamp(), blob: "x".repeat(1000) }))
    const invite = (extra: Record<string, unknown>) => setDoc(doc(db, "invites", "tok" + Math.random().toString(36).slice(2)), { owner: ME, ownerName: "Aditya", expiresAt: new Date(Date.now() + 60_000), createdAt: serverTimestamp(), ...extra })
    await assertSucceeds(invite({}))
    await assertFails(invite({ ownerName: "x".repeat(500) }))
    await assertFails(invite({ junk: "x".repeat(1000) }))
  })
})
