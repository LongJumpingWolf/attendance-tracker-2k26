"use client"

interface ProgressRingProps {
  pct: number
  color: string
  size?: number
  /** Percentage to mark on the ring as the requirement */
  requirement?: number
}

/** A thin ring with rounded ends and a tick at the required percentage. */
export default function ProgressRing({ pct, color, size = 160, requirement }: ProgressRingProps) {
  const r = 52
  const c = 2 * Math.PI * r
  const clamped = Math.min(100, Math.max(0, pct))
  const a = requirement !== undefined ? (requirement / 100) * 2 * Math.PI - Math.PI / 2 : null

  return (
    <div className="relative inline-flex items-center justify-center flex-shrink-0" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 120 120" className="-rotate-90" aria-hidden>
        <circle cx="60" cy="60" r={r} fill="none" stroke="currentColor" strokeOpacity={0.1} strokeWidth="9" />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke={color}
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c - (clamped / 100) * c}
          className="transition-all duration-700 ease-out"
        />
      </svg>
      {a !== null && requirement! > 0 && requirement! < 100 && (
        <svg width={size} height={size} viewBox="0 0 120 120" className="absolute inset-0" aria-hidden>
          <line
            x1={60 + 46 * Math.cos(a)}
            y1={60 + 46 * Math.sin(a)}
            x2={60 + 58 * Math.cos(a)}
            y2={60 + 58 * Math.sin(a)}
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
          />
        </svg>
      )}
      <span className="absolute font-bold tracking-tight leading-none num" style={{ fontSize: size * 0.28 }}>
        {pct}
        <span className="text-mute font-semibold" style={{ fontSize: size * 0.13 }}>
          %
        </span>
      </span>
    </div>
  )
}
