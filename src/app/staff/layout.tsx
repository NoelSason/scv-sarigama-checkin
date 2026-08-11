import Link from 'next/link'
import { redirect } from 'next/navigation'
import { currentStaff, signOut } from '@/lib/auth'
import { ConnectionBanner } from '@/components/ConnectionBanner'

export const dynamic = 'force-dynamic'

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const staff = await currentStaff()

  async function doSignOut() {
    'use server'
    await signOut()
    redirect('/staff/login')
  }

  // The login page renders inside this layout too; it has no chrome of its own.
  if (!staff) return <>{children}</>

  return (
    <div className="min-h-dvh">
      <ConnectionBanner />

      {/* On a phone every one of these labels wrapped to two lines, costing a
          third of the viewport above the camera. The brand shortens, the links
          stay on one line, and sign-out becomes an icon — it is the least-used
          control and the only one that can afford to lose its word. */}
      <header className="sticky top-0 z-20 border-b border-black/10 bg-[var(--green-deep)] text-white">
        <div className="mx-auto flex max-w-3xl items-center gap-1 px-3 py-2">
          <Link href="/staff" className="shrink-0 font-black tracking-tight">
            <span className="sm:hidden">Onam</span>
            <span className="hidden sm:inline">Onam Check-In</span>
          </Link>

          <nav className="ml-auto flex items-center gap-0.5 text-sm font-semibold">
            <Link
              href="/staff/scan"
              className="whitespace-nowrap rounded-lg px-2.5 py-2 hover:bg-white/15 sm:px-3"
            >
              Scan
            </Link>
            {(staff.role === 'registration' || staff.role === 'admin') && (
              <Link
                href="/staff/registration"
                className="whitespace-nowrap rounded-lg px-2.5 py-2 hover:bg-white/15 sm:px-3"
              >
                Desk
              </Link>
            )}
            {staff.role === 'admin' && (
              <Link
                href="/staff/admin"
                className="whitespace-nowrap rounded-lg px-2.5 py-2 hover:bg-white/15 sm:px-3"
              >
                Admin
              </Link>
            )}
            {/* Reachable from every screen: the moment a volunteer needs the
                instructions is the moment they are stuck mid-queue. */}
            <Link
              href="/staff/help"
              className="whitespace-nowrap rounded-lg px-2.5 py-2 hover:bg-white/15 sm:px-3"
              aria-label="How to do this"
            >
              Help
            </Link>
            <form action={doSignOut}>
              <button
                type="submit"
                title="Sign out"
                aria-label="Sign out"
                className="whitespace-nowrap rounded-lg px-2.5 py-2 hover:bg-white/15 sm:px-3"
              >
                <span aria-hidden className="sm:hidden">
                  ⏻
                </span>
                <span className="hidden sm:inline">Sign out</span>
              </button>
            </form>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-3 py-4 sm:px-4 sm:py-5">{children}</main>
    </div>
  )
}
