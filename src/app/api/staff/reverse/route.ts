import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaffApi } from '@/lib/auth'
import { queryOne } from '@/lib/db'
import { reverseRedemption } from '@/lib/households'

export const dynamic = 'force-dynamic'

const Body = z.object({
  redemptionId: z.string().uuid(),
  quantity: z.number().int().positive().max(50),
  reason: z.string().trim().min(1).max(200).optional(),
})

/** How long after a scan a volunteer may undo it themselves. */
const UNDO_WINDOW_MINUTES = 30

/**
 * Scanner-side give-back.
 *
 * Covers the common mistake — tapping 3 when 2 were entering — without sending
 * the volunteer to find an admin mid-queue. Deliberately narrow: only a
 * redemption made in the last half hour can be undone here. Anything older is
 * an admin decision, because by then nobody at the food line remembers what
 * actually happened.
 *
 * This does not delete anything. reverse_redemption writes a compensating
 * adjustment, so the history keeps both the mistake and the correction.
 */
export async function POST(req: Request) {
  const staff = await requireStaffApi('scanner')
  if (!staff) return NextResponse.json({ success: false, error: 'UNAUTHORIZED' }, { status: 401 })

  let body: z.infer<typeof Body>
  try {
    body = Body.parse(await req.json())
  } catch {
    return NextResponse.json({ success: false, error: 'INVALID_QUANTITY' }, { status: 400 })
  }

  const recent = await queryOne<{ id: string }>(
    `select id from redemptions
      where id = $1
        and created_at > now() - ($2 || ' minutes')::interval`,
    [body.redemptionId, UNDO_WINDOW_MINUTES],
  )
  if (!recent) {
    return NextResponse.json({
      success: false,
      error: 'TOO_OLD',
      detail: `Only scans from the last ${UNDO_WINDOW_MINUTES} minutes can be undone here. Ask an admin.`,
    })
  }

  const result = await reverseRedemption(
    body.redemptionId,
    body.quantity,
    body.reason?.trim() || 'Given back at the Sadhya entrance',
    staff.id,
  )

  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
