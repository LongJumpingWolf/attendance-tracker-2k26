import { ImageResponse } from "next/og"
import { CollegeTrackerIcon } from "@/lib/college-tracker-icon"

export const runtime = "edge"
export const contentType = "image/png"
export const size = { width: 180, height: 180 }

export async function GET() {
  return new ImageResponse(
    <CollegeTrackerIcon size={180} mode="light" />,
    { width: 180, height: 180 },
  )
}
