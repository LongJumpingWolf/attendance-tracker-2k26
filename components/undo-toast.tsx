"use client"

import { useEffect } from "react"

export interface ToastState {
  id: number
  message: string
  undo?: () => void
}

interface UndoToastProps {
  toast: ToastState | null
  onClose: () => void
}

export default function UndoToast({ toast, onClose }: UndoToastProps) {
  useEffect(() => {
    if (!toast) return
    const t = setTimeout(onClose, 4500)
    return () => clearTimeout(t)
  }, [toast, onClose])

  if (!toast) return null

  return (
    <div
      role="status"
      aria-live="polite"
      className="animate-sheet fixed left-1/2 -translate-x-1/2 z-50 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] w-[calc(100%-2.5rem)] max-w-sm lg:bottom-8 lg:left-[calc(50%+44px)]"
    >
      <div className="flex items-center justify-between gap-3 rounded-2xl bg-ink/90 text-paper backdrop-blur-xl pl-4 pr-2 py-2 shadow-lg shadow-black/40">
        <span className="text-[15px] font-medium truncate">{toast.message}</span>
        {toast.undo && (
          <button
            onClick={() => {
              toast.undo?.()
              onClose()
            }}
            className="h-9 px-3 rounded-xl text-[15px] font-semibold text-paper"
          >
            Undo
          </button>
        )}
      </div>
    </div>
  )
}
