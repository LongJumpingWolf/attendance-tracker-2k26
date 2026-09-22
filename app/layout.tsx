import type React from "react"
import type { Metadata, Viewport } from "next"
import { Inter } from "next/font/google"
import "./globals.css"
import ThemeSync from "@/components/theme-sync"

// Apple-style sans. Apple devices use SF Pro through the system stack (see globals.css);
// everywhere else falls back to Inter, which is the closest match.
const inter = Inter({ subsets: ["latin"], variable: "--nf-inter", display: "swap" })

export const metadata: Metadata = {
  title: "College Tracker",
  description: "College Tracker - attendance and deadline tracker",
  generator: "v0.app",
  manifest: "/manifest.json",
  icons: { icon: "/favicon-512.png", apple: "/favicon-192.png" },
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "College Tracker",
  },
  formatDetection: {
    telephone: false,
  },
}

// Pinch-zoom stays available (people who need larger text rely on it). viewportFit "cover" lets the app draw under
// notches and rounded corners, and the layout pads itself with env(safe-area-inset-*). On-screen keyboards shrink the
// layout instead of covering it, so sheets and their buttons stay visible.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  interactiveWidget: "resizes-content",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f2f2f7" },
    { media: "(prefers-color-scheme: dark)", color: "#000000" },
  ],
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        {/* Applies the saved (or system) theme before the first paint so there is no white flash */}
        <script
          dangerouslySetInnerHTML={{
            __html:
              "(function(){try{var t=localStorage.getItem('theme');var d=t==='dark'||((t===null||t==='system')&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark')}catch(e){}})()",
          }}
        />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </head>
      <body className="antialiased" suppressHydrationWarning>
        <ThemeSync />
        {children}
      </body>
    </html>
  )
}
