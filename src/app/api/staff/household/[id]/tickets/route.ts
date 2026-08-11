import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaffApi } from '@/lib/auth'
import { adjustTicketCount, findById } from '@/lib/households'

export const dynamic = 'force-dynamic'

const Id = z.string().uuid()

const Body = z.object({
  newTotal: z.number().int().min(0).max(50),
  // The database function rejects a blank reason outright; requiring real words
  // here means the volunteer gets a form error instead of a server error.
  reason: z.string().trim().min(3).max(200),
})

/**
 * Correct how many admissions a household bought.
 *
 * All the real work is adjust_ticket_count(), which refuses to drop the total
 * below what has already been redeemed and writes its own audit_logs row in the
 * same statement. We deliberately do not add a second logAudit() call: an
 * app-level log could be lost if this request died mid-flight, and it would
 * double every entry in the history view.
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

  const result = await adjustTicketCount(id, body.newTotal, body.reason, staff.id)
  if (!result.success) return NextResponse.json(result, { status: 400 })

  const household = await findById(id)
  return NextResponse.json({ household, result })
}
