import { NextResponse } from 'next/server'
import { z } from 'zod'
import { query } from '@/lib/db'
import { requireStaffApi } from '@/lib/auth'
import { logAudit, redeemTickets } from '@/lib/households'
import { requestContext } from '@/lib/request-context'

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

  // Releasing a meal is the highest-value action in the app, so it is recorded
  // whether it succeeded or was refused — a stream of refusals from one address
  // is exactly the pattern worth being able to see afterwards.
  const ctx = await requestContext()
  if (result.success && result.redemption_id) {
    await query(
      `update redemptions
          set ip = $2, user_agent = $3, geo_city = $4, geo_region = $5, geo_country = $6
        where id = $1`,
      [result.redemption_id, ctx.ip, ctx.userAgent, ctx.geoCity, ctx.geoRegion, ctx.geoCountry],
    )
  }
  await logAudit(result.success ? 'scan_redeemed' : 'scan_refused', {
    actorType: 'staff',
    actorId: staff.id,
    householdId: parsed.householdId,
    metadata: {
      requested: parsed.quantity,
      redeemed: result.redeemed_now ?? 0,
      remaining: result.tickets_remaining ?? null,
      device: parsed.device ?? null,
      error: result.error ?? null,
    },
  })

  // A refusal is a legitimate, expected outcome — not a server error. Return
  // 200 with success:false so the scanner always parses one shape.
  return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
}
