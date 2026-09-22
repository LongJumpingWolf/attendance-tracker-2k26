/**
 * The signed-in account that synced data belongs to. Sign-in is with Google through Firebase. The app already gives
 * every browser an anonymous Firebase account for friend connections; signing in with Google upgrades that same
 * account (so friends stay connected), or, in a browser that has never signed in, switches to the Google account
 * you already have. Until Firebase keys exist, development builds offer a test sign-in instead.
 */
import {
  getAuth,
  getRedirectResult,
  GoogleAuthProvider,
  linkWithPopup,
  linkWithRedirect,
  onAuthStateChanged,
  signInWithCredential,
  signInWithPopup,
  signInWithRedirect,
  signOut,
  type AuthCredential,
} from "firebase/auth"
import { app } from "./firebase"
import { cloudKind } from "./cloud-sync"

export interface Account {
  /** Stable id the synced data is stored under */
  id: string
  email: string
  name: string
}

const DEV_KEY = "devAccount"
const DEV_EVENT = "devaccountchange"

const readDev = (): Account | null => {
  try {
    const raw = localStorage.getItem(DEV_KEY)
    return raw ? (JSON.parse(raw) as Account) : null
  } catch {
    return null
  }
}

/** Calls back now and whenever the signed-in account changes (null when nobody is signed in) */
export function watchAccount(cb: (account: Account | null) => void): () => void {
  if (cloudKind() === "dev") {
    const emit = () => cb(readDev())
    emit()
    window.addEventListener(DEV_EVENT, emit)
    return () => window.removeEventListener(DEV_EVENT, emit)
  }
  if (cloudKind() === "none") {
    cb(null)
    return () => {}
  }
  const auth = getAuth(app)
  // Coming back from a redirect sign-in (used when a pop-up is not allowed)
  // A failed or interrupted redirect must never surface as an unhandled error
  void getRedirectResult(auth).catch((e) => finishExisting(e).catch(() => {}))
  return onAuthStateChanged(auth, (u) =>
    cb(u && !u.isAnonymous ? { id: u.uid, email: u.email ?? "", name: u.displayName ?? u.email ?? "You" } : null),
  )
}

/** The Google account already belongs to another Firebase account: sign in as that one instead */
async function finishExisting(e: unknown) {
  const cred: AuthCredential | null = GoogleAuthProvider.credentialFromError(e as never)
  if (cred) await signInWithCredential(getAuth(app), cred)
  else throw e
}

/** Returns an error message, or null on success */
export async function signInWithGoogle(): Promise<string | null> {
  const auth = getAuth(app)
  const provider = new GoogleAuthProvider()
  const anon = auth.currentUser?.isAnonymous ? auth.currentUser : null
  const attempt = async (redirect: boolean) => {
    if (anon) return redirect ? linkWithRedirect(anon, provider) : linkWithPopup(anon, provider)
    return redirect ? signInWithRedirect(auth, provider) : signInWithPopup(auth, provider)
  }
  try {
    try {
      await attempt(false)
    } catch (e) {
      const code = (e as { code?: string }).code
      if (code === "auth/popup-blocked" || code === "auth/operation-not-supported-in-this-environment") await attempt(true)
      else if (code === "auth/credential-already-in-use") await finishExisting(e)
      else throw e
    }
    return null
  } catch (e) {
    const code = (e as { code?: string }).code ?? ""
    if (code === "auth/popup-closed-by-user" || code === "auth/cancelled-popup-request") return "Sign-in was cancelled."
    if (code === "auth/unauthorized-domain")
      return "This address isn’t allowed to sign in yet. Add it under Authentication > Settings > Authorized domains in the Firebase console."
    if (code === "auth/operation-not-allowed") return "Google sign-in isn’t switched on in the Firebase console yet (Authentication > Sign-in method)."
    return "Google sign-in didn’t work here. If this is a scanner app’s built-in browser, open the link in Safari or Chrome."
  }
}

/** Development only: a stand-in account so the sync flow can be tried before Firebase is set up */
export function signInDev(email: string) {
  const clean = email.trim().toLowerCase()
  const id = clean.replace(/[^a-z0-9]/g, "_").slice(0, 80)
  localStorage.setItem(DEV_KEY, JSON.stringify({ id, email: clean, name: clean.split("@")[0] } satisfies Account))
  window.dispatchEvent(new Event(DEV_EVENT))
}

export async function signOutAccount() {
  if (cloudKind() === "dev") {
    localStorage.removeItem(DEV_KEY)
    window.dispatchEvent(new Event(DEV_EVENT))
    return
  }
  await signOut(getAuth(app))
}
