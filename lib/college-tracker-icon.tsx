import React from "react"

type IconMode = "light" | "dark"

export function CollegeTrackerIcon({ size, mode = "light" }: { size: number; mode?: IconMode }) {
  const colors = mode === "dark"
    ? { background: "#101D32", navy: "#174B89", grid: "#405775", paper: "#1B2B43", blue: "#2997FF", mint: "#61D4B1" }
    : { background: "#F5F7FB", navy: "#0B2A52", grid: "#D5E1F0", paper: "#FFFFFF", blue: "#087CFF", mint: "#61D4B1" }

  return (
    <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 180 180">
      <rect x="0" y="0" width="180" height="180" fill={colors.background} />
      <rect x="24" y="30" width="132" height="125" rx="17" fill={colors.navy} />
      <rect x="47" y="18" width="13" height="36" rx="6.5" fill={colors.navy} />
      <rect x="119" y="18" width="13" height="36" rx="6.5" fill={colors.navy} />
      <rect x="34" y="61" width="112" height="85" rx="10" fill={colors.paper} />
      <path d="M44 77 H136 M44 101 H136 M44 125 H136 M68 68 V137 M91 68 V137 M114 68 V137" stroke={colors.grid} strokeWidth="3" strokeLinecap="round" />
      <rect x="72" y="79" width="18" height="18" rx="3" fill={colors.blue} />
      <rect x="95" y="103" width="18" height="18" rx="3" fill={colors.mint} />
      <path d="M18 143 L60 102 L84 124 L141 67" fill="none" stroke={colors.paper} strokeWidth="16" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M18 143 L60 102 L84 124 L141 67" fill="none" stroke={colors.blue} strokeWidth="10" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
