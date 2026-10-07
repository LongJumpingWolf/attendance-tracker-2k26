/**
 * A small in-memory stand-in for the parts of firebase/firestore the adapter uses. It exists to check WHAT the adapter
 * sends and how it reacts (payload shapes, transactions, listeners, error codes) without a network or the emulator.
 * It does not enforce security rules: those are tested by tests/rules (Firestore emulator) and supabase/tests.
 */
export type Data = Record<string, unknown>

export class FakeTs {
  constructor(readonly ms: number) {}
  toMillis() {
    return this.ms
  }
  static fromMillis(ms: number) {
    return new FakeTs(ms)
  }
}

const SERVER = { __serverTimestamp: true }

export const state = {
  docs: new Map<string, Data>(),
  /** Every write, in order, exactly as the adapter sent it (server-timestamp sentinels left in place) */
  writes: [] as { op: string; path: string; data?: Data }[],
  now: 1_790_000_000_000,
  auto: 0,
  /** Make the next call of this operation fail with a Firestore-style code */
  failNext: new Map<string, string>(),
  listeners: new Set<() => void>(),
  /** detached listeners are removed from this set; this counts how many were ever attached */
  attached: 0,
}

export function reset() {
  state.docs.clear()
  state.writes.length = 0
  state.failNext.clear()
  state.listeners.clear()
  state.auto = 0
  state.attached = 0
}

const fail = (op: string) => {
  const code = state.failNext.get(op)
  if (code) {
    state.failNext.delete(op)
    throw Object.assign(new Error(`${op} failed: ${code}`), { code })
  }
}

const resolve = (d: Data): Data => {
  const out: Data = {}
  for (const [k, v] of Object.entries(d)) out[k] = v === SERVER ? new FakeTs(state.now) : v
  return out
}
const notify = () => state.listeners.forEach((l) => l())

export const doc = (_db: unknown, col: string, id: string) => ({ kind: "doc" as const, col, id, path: `${col}/${id}` })
export const collection = (_db: unknown, col: string) => ({ kind: "col" as const, col })
export const where = (field: string, op: string, value: unknown) => ({ field, op, value })
export const query = (c: { col: string }, ...wheres: ReturnType<typeof where>[]) => ({ kind: "query" as const, col: c.col, wheres })
export const serverTimestamp = () => SERVER
export const Timestamp = FakeTs

const snapOf = (path: string) => ({
  id: path.split("/")[1],
  exists: () => state.docs.has(path),
  data: () => (state.docs.has(path) ? { ...state.docs.get(path)! } : undefined),
})

export async function getDoc(ref: { path: string }) {
  fail("getDoc")
  return snapOf(ref.path)
}

export async function setDoc(ref: { path: string }, data: Data) {
  fail("setDoc")
  state.writes.push({ op: "setDoc", path: ref.path, data })
  state.docs.set(ref.path, resolve(data))
  notify()
}

export async function addDoc(c: { col: string }, data: Data) {
  fail("addDoc")
  const id = `auto${++state.auto}`
  state.writes.push({ op: "addDoc", path: `${c.col}/${id}`, data })
  state.docs.set(`${c.col}/${id}`, resolve(data))
  notify()
  return { id }
}

export async function updateDoc(ref: { path: string }, data: Data) {
  fail("updateDoc")
  if (!state.docs.has(ref.path)) throw Object.assign(new Error("not found"), { code: "not-found" })
  state.writes.push({ op: "updateDoc", path: ref.path, data })
  state.docs.set(ref.path, { ...state.docs.get(ref.path)!, ...resolve(data) })
  notify()
}

export async function deleteDoc(ref: { path: string }) {
  fail("deleteDoc")
  state.writes.push({ op: "deleteDoc", path: ref.path })
  state.docs.delete(ref.path)
  notify()
}

const matching = (q: ReturnType<typeof query>) =>
  [...state.docs.entries()].filter(([path, d]) => {
    if (!path.startsWith(`${q.col}/`)) return false
    return q.wheres.every((w) => w.op === "array-contains" && Array.isArray(d[w.field]) && (d[w.field] as unknown[]).includes(w.value))
  })

export async function getDocs(q: ReturnType<typeof query>) {
  fail("getDocs")
  return { docs: matching(q).map(([path]) => snapOf(path)) }
}

export async function runTransaction<T>(_db: unknown, fn: (tx: unknown) => Promise<T>): Promise<T> {
  fail("runTransaction")
  const pending: (() => void)[] = []
  const tx = {
    get: async (ref: { path: string }) => snapOf(ref.path),
    set: (ref: { path: string }, data: Data) => {
      state.writes.push({ op: "tx.set", path: ref.path, data })
      pending.push(() => state.docs.set(ref.path, resolve(data)))
    },
    update: (ref: { path: string }, data: Data) => {
      state.writes.push({ op: "tx.update", path: ref.path, data })
      pending.push(() => state.docs.set(ref.path, { ...state.docs.get(ref.path)!, ...resolve(data) }))
    },
  }
  const out = await fn(tx)
  pending.forEach((p) => p())
  notify()
  return out
}

/** Calls `next` now (the current state) and again after every write. `failNext` "onSnapshot" calls `error` instead. */
export function onSnapshot(target: { kind: string; path?: string } & Record<string, unknown>, next: (s: unknown) => void, error?: (e: unknown) => void) {
  const code = state.failNext.get("onSnapshot")
  if (code) {
    state.failNext.delete("onSnapshot")
    queueMicrotask(() => error?.(Object.assign(new Error(code), { code })))
    return () => {}
  }
  state.attached++
  const emit = () => {
    if (target.kind === "doc") next(snapOf(target.path as string))
    else next({ docs: matching(target as unknown as ReturnType<typeof query>).map(([path]) => snapOf(path)) })
  }
  state.listeners.add(emit)
  emit()
  return () => state.listeners.delete(emit)
}

export const getFirestore = () => ({})

export const api = { getFirestore, doc, collection, where, query, serverTimestamp, Timestamp, getDoc, setDoc, addDoc, updateDoc, deleteDoc, getDocs, runTransaction, onSnapshot }
