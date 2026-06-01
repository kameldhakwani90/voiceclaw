import { Suspense } from "react"
import type { Metadata } from "next"
import { Fraunces, Geist, Geist_Mono, JetBrains_Mono } from "next/font/google"
import Script from "next/script"
import { PostHogClientProvider } from "@/components/telemetry/posthog-provider"
import { PostHogErrorBoundary } from "@/components/telemetry/posthog-error-boundary"
import "./globals.css"

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains",
  subsets: ["latin"],
})

const fraunces = Fraunces({
  variable: "--font-fraunces",
  subsets: ["latin"],
})

const themeScript = `
(() => {
  try {
    const theme = window.localStorage.getItem("voiceclaw-theme")
    if (theme === "light" || theme === "dark") {
      document.documentElement.classList.add(theme)
    }
  } catch {
    return
  }
})()
`

const SITE_URL = "https://hello.capnio.pro"
const SITE_TITLE = "Hello Capnio - Voice for Your Private Agent"
const SITE_DESCRIPTION =
  "Hello Capnio is a public web voice layer that connects your browser to your private OpenClaw-compatible agent."

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: SITE_TITLE,
  description: SITE_DESCRIPTION,
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "Hello Capnio",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: SITE_TITLE,
    description: SITE_DESCRIPTION,
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html
      lang="en"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} ${jetbrainsMono.variable} ${fraunces.variable}`}
    >
      <body className="min-h-screen bg-background text-foreground antialiased">
        <Script
          id="voiceclaw-theme"
          strategy="beforeInteractive"
          dangerouslySetInnerHTML={{ __html: themeScript }}
        />
        <Suspense fallback={null}>
          <PostHogClientProvider>
            <PostHogErrorBoundary>{children}</PostHogErrorBoundary>
          </PostHogClientProvider>
        </Suspense>
      </body>
    </html>
  )
}
