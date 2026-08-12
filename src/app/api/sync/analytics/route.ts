import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { query } from '@/lib/db'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * The Event Analytics feed.
 *
 * Append-only by design. The sheet asks "what has happened since this moment"
 * and gets back only new rows, so event day — which produces a few thousand
 * scans — does not mean rewriting the whole tab every five minutes, and history
 * already written down is never rewritten by a later run.
 *
 * `event_id` is stable and unique per underlying row (see 0008_analytics.sql), so
 * an overlapping window is harmless: the sheet drops ids it already holds. That
 * overlap is deliberate — events sharing a timestamp at the boundary would
 * otherwise fall through the gap between two polls.
 */

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const offered = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const a = Buffer.from(offered)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

export const ANALYTICS_HEADERS = [
  'When (UTC)',
  'Category',
  'Event',
  'Who',
  'Role',
  'Account',
  'IP address',
  'Approx. location',
  'Device / browser',
  'Guest',
  'Details',
  'Event ID',
] as const

/** A poll can never return more than this; the sheet keeps asking until drained. */
const PAGE = 2000

/** Re-ask for a little before the cursor so a timestamp tie cannot be skipped. */
const OVERLAP_SECONDS = 120

type Row = {
  event_id: string
  occurred_at: string
  category: string
  action: string
  actor: string | null
  actor_type: string | null
  actor_role: string | null
  actor_email: string | null
  ip: string | null
  location: string | null
  user_agent: string | null
  household: string | null
  detail: string | null
}

/** Long UA strings make the sheet unreadable; keep the part that identifies it. */
function shortDevice(ua: string | null): string {
  if (!ua) return ''
  const os =
    /iPhone|iPad/.test(ua) ? 'iOS'
    : /Android/.test(ua) ? 'Android'
    : /Macintosh|Mac OS/.test(ua) ? 'macOS'
    : /Windows/.test(ua) ? 'Windows'
    : /Linux/.test(ua) ? 'Linux'
    : ''
  const browser =
    /Edg\//.test(ua) ? 'Edge'
    : /OPR\//.test(ua) ? 'Opera'
    : /Chrome\//.test(ua) ? 'Chrome'
    : /Firefox\//.test(ua) ? 'Firefox'
    : /Safari\//.test(ua) ? 'Safari'
    : ''
  const label = [os, browser].filter(Boolean).join(' ')
  return label || ua.slice(0, 40)
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  const url = new URL(req.url)
  const since = url.searchParams.get('since')
  const sinceDate = since ? new Date(since) : null
  const valid = sinceDate && !Number.isNaN(sinceDate.getTime())

  const rows = await query<Row>(
    `select event_id, occurred_at, category, action, actor, actor_type, actor_role,
            actor_email, ip, location, user_agent, household, detail
       from event_stream
      where occurred_at > coalesce($1::timestamptz, '-infinity'::timestamptz)
      order by occurred_at asc
      limit ${PAGE}`,
    [valid ? new Date(sinceDate.getTime() - OVERLAP_SECONDS * 1000).toISOString() : null],
  )

  const values = rows.map((r) => [
    new Date(r.occurred_at).toISOString().replace('T', ' ').slice(0, 19),
    r.category,
    r.action,
    r.actor ?? '',
    r.actor_role ?? r.actor_type ?? '',
    r.actor_email ?? '',
    r.ip ?? '',
    r.location ?? '',
    shortDevice(r.user_agent),
    r.household ?? '',
    // Sheets treats a leading "=" or "+" as a formula; detail is raw JSON from
    // callers, so it is neutralised before it can be evaluated in someone's tab.
    (r.detail ?? '').replace(/^[=+\-@]/, "'$&").slice(0, 800),
    r.event_id,
  ])

  const newest = rows.length ? rows[rows.length - 1].occurred_at : since

  return NextResponse.json(
    {
      ok: true,
      headers: ANALYTICS_HEADERS,
      values,
      cursor: newest ? new Date(newest).toISOString() : null,
      // The sheet keeps polling while this is true, so a backlog drains fully
      // instead of one page per five minutes.
      more: rows.length === PAGE,
      count: rows.length,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
