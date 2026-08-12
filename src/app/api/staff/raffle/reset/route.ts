import { NextResponse } from 'next/server'
import { requireStaffApi } from '@/lib/auth'
import { loadRaffleState, resetRaffle } from '@/lib/raffle'

export const dynamic = 'force-dynamic'

/**
 * Put everyone back in the pool.
 *
 * The draws are not deleted, only voided, so the record of what was announced
 * on stage before the reset survives it.
 */
export async function POST() {
  const staff = await requireStaffApi('admin')
  if (!staff) return NextResponse.json({ success: false, error: 'UNAUTHORIZED' }, { status: 401 })

  const released = await resetRaffle(staff.id)
  const state = await loadRaffleState()

  return NextResponse.json(
    { success: true, released, state },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
