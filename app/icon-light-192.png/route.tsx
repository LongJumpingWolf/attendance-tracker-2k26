import { ImageResponse } from "next/og"

export const runtime = "edge"
export const contentType = "image/png"
export const size = { width: 192, height: 192 }

export async function GET() {
  return new ImageResponse(
    (
      <div style={{ width: "192px", height: "192px", display: "flex", position: "relative", overflow: "hidden", background: "#f5f7fb" }}>
      <div style={{ width: "512px", height: "512px", display: "flex", position: "relative", overflow: "hidden", borderRadius: 108, transform: "scale(0.375)", transformOrigin: "top left", background: "linear-gradient(145deg, #ffffff 0%, #f4f7fb 100%)" }}>
        <div style={{ position: "absolute", left: 70, top: 88, width: 372, height: 346, borderRadius: 45, background: "linear-gradient(160deg, #174b89 0%, #06234b 100%)" }} />
        <div style={{ position: "absolute", left: 134, top: 52, width: 36, height: 106, borderRadius: 18, background: "linear-gradient(160deg, #174b89, #06234b)", boxShadow: "0 0 0 8px white" }} />
        <div style={{ position: "absolute", left: 337, top: 52, width: 36, height: 106, borderRadius: 18, background: "linear-gradient(160deg, #174b89, #06234b)", boxShadow: "0 0 0 8px white" }} />
        <div style={{ position: "absolute", left: 94, top: 174, width: 324, height: 232, borderRadius: 26, background: "#ffffff" }} />
        <div style={{ position: "absolute", left: 118, top: 198, width: 58, height: 54, borderRadius: 11, background: "#d7e2f1" }} />
        <div style={{ position: "absolute", left: 187, top: 198, width: 58, height: 54, borderRadius: 11, background: "linear-gradient(145deg, #27b6fa, #087cff)" }} />
        <div style={{ position: "absolute", left: 256, top: 198, width: 58, height: 54, borderRadius: 11, background: "linear-gradient(145deg, #9be8ce, #44c7a4)" }} />
        <div style={{ position: "absolute", left: 325, top: 198, width: 58, height: 54, borderRadius: 11, background: "#d7e2f1" }} />
        <div style={{ position: "absolute", left: 118, top: 266, width: 58, height: 54, borderRadius: 11, background: "#d7e2f1" }} />
        <div style={{ position: "absolute", left: 187, top: 266, width: 58, height: 54, borderRadius: 11, background: "#d7e2f1" }} />
        <div style={{ position: "absolute", left: 256, top: 266, width: 58, height: 54, borderRadius: 11, background: "#ffb18d" }} />
        <div style={{ position: "absolute", left: 325, top: 266, width: 58, height: 54, borderRadius: 11, background: "#d7e2f1" }} />
        <svg width="512" height="512" viewBox="0 0 512 512" style={{ position: "absolute", left: 0, top: 0 }}>
          <path d="M61 397 177 281 250 345 392 174" fill="none" stroke="#ffffff" strokeWidth="43" strokeLinecap="round" strokeLinejoin="round"/>
          <path d="M61 397 177 281 250 345 392 174" fill="none" stroke="#087cff" strokeWidth="27" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </div>
      </div>
    ),
    { width: 192, height: 192 },
  )
}
