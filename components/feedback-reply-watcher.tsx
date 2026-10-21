"use client"

import { useEffect, useRef } from "react"
import { getAuth, onAuthStateChanged } from "firebase/auth"
import { collection, limit, onSnapshot, query, updateDoc, where } from "firebase/firestore"
import { app, db, firebaseConfigured } from "@/lib/firebase"

export default function FeedbackReplyWatcher({ onReply }: { onReply: (reply: string) => void }) {
  const onReplyRef = useRef(onReply)
  useEffect(() => { onReplyRef.current = onReply }, [onReply])
  useEffect(() => {
    if (!firebaseConfigured()) return
    const auth = getAuth(app)
    let stopFeedback: (() => void) | undefined
    const handledIds = new Set<string>()
    const stopAuth = onAuthStateChanged(auth, user => {
      stopFeedback?.()
      stopFeedback = undefined
      if (!user || user.isAnonymous) return
      // Real-time listener: a developer reply appears without the user needing to refresh. The Firestore rule only
      // permits this query to read documents belonging to this authenticated UID.
      const own = query(collection(db, "feedback"), where("uid", "==", user.uid), limit(50))
      stopFeedback = onSnapshot(own, snapshot => {
        for (const entry of snapshot.docs) {
          const data = entry.data()
          const reply = typeof data.developerReply === "string" ? data.developerReply.trim() : ""
          if (!reply || data.seenByUser === true || handledIds.has(entry.id) || !["replied", "resolved"].includes(String(data.status))) continue
          handledIds.add(entry.id)
          void updateDoc(entry.ref, { seenByUser: true }).then(() => onReplyRef.current(reply)).catch(() => { handledIds.delete(entry.id) })
        }
      }, () => {})
    })
    return () => { stopAuth(); stopFeedback?.() }
  }, [])
  return null
}
