import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaffApi } from '@/lib/auth'
import { drawWinner, loadRaffleState } from '@/lib/raffle'

export const dynamic = 'force-dynamic'

const NO_STORE = { 'Cache-Control': 'no-store' }

const Body = z.object({
  // draw_raffle_winner() rejects a blank prize outright. Catching it here turns
  // that into a form error instead of a server error, and means the row is
  // still readable when someone asks in November who won what.
  prize: z.string().trim().min(1).max(120),
})

/** Current pool and standing winners — the stage's first paint and its refresh. */
export async function GET() {
  const staff = await requireStaffApi('admin')
  if (!staff) return NextResponse.json({ success: false, error: 'UNAUTHORIZED' }, { status: 401 })

  const state = await loadRaffleState()
  return NextResponse.json({ success: true, ...state }, { headers: NO_STORE })
}

/**
 * Draw one winner.
 *
 * The winner is decided and written before this responds, so the spin on
 * screen is replaying a result that already exists. A refresh mid-celebration
 * loses the confetti and nothing else.
 *
 * The fresh pool comes back with it: the stage builds the next wheel from the
 * names that were in play for THIS draw, winner included, so what slid past
 * the pointer is an honest picture of who could have won.
 */
export async function POST(req: Request) {
  const staff = await requireStaffApi('admin')
  if (!staff) return NextResponse.json({ success: false, error: 'UNAUTHORIZED' }, { status: 401 })

  let body: z.infer<typeof Body>
  try {
    body = Body.parse(await req.json())
  } catch (err) {
    return NextResponse.json(
      {
        success: false,
        error: 'INVALID',
        detail: err instanceof z.ZodError ? err.issues : undefined,
      },
      { status: 400 },
    )
  }

  // Read the pool first: after the draw the winner is gone from it, and the
  // wheel has to show them going past.
  const before = await loadRaffleState()
  const result = await drawWinner(body.prize, staff.id)
  if (!result.success) return NextResponse.json(result, { status: 400, headers: NO_STORE })

  const after = await loadRaffleState()

  return NextResponse.json(
    { ...result, spinPool: before.pool, state: after },
    { headers: NO_STORE },
  )
}
