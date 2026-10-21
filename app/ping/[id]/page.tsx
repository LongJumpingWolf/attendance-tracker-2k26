import type { Metadata } from "next"
import SharePingPage from "@/components/share-ping-page"

export const metadata: Metadata = {
  title: "Attendance Ping",
  description: "Respond to an attendance confirmation request.",
  robots: { index: false, follow: false, noarchive: true },
  referrer: "no-referrer",
}

export default async function PingResponseRoute({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return <SharePingPage pingId={id} />
}
