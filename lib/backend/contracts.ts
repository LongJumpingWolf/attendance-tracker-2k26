/**
 * What the app needs from a backend, as plain values. No Firebase type, no Firestore snapshot or Timestamp, no Supabase
 * type appears here: timestamps are milliseconds (or null while unknown), and failures are BackendError.
 *
 * Domain code (hooks, sync orchestration, Ping flow) talks to these interfaces only. Which implementation answers is
 * decided in one place (lib/backend/index.ts).
 *
 * Authentication is NOT part of these contracts. Who the caller is stays with Firebase Auth for now.
 */
import type { FriendRequest, Ping, PingItem } from "../types"

/** Stops a subscription. Safe to call more than once. */
export type Unsubscribe = () => void

/**
 * A live subscription: the current state first, then every change. `onState` says whether the feed is running, and
 * carries the error when it stopped; an adapter restarts a dead feed on its own (a reconnect shows as live=false, then
 * live=true). A subscription never throws into the caller.
 */
export interface Subscription<T> {
  onData: (value: T) => void
  onState?: (live: boolean, error?: unknown) => void
}

// ---- sync ---------------------------------------------------------------------------------------------------------

/** The stored copy exactly as kept (the packed text), and its version */
export interface StoredSync {
  data: string
  /** Counts up by one on every write. A write only lands if the sender has seen the latest one. */
  rev: number
  updatedAt: number
}

export type StorePutResult = { ok: true; rev: number } | { ok: false; reason: "conflict" }

export interface CloudSyncStore {
  /** null when nothing is stored yet */
  get(owner: string): Promise<StoredSync | null>
  /** Compare-and-set: lands only if the stored rev is `expectedRev` (null = nothing stored yet). Throws BackendError when it cannot reach the backend. */
  put(owner: string, data: string, expectedRev: number | null): Promise<StorePutResult>
  /** The one stored copy of this account, whenever another device changes it */
  watch(owner: string, sub: Subscription<StoredSync>): Unsubscribe
}

// ---- profiles -----------------------------------------------------------------------------------------------------

export interface ProfileStore {
  save(uid: string, name: string): Promise<void>
  /** null when there is no profile */
  getName(uid: string): Promise<string | null>
  /**
   * The ids of the accounts that have a profile, at most `max`, for the developer dashboard's account count. Ids only: no name is
   * returned. Optional: a backend that cannot list returns nothing here, and the dashboard says so.
   */
  listIds?(max: number): Promise<{ ids: string[]; truncated: boolean }>
}

// ---- invites ------------------------------------------------------------------------------------------------------

export interface InviteInfo {
  owner: string
  ownerName: string
  expired: boolean
  expiresAt: number
}

export interface InviteStore {
  create(uid: string, name: string, minutes: number): Promise<{ token: string; expiresAt: number }>
  read(token: string): Promise<InviteInfo | null>
  remove(token: string): Promise<void>
}

// ---- connections --------------------------------------------------------------------------------------------------

export interface ConnectionStore {
  /** Every request that involves this account, live */
  watch(uid: string, sub: Subscription<FriendRequest[]>): Unsubscribe
  /** One-off read of the same list */
  list(uid: string): Promise<FriendRequest[]>
  /** The id of the new request */
  send(me: { uid: string; name: string }, to: { uid: string; name: string }): Promise<string>
  respond(id: string, status: "accepted" | "declined"): Promise<void>
  remove(id: string): Promise<void>
}

// ---- pings --------------------------------------------------------------------------------------------------------

/** How long a device may hold an answer while it applies it. The server enforces this with its own clock. */
export const LEASE_MS = 2 * 60_000

export interface NewPing {
  /** Chosen by the app, once per logical Ping, so retrying can never make a second one */
  id: string
  from: { uid: string; name: string }
  to: { uid: string; name: string }
  /** The class day, YYYY-MM-DD */
  date: string
  items: PingItem[]
  /** The accepted connection between the two people */
  requestId: string
}

export interface PingStore {
  /** Every Ping that involves this account, live */
  watch(uid: string, sub: Subscription<Ping[]>): Unsubscribe
  /** "existing" when the same request was already stored (a retry): still exactly one Ping */
  create(p: NewPing): Promise<"created" | "existing">
  answer(id: string, items: PingItem[]): Promise<void>
  /** True when this device now holds the lease on the answer */
  lease(id: string, deviceId: string, now?: number): Promise<boolean>
  finalize(id: string): Promise<"processed" | "already">
  remove(id: string): Promise<void>
}

// ---- push tokens --------------------------------------------------------------------------------------------------

export interface PushTokenStore {
  save(uid: string, token: string): Promise<void>
  remove(uid: string): Promise<void>
}

// ---- the set -------------------------------------------------------------------------------------------------------

export type BackendKind = "firebase" | "supabase"

/**
 * Supabase Realtime only delivers events after `realtime.setAuth(token)` with the Firebase token, and again every time the
 * token changes (PHASE5_AUTH_SPIKE.md: without it every event arrives as "401 Unauthorized"). A backend that needs this
 * implements it; the Firebase adapter does not (Firebase Auth is attached to the Firestore SDK by itself), so it has none.
 */
export interface RealtimeAuth {
  /** The current Firebase token, or null after sign-out */
  setToken(token: string | null): void
}

/** The stores of one backend. A bag of focused interfaces, not one service object. */
export interface Backend {
  readonly kind: BackendKind
  readonly sync: CloudSyncStore
  readonly profiles: ProfileStore
  readonly invites: InviteStore
  readonly connections: ConnectionStore
  readonly pings: PingStore
  readonly pushTokens: PushTokenStore
  /** Optional: only backends whose realtime needs an explicit token */
  readonly realtimeAuth?: RealtimeAuth
}
