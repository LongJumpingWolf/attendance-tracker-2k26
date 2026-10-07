"use client"

import { useCallback, useEffect, useRef } from "react"
import type { Ping } from "./types"
import { LEASE_MS } from "./ping-server"
import { processAnswered, type ProcessDeps } from "./ping-processing"

const RETRY_FIRST = 15_000
const RETRY_MAX = 300_000

/**
 * Applies the answers to Pings you sent, one at a time, safely (see lib/ping-processing.ts). Runs when an answer arrives,
 * when the app opens with an answer still waiting (this is how a crash is recovered), and when the connection returns.
 * Anything that couldn't finish is tried again later; a lease held by your other device is tried again after it runs out.
 */
export function usePingProcessing({ pings, enabled, deps }: { pings: Ping[]; enabled: boolean; deps: ProcessDeps }) {
  const pingsRef = useRef(pings)
  pingsRef.current = pings
  const depsRef = useRef(deps)
  depsRef.current = deps
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const wait = useRef(RETRY_FIRST)

  const run = useCallback(async () => {
    if (!enabledRef.current) return
    let again: number | null = null
    for (const p of pingsRef.current.filter((x) => x.status === "answered")) {
      const r = await processAnswered(p, depsRef.current)
      if (r === "not-leased") again = Math.max(again ?? 0, LEASE_MS + 10_000)
      else if (r !== "processed" && r !== "busy") again = Math.max(again ?? 0, wait.current)
    }
    clearTimeout(timer.current)
    if (again) {
      timer.current = setTimeout(() => void run(), again)
      wait.current = Math.min(wait.current * 2, RETRY_MAX)
    } else wait.current = RETRY_FIRST
  }, [])

  const waiting = pings.filter((p) => p.status === "answered").map((p) => p.id).join(",")
  useEffect(() => {
    if (enabled && waiting) void run()
  }, [enabled, waiting, run])

  useEffect(() => {
    const onOnline = () => void run()
    window.addEventListener("online", onOnline)
    return () => {
      window.removeEventListener("online", onOnline)
      clearTimeout(timer.current)
    }
  }, [run])
}
