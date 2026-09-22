"use client"

/**
 * Icon pack: Phosphor. Older modals import lucide-style names from here so the
 * whole app shares one icon family. Prefer importing from "@phosphor-icons/react"
 * directly in new code.
 */
import type { IconProps } from "@phosphor-icons/react"
import {
  X as PhX,
  CaretLeft,
  CaretRight,
  CaretUp,
  CaretDown,
  Eye as PhEye,
  EyeSlash,
  Bell as PhBell,
  BellSlash,
  Clock as PhClock,
  Trash,
  DownloadSimple,
  UploadSimple,
  SlidersHorizontal,
} from "@phosphor-icons/react"

export const X = (p: IconProps) => <PhX weight="bold" {...p} />
export const ChevronLeft = (p: IconProps) => <CaretLeft weight="bold" {...p} />
export const ChevronRight = (p: IconProps) => <CaretRight weight="bold" {...p} />
export const ChevronUp = (p: IconProps) => <CaretUp weight="bold" {...p} />
export const ChevronDown = (p: IconProps) => <CaretDown weight="bold" {...p} />
export const Eye = (p: IconProps) => <PhEye weight="duotone" {...p} />
export const EyeOff = (p: IconProps) => <EyeSlash weight="duotone" {...p} />
export const Bell = (p: IconProps) => <PhBell weight="duotone" {...p} />
export const BellOff = (p: IconProps) => <BellSlash weight="duotone" {...p} />
export const Clock = (p: IconProps) => <PhClock weight="duotone" {...p} />
export const Trash2 = (p: IconProps) => <Trash weight="duotone" {...p} />
export const Download = (p: IconProps) => <DownloadSimple weight="bold" {...p} />
export const Upload = (p: IconProps) => <UploadSimple weight="bold" {...p} />
export const Settings2 = (p: IconProps) => <SlidersHorizontal weight="duotone" {...p} />
