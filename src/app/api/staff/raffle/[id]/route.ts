import { NextResponse } from 'next/server'
import { requireStaffApi } from '@/lib/auth'
import { loadRaffleState, voidDraw } from '@/lib/raffle'

export const dynamic = 'force-dynamic'

/**
 * Undo a single draw — a mis-typed prize, or a spin that ran before the room
 * was watching. The winner goes straight back into the pool.
 */
export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaffApi('admin')
  if (!staff) return NextResponse.json({ success: false, error: 'UNAUTHORIZED' }, { status: 401 })

  const { id } = await params
  const voided = await voidDraw(id, staff.id)
  if (!voided) {
    return NextResponse.json({ success: false, error: 'DRAW_NOT_FOUND' }, { status: 404 })
  }

  const state = await loadRaffleState()
  return NextResponse.json(
    { success: true, ...voided, state },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
