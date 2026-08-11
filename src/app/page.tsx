import Link from 'next/link'

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
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center px-6 py-12">
      <header className="text-center">
        <p className="text-sm font-bold uppercase tracking-[0.2em] text-[var(--gold-deep)]">
          SCV Sarigama
        </p>
        <h1 className="mt-1 text-4xl font-black text-[var(--green-deep)]">Onam 2026</h1>
      </header>

      <div className="mt-10 space-y-4">
        <div className="card">
          <h2 className="text-lg font-bold">Looking for your Sadhya pass?</h2>
          <p className="mt-2 text-[15px] leading-relaxed text-black/70">
            Come to the registration desk when you arrive. A volunteer will find your name and
            show you a code to scan — your pass opens on your own phone, and you keep it.
          </p>
          <p className="mt-3 text-[15px] leading-relaxed text-black/70">
            Already have your pass open? Just show it at the Sadhya entrance.
          </p>
        </div>

        <Link href="/staff" className="btn-neutral w-full">
          Volunteer sign-in
        </Link>
      </div>

      <footer className="mt-auto pt-12 text-center text-xs text-black/40">
        SCV Sarigama Onam 2026
      </footer>
    </main>
  )
}
