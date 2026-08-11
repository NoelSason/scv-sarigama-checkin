import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaffApi } from '@/lib/auth'
import { resendPassEmail } from '@/lib/email'
import { testRedirectTarget } from '@/lib/email/provider'

export const dynamic = 'force-dynamic'

const Body = z.object({ householdId: z.string().uuid() })

/**
 * Send (or re-send) a household's pass email from the registration desk.
 *
 * Registration role, not scanner: the scan station has no business triggering
 * outbound mail, and the desk is where someone stands in front of you asking
 * for it.
 *
 * A failed send is a 200 with ok:false — the desk needs to read *why* (no email
 * on file, payment unsettled, provider down) and act, not see a red error box.
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

  const result = await resendPassEmail(body.householdId, staff.id)

  return NextResponse.json(
    {
      ...result,
      // Surfaced so a volunteer testing the flow can see the guest did not get
      // it, instead of reporting "sent" and everyone believing it.
      testRedirect: testRedirectTarget(),
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
