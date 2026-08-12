import { NextResponse } from 'next/server'
import { requireStaffApi } from '@/lib/auth'
import { findByToken, logAudit, searchHouseholds } from '@/lib/households'
import { extractToken } from '@/lib/scan'

export const dynamic = 'force-dynamic'

/**
 * Scanner + desk lookup. Accepts either a scanned pass URL/token or a free-text
 * search term.
 *
 * Looking a household up NEVER changes anything — the volunteer must then
 * choose a quantity and confirm. That separation is what stops a camera frame
 * from silently eating someone's ticket.
 *
 * Every lookup is recorded even though none of them change anything. A read is
 * still an access to a guest's record, and "who was pulling up whose details,
 * from where" is a question that can only be answered if it was written down at
 * the time.
 */
export async function GET(req: Request) {
  const staff = await requireStaffApi('scanner')
  if (!staff) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  const url = new URL(req.url)
  const token = url.searchParams.get('token')
  const q = url.searchParams.get('q')

  if (token) {
    const household = await findByToken(extractToken(token))
    await logAudit(household ? 'scan_lookup' : 'scan_lookup_not_found', {
      actorType: 'staff',
      actorId: staff.id,
      householdId: household?.id ?? null,
      metadata: {
        // The token itself is not recorded: it is the credential that opens the
        // pass, and an audit log is a less protected place than the pass table.
        found: Boolean(household),
        remaining: household?.tickets_remaining ?? null,
      },
    })
    if (!household) return NextResponse.json({ error: 'PASS_NOT_FOUND' }, { status: 404 })
    return NextResponse.json({ household }, { headers: { 'Cache-Control': 'no-store' } })
  }

  if (q) {
    const results = await searchHouseholds(q)
    await logAudit('desk_lookup', {
      actorType: 'staff',
      actorId: staff.id,
      householdId: results.length === 1 ? results[0].id : null,
      metadata: { term: q, results: results.length },
    })
    return NextResponse.json({ results }, { headers: { 'Cache-Control': 'no-store' } })
  }

  return NextResponse.json({ error: 'MISSING_QUERY' }, { status: 400 })
}
