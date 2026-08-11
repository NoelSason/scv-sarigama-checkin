import Link from 'next/link'

export const metadata = { title: 'SCV Sarigama Onam 2026' }

/**
 * Root landing. Almost nobody arrives here — guests get a direct /p/{token}
 * link — so it exists mainly to give a lost guest somewhere useful to go, and
 * volunteers a way in.
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
          <p className="mt-1 text-[15px] leading-relaxed text-black/70">
            Open the link that was sent to you. If you can&apos;t find it, we can send it
            again — or just come to the registration desk when you arrive and a volunteer
            will pull it up for you.
          </p>
          <Link href="/find-pass" className="btn-gold mt-4 w-full">
            Find my pass
          </Link>
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
