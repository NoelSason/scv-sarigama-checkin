import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaffApi } from '@/lib/auth'
import { createHousehold, logAudit, type PaymentMethod } from '@/lib/households'

export const dynamic = 'force-dynamic'

const Body = z.object({
  displayName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().optional().or(z.literal('')),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
  ticketsPurchased: z.number().int().min(0).max(50),
  childrenUnder6: z.number().int().min(0).max(20).default(0),
  paymentMethod: z.enum(['square', 'zelle', 'cash', 'complimentary', 'other']),
  amountPaidCents: z.number().int().min(0).optional(),
  paid: z.boolean(),
  notes: z.string().trim().max(500).optional(),
})

/**
 * Walk-in registration.
 *
 * A volunteer creates the household only after confirming payment in the real
 * world (cash in hand, Zelle notification seen, Square receipt shown). The
 * `paid` flag is that confirmation — an unconfirmed walk-in lands as 'unpaid'
 * and simply cannot redeem until someone marks it.
 */
export async function POST(req: Request) {
  const staff = await requireStaffApi('registration')
  if (!staff) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  let body: z.infer<typeof Body>
  try {
    body = Body.parse(await req.json())
  } catch (err) {
    return NextResponse.json(
      { error: 'INVALID', detail: err instanceof z.ZodError ? err.issues : undefined },
      { status: 400 },
    )
  }

  const method = body.paymentMethod as PaymentMethod
  const status = body.paid ? (method === 'complimentary' ? 'comped' : 'paid') : 'unpaid'

  const household = await createHousehold({
    displayName: body.displayName,
    email: body.email || null,
    phone: body.phone || null,
    ticketsPurchased: body.ticketsPurchased,
    childrenUnder6: body.childrenUnder6,
    paymentStatus: status,
    paymentMethod: method,
    amountPaidCents: body.amountPaidCents ?? null,
    source: 'walk_in',
    notes: body.notes ?? null,
  })

  await logAudit('walk_in_created', {
    actorId: staff.id,
    householdId: household.id,
    metadata: {
      tickets: body.ticketsPurchased,
      under6: body.childrenUnder6,
      method,
      status,
      by: staff.name,
    },
  })

  return NextResponse.json({ household })
}
