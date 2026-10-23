import { ImageResponse } from "next/og"
import { CollegeTrackerIcon } from "@/lib/college-tracker-icon"

export const runtime = "edge"
export const contentType = "image/png"
export const size = { width: 512, height: 512 }

export async function GET() {
  return new ImageResponse(
    <CollegeTrackerIcon size={512} mode="dark" />,
    { width: 512, height: 512 },
  )
}
