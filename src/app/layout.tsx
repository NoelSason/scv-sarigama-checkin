import type { Metadata, Viewport } from 'next'
import './globals.css'

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
  themeColor: '#1c6b4a',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
