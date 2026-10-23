import type React from "react"
import type { Metadata, Viewport } from "next"
import { Inter } from "next/font/google"
import "./globals.css"
import ThemeSync from "@/components/theme-sync"
import OfflineShell from "@/components/offline-shell"

// Apple-style sans. Apple devices use SF Pro through the system stack (see globals.css);
// everywhere else falls back to Inter, which is the closest match.
const inter = Inter({ subsets: ["latin"], variable: "--nf-inter", display: "swap" })

export const metadata: Metadata = {
  metadataBase: new URL("https://attendance-tracker-2k26.vercel.app"),
  title: "College Tracker",
  description: "College Tracker - attendance and deadline tracker",
  openGraph: {
    type: "website",
    url: "https://attendance-tracker-2k26.vercel.app/",
    siteName: "College Tracker",
    title: "College Tracker",
    description: "College Tracker - attendance and deadline tracker",
    images: [
      {
        url: "https://attendance-tracker-2k26.vercel.app/favicon-512.png",
        width: 512,
        height: 512,
        alt: "College Tracker app icon",
      },
    ],
  },
  twitter: {
    card: "summary",
    title: "College Tracker",
    description: "College Tracker - attendance and deadline tracker",
    images: ["https://attendance-tracker-2k26.vercel.app/favicon-512.png"],
  },
  generator: "v0.app",
  manifest: "/manifest.json?v=6",
  icons: {
    icon: [
      { url: "/favicon.ico?v=6", type: "image/x-icon" },
      { url: "/favicon-32x32-v6.png", type: "image/png", sizes: "32x32" },
      { url: "/favicon-dark-32x32-v6.png", type: "image/png", sizes: "32x32", media: "(prefers-color-scheme: dark)" },
    ],
    apple: [{ url: "/college-tracker-apple-touch-icon-v6.png", type: "image/png", sizes: "180x180" }],
  },
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
              "(function(){try{var t=localStorage.getItem('theme');var d=t==='dark'||(t==='system'&&window.matchMedia('(prefers-color-scheme: dark)').matches);if(d)document.documentElement.classList.add('dark')}catch(e){}})()",
          }}
        />
        <meta name="mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
      </head>
      <body className="antialiased" suppressHydrationWarning>
        <ThemeSync />
        <OfflineShell />
        {children}
      </body>
    </html>
  )
}
