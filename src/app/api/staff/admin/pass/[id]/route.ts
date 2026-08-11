import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaffApi } from '@/lib/auth'
import { query } from '@/lib/db'
import { findById, logAudit } from '@/lib/households'

export const dynamic = 'force-dynamic'

const Id = z.string().uuid()

const Body = z.object({
  enabled: z.boolean(),
  reason: z.string().trim().max(200).optional(),
})

/**
 * Turn a pass off (chargeback, duplicate, disputed entry) or back on.
 *
 * Disabling is the reversible alternative to deleting a household: the ledger,
 * the QR, and the history all survive, and redeem_tickets() refuses the pass at
 * the door until an admin re-enables it.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaffApi('admin')
  if (!staff) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  const { id } = await params
  if (!Id.safeParse(id).success) return NextResponse.json({ error: 'INVALID' }, { status: 400 })

  let body: z.infer<typeof Body>
  try {
    body = Body.parse(await req.json())
  } catch (err) {
    return NextResponse.json(
      { error: 'INVALID', detail: err instanceof z.ZodError ? err.issues : undefined },
      { status: 400 },
    )
  }

  const before = await findById(id)
  if (!before) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  if (before.pass_enabled === body.enabled) {
    return NextResponse.json({ household: before, unchanged: true })
  }

  await query('update households set pass_enabled = $1 where id = $2', [body.enabled, id])

  await logAudit(body.enabled ? 'pass_enabled' : 'pass_disabled', {
    actorId: staff.id,
    householdId: id,
    metadata: { by: staff.name, reason: body.reason?.trim() || null },
  })

  return NextResponse.json({ household: await findById(id) })
}
