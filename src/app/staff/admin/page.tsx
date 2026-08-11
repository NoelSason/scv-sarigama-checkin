import Link from 'next/link'
import { requireStaff } from '@/lib/auth'
import { AdminDashboard } from './AdminDashboard'
import { loadStats } from './stats'

export const dynamic = 'force-dynamic'

export default async function AdminPage() {
  await requireStaff('admin')

  // Rendered server-side so the page is useful on first paint; the client then
  // polls to keep it live.
  const initial = await loadStats()

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-black">Admin</h1>
        <nav className="ml-auto flex gap-2 text-sm font-semibold">
          <Link href="/staff/admin/review" className="btn-neutral px-4 py-2">
            Review queue
          </Link>
          <Link href="/staff/admin/roster" className="btn-neutral px-4 py-2">
            Paper roster
          </Link>
        </nav>
      </div>

      <AdminDashboard initial={initial} />
    </div>
  )
}
