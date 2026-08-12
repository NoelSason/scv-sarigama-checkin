import Link from 'next/link'
import { Greeting, KasavuBand, KasavuRule, Lamp, Petals, PookalamArc } from '@/components/onam'

export const metadata = { title: 'SCV Sarigama Onam 2026' }

/**
 * Root landing.
 *
 * Almost nobody arrives here: guests reach their pass by scanning the QR a
 * volunteer shows them at the desk, which drops them straight on /p/{token}.
 * This page exists for the person who typed the domain in by hand, so it says
 * the one true thing — come to the desk — rather than inventing a self-service
 * route that doesn't exist.
 */
export default function Home() {
  return (
    <div className="relative min-h-dvh overflow-hidden">
      <PookalamArc />
      <Petals seed={11} />

      <main className="relative z-[2] mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-12">
        <header className="text-center">
          <Lamp width={40} glow className="mx-auto" />
          <p className="mt-2.5 text-xs font-black uppercase tracking-[0.28em] text-[var(--gold-deep)]">
            SCV Sarigama
          </p>
          <h1 className="display mt-0.5 text-[2.75rem] leading-[1.1] text-[var(--green-deep)]">
            Onam 2026
          </h1>
          <Greeting className="mt-1.5 text-lg" />
        </header>

        <div className="mt-9 space-y-4">
          <div className="card-banded">
            <KasavuBand />
            <div className="p-5">
              <h2 className="display text-xl font-bold">Looking for your Sadhya pass?</h2>
              <p className="mt-2 text-[15px] leading-relaxed text-black/70">
                Come to the registration desk when you arrive. A volunteer will find your name and
                show you a code to scan — your pass opens on your own phone, and you keep it.
              </p>
              <p className="mt-3 text-[15px] leading-relaxed text-black/70">
                Already have your pass open? Just show it at the Sadhya entrance.
              </p>
            </div>
          </div>

          <Link href="/staff" className="btn-neutral w-full">
            Volunteer sign-in
          </Link>
        </div>

        <footer className="mt-auto pt-11 text-center">
          <KasavuRule />
          <p className="mt-2.5 text-xs text-black/45">SCV Sarigama Onam 2026</p>
        </footer>
      </main>
    </div>
  )
}
