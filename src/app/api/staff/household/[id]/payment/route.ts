import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaffApi } from '@/lib/auth'
import { query } from '@/lib/db'
import { findById, logAudit } from '@/lib/households'

export const dynamic = 'force-dynamic'

const Id = z.string().uuid()

const Body = z.object({
  // Only the three states a desk volunteer can legitimately set. Refunds and
  // needs_review are decided elsewhere, not by a tap at the door.
  status: z.enum(['paid', 'comped', 'unpaid']),
  method: z.enum(['square', 'zelle', 'cash', 'complimentary', 'other']).optional(),
  amountPaidCents: z.number().int().min(0).max(1_000_000).optional(),
})

/**
 * Payment status change.
 *
 * This is the switch that decides whether a household can eat, so the client
 * must show an explicit old → new confirmation before calling it. Nothing here
 * touches ticket counts: a household that pays does not gain admissions, it
 * gains permission to use the ones it already has.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaffApi('registration')
  if (!staff) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  const { id } = await params
  if (!Id.safeParse(id).success) {
    return NextResponse.json({ error: 'INVALID' }, { status: 400 })
  }

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

  await query(
    `update households
        set payment_status    = $1::payment_status,
            payment_method    = coalesce($2::payment_method, payment_method),
            amount_paid_cents = coalesce($3::integer, amount_paid_cents)
      where id = $4`,
    [body.status, body.method ?? null, body.amountPaidCents ?? null, id],
  )

  const household = await findById(id)

  await logAudit('payment_status_changed', {
    actorId: staff.id,
    householdId: id,
    metadata: {
      by: staff.name,
      from: before.payment_status,
      to: body.status,
      method: body.method ?? before.payment_method,
      amount_paid_cents: body.amountPaidCents ?? before.amount_paid_cents,
      // Worth flagging in the trail: revoking a pass people already ate on.
      tickets_already_redeemed: before.tickets_redeemed,
    },
  })

  return NextResponse.json({ household })
}
