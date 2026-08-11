import { NextResponse } from 'next/server'
import { requireStaffApi } from '@/lib/auth'
import { loadStats } from '@/app/staff/admin/stats'

export const dynamic = 'force-dynamic'

/** Live numbers for the admin overview poll. Read-only — never mutates. */
export async function GET() {
  const staff = await requireStaffApi('admin')
  if (!staff) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  const stats = await loadStats()
  return NextResponse.json(stats, { headers: { 'Cache-Control': 'no-store' } })
}
