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

      <header className="sticky top-0 z-20 border-b border-black/10 bg-[var(--green-deep)] text-white">
        <div className="mx-auto flex max-w-3xl items-center gap-3 px-4 py-2.5">
          <Link href="/staff" className="font-black tracking-tight">
            Onam Check-In
          </Link>
          <nav className="ml-auto flex items-center gap-1 text-sm font-semibold">
            <Link href="/staff/scan" className="rounded-lg px-3 py-2 hover:bg-white/15">
              Scan
            </Link>
            {(staff.role === 'registration' || staff.role === 'admin') && (
              <Link href="/staff/registration" className="rounded-lg px-3 py-2 hover:bg-white/15">
                Desk
              </Link>
            )}
            {staff.role === 'admin' && (
              <Link href="/staff/admin" className="rounded-lg px-3 py-2 hover:bg-white/15">
                Admin
              </Link>
            )}
            <form action={doSignOut}>
              <button type="submit" className="rounded-lg px-3 py-2 hover:bg-white/15">
                Sign out
              </button>
            </form>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-5">{children}</main>
    </div>
  )
}
