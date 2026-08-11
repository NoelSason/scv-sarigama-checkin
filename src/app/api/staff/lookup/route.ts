import { NextResponse } from 'next/server'
import { requireStaffApi } from '@/lib/auth'
import { findByToken, searchHouseholds } from '@/lib/households'
import { extractToken } from '@/lib/scan'

export const dynamic = 'force-dynamic'

/**
 * Scanner + desk lookup. Accepts either a scanned pass URL/token or a free-text
 * search term.
 *
 * Looking a household up NEVER changes anything — the volunteer must then
 * choose a quantity and confirm. That separation is what stops a camera frame
 * from silently eating someone's ticket.
 */
export async function GET(req: Request) {
  const staff = await requireStaffApi('scanner')
  if (!staff) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  const url = new URL(req.url)
  const token = url.searchParams.get('token')
  const q = url.searchParams.get('q')

  if (token) {
    const household = await findByToken(extractToken(token))
    if (!household) return NextResponse.json({ error: 'PASS_NOT_FOUND' }, { status: 404 })
    return NextResponse.json({ household }, { headers: { 'Cache-Control': 'no-store' } })
  }

  if (q) {
    const results = await searchHouseholds(q)
    return NextResponse.json({ results }, { headers: { 'Cache-Control': 'no-store' } })
  }

  return NextResponse.json({ error: 'MISSING_QUERY' }, { status: 400 })
}
