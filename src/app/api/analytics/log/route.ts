import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { LOG_SELECT, LOG_SELECT_FULL } from '@/lib/analytics/onam'
import { LOG_PAGE, type AdminLogRow, type LogRow } from '@/lib/analytics/log-shape'
import { requireStaffApi } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * The full event log, paged.
 *
 * `event_stream` is a view over every table that records something happening —
 * actions, scans, adjustments, payments, emails, logins, syncs, reviews — so
 * there is exactly one definition of "everything that happened" and it cannot
 * drift from its sources.
 *
 * Paged rather than dumped: there are thousands of rows and most of them are
 * the five-minute sheet sync. A phone should not have to download all of it to
 * read the first screen.
 */

const CATEGORIES = new Set([
  'action',
  'redemption',
  'adjustment',
  'payment',
  'email',
  'login',
  'sync',
  'review',
])

export async function GET(req: Request) {
  const url = new URL(req.url)

  /*
   * `full=1` returns the address, device and staff email on each row. It is
   * only honoured for a signed-in volunteer — an anonymous caller asking for it
   * silently gets the ordinary, redacted stream rather than an error, because
   * there is nothing to negotiate.
   */
  const wantsFull = url.searchParams.get('full') === '1'
  const full = wantsFull ? Boolean(await requireStaffApi('scanner')) : false
  const category = url.searchParams.get('category')
  const search = (url.searchParams.get('q') ?? '').trim()
  const limit = Math.min(500, Math.max(10, Number(url.searchParams.get('limit')) || LOG_PAGE))
  const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0)

  const where: string[] = []
  const params: unknown[] = []

  if (category && CATEGORIES.has(category)) {
    params.push(category)
    where.push(`category = $${params.length}`)
  }

  if (search) {
    params.push(`%${search}%`)
    const p = `$${params.length}`
    // The staff view can also be searched by address and place; the public one
    // has no such columns to match against.
    where.push(
      full
        ? `(action ilike ${p} or coalesce(actor,'') ilike ${p}
            or coalesce(household,'') ilike ${p} or coalesce(detail,'') ilike ${p}
            or coalesce(location,'') ilike ${p} or coalesce(ip,'') ilike ${p}
            or coalesce(actor_email,'') ilike ${p})`
        : `(action ilike ${p} or coalesce(actor,'') ilike ${p}
            or coalesce(household,'') ilike ${p} or coalesce(detail,'') ilike ${p})`,
    )
  }

  const clause = where.length ? `where ${where.join(' and ')}` : ''

  params.push(limit, offset)
  const rows = await query<LogRow | AdminLogRow>(
    `${full ? LOG_SELECT_FULL : LOG_SELECT}
       ${clause}
      order by occurred_at desc
      limit $${params.length - 1} offset $${params.length}`,
    params,
  )

  const totalRows = await query<{ n: number }>(
    `select count(*)::int as n from event_stream ${clause}`,
    params.slice(0, params.length - 2),
  )

  return NextResponse.json(
    { rows, total: totalRows[0]?.n ?? 0, limit, offset, full },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
