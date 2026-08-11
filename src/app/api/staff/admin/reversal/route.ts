import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaffApi } from '@/lib/auth'
import { queryOne } from '@/lib/db'
import { findById, reverseRedemption } from '@/lib/households'

export const dynamic = 'force-dynamic'

const Body = z.object({
  redemptionId: z.string().uuid(),
  quantity: z.number().int().positive().max(50),
  // reverse_redemption() rejects a blank reason outright. Requiring real words
  // here turns that into a form error instead of a server error, and means the
  // adjustment row is still readable a year from now.
  reason: z.string().trim().min(3).max(200),
})

/**
 * Undo a mistaken scan.
 *
 * Nothing is ever deleted: reverse_redemption() writes a compensating
 * redemption_adjustments row and its own audit_logs entry in one statement, so
 * the history shows both the mistake and the correction. We deliberately do not
 * add a second app-level audit write — it would double every entry.
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

  const result = await reverseRedemption(body.redemptionId, body.quantity, body.reason, staff.id)
  if (!result.success) return NextResponse.json(result, { status: 400 })

  // The RPC returns a name, not an id, so re-read the household for the panel.
  const owner = await queryOne<{ household_id: string }>(
    'select household_id from redemptions where id = $1',
    [body.redemptionId],
  )
  const household = owner ? await findById(owner.household_id) : null

  return NextResponse.json({ ...result, household }, { headers: { 'Cache-Control': 'no-store' } })
}
