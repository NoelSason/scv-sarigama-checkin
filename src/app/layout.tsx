import type { Metadata, Viewport } from 'next'
import { Playfair_Display, Nunito_Sans, Manjari } from 'next/font/google'
import './globals.css'

/*
 * Three faces, each with one job:
 *   Playfair  — event name, family names, the big counts
 *   Nunito    — every label, button and instruction a volunteer reads at speed
 *   Manjari   — Malayalam greetings only
 *
 * Self-hosted through next/font so a venue with bad wifi never shows a page in
 * fallback metrics while a Google stylesheet times out. `display: swap` keeps
 * text on screen throughout.
 */
const playfair = Playfair_Display({
  subsets: ['latin'],
  weight: ['700', '800'],
  variable: '--font-playfair',
  display: 'swap',
})

const nunito = Nunito_Sans({
  subsets: ['latin'],
  weight: ['400', '600', '700', '800', '900'],
  variable: '--font-nunito',
  display: 'swap',
})

const manjari = Manjari({
  subsets: ['malayalam', 'latin'],
  weight: ['700'],
  variable: '--font-manjari',
  display: 'swap',
})

export const metadata: Metadata = {
  title: 'SCV Sarigama Onam 2026',
  description: 'Sadhya admission passes for SCV Sarigama Onam 2026',
  robots: { index: false, follow: false },
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  // Guests need to pinch-zoom a QR; volunteers need stable layout. Allowing
  // zoom is the accessible choice.
  maximumScale: 5,
  themeColor: '#124a33',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${playfair.variable} ${nunito.variable} ${manjari.variable}`}
    >
      <body>{children}</body>
    </html>
  )
}
