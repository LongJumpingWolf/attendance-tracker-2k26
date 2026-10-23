import { ImageResponse } from "next/og"
import { CollegeTrackerIcon } from "@/lib/college-tracker-icon"

export const runtime = "edge"
export const contentType = "image/png"
export const size = { width: 192, height: 192 }

export async function GET() {
  return new ImageResponse(
    <CollegeTrackerIcon size={192} mode="light" />,
    { width: 192, height: 192 },
  )
}
