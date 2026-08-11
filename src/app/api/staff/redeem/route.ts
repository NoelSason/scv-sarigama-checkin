import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaffApi } from '@/lib/auth'
import { redeemTickets } from '@/lib/households'

export const dynamic = 'force-dynamic'

const Body = z.object({
  householdId: z.string().uuid(),
  quantity: z.number().int().positive().max(50),
  device: z.string().max(80).optional(),
})

/**
 * The only redemption entry point.
 *
 * The client sends an intent; the database decides. Every failure mode comes
 * back as a named error so the scanner can show an unambiguous message rather
 * than a generic "something went wrong".
 */
export async function POST(req: Request) {
  const staff = await requireStaffApi('scanner')
  if (!staff) return NextResponse.json({ success: false, error: 'UNAUTHORIZED' }, { status: 401 })

  let parsed: z.infer<typeof Body>
  try {
    parsed = Body.parse(await req.json())
  } catch {
    return NextResponse.json({ success: false, error: 'INVALID_QUANTITY' }, { status: 400 })
  }

  const result = await redeemTickets(
    parsed.householdId,
    parsed.quantity,
    staff.id,
    parsed.device ?? null,
  )

  // A refusal is a legitimate, expected outcome — not a server error. Return
  // 200 with success:false so the scanner always parses one shape.
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
