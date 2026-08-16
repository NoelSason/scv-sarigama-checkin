import { NextResponse } from 'next/server'
import { loadOnamAnalytics } from '@/lib/analytics/onam'
import { loadSensitive } from '@/lib/analytics/sensitive'
import { requireStaffApi } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * The full report, for a signed-in volunteer.
 *
 * Everything the public route returns, plus the detail that route deliberately
 * omits. The staff check happens before `loadSensitive()` is called at all, so
 * an unauthorised request never causes those queries to run, let alone return.
 */
export async function GET() {
  const staff = await requireStaffApi('scanner')
  if (!staff) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  /*
   * Sequenced, not `Promise.all`.
   *
   * Each loader already fans out into a few dozen parallel queries over Neon's
   * HTTP driver. Running both at once put ~50 fetches in flight for a single
   * page render, which is where transient `fetch failed` errors start showing
   * up — and one failed query blanks the whole report. Waiting for the first
   * batch costs a few hundred milliseconds on a page nobody loads in a hurry.
   */
  const base = await loadOnamAnalytics()
  const sensitive = await loadSensitive()

  return NextResponse.json(
    { ...base, sensitive },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
