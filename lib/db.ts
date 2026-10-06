/**
 * The device's working copy of the app's data lives in IndexedDB (far larger than localStorage, and it can hold
 * restore points and the sync base next to the data). Small flags and settings stay in localStorage.
 *
 * Every call degrades to localStorage when IndexedDB is unavailable (some private modes), so the app keeps working.
 * Data is never removed from localStorage until the same value has been written to and read back from IndexedDB.
 */
const DB_NAME = "college-tracker"
const STORE = "kv"

let opening: Promise<IDBDatabase | null> | null = null

function open(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") return Promise.resolve(null)
  if (!opening) {
    opening = new Promise((resolve) => {
      try {
        const req = indexedDB.open(DB_NAME, 1)
        req.onupgradeneeded = () => req.result.createObjectStore(STORE)
        req.onsuccess = () => resolve(req.result)
        req.onerror = () => resolve(null)
        req.onblocked = () => resolve(null)
      } catch {
        resolve(null)
      }
    })
  }
  return opening
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const req = fn(tx.objectStore(STORE))
    tx.oncomplete = () => resolve(req.result as T)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

const ls = {
  get(key: string): unknown {
    try {
      const raw = localStorage.getItem(key)
      return raw === null ? undefined : JSON.parse(raw)
    } catch {
      return undefined
    }
  },
  set(key: string, value: unknown) {
    localStorage.setItem(key, JSON.stringify(value))
  },
  del(key: string) {
    try {
      localStorage.removeItem(key)
    } catch {
      /* ignore */
    }
  },
}

/** Saves a value. Falls back to localStorage if IndexedDB fails, so a write is never silently dropped. */
export async function dbSet(key: string, value: unknown): Promise<void> {
  const db = await open()
  if (db) {
    try {
      await run(db, "readwrite", (s) => s.put(value, key))
      return
    } catch {
      /* fall through to localStorage */
    }
  }
  try {
    ls.set(key, value)
  } catch {
    /* storage full: nothing more can be done here */
  }
}

/**
 * Reads a value. A value that still lives in localStorage (from before IndexedDB) is moved over first:
 * copied, read back and checked, and only then removed from localStorage.
 */
export async function dbGet<T>(key: string): Promise<T | undefined> {
  const db = await open()
  if (db) {
    try {
      const found = await run<T | undefined>(db, "readonly", (s) => s.get(key))
      if (found !== undefined) return found
      const legacy = ls.get(key)
      if (legacy === undefined) return undefined
      await run(db, "readwrite", (s) => s.put(legacy, key))
      const check = await run<unknown>(db, "readonly", (s) => s.get(key))
      if (JSON.stringify(check) === JSON.stringify(legacy)) ls.del(key)
      return legacy as T
    } catch {
      /* fall through to localStorage */
    }
  }
  return ls.get(key) as T | undefined
}

export async function dbDel(key: string): Promise<void> {
  const db = await open()
  if (db) {
    try {
      await run(db, "readwrite", (s) => s.delete(key))
    } catch {
      /* ignore */
    }
  }
  ls.del(key)
}

/** Asks the browser not to evict this site's storage when the device runs low on space */
export async function protectStorage(): Promise<void> {
  try {
    await navigator.storage?.persist?.()
  } catch {
    /* not supported */
  }
}
