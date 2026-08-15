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
 *
 * The tab is read by a human during the event, so it carries what happened at
 * the event: a guest opening their pass, a pass emailed, a payment, a scan, a
 * volunteer signing in. `event_stream` stays the complete record — the curating
 * happens here, and nothing is deleted by it.
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
  'When (PT)',
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

/**
 * Machinery, not event day.
 *
 * These are the sheet round-trip talking to itself — a push finishing, a
 * household re-written because Square delivered the same payment a fourth time.
 * They fire on a timer whether or not a single guest has walked in, and at five
 * pushes an hour they bury the rows a human is actually watching for. The
 * `sync` category (every sheet-push run, start and finish) goes with them.
 *
 * Deliberately kept: `square.webhook.household_created`, which is a family
 * appearing for the first time, and happens once.
 */
export const HIDDEN_ACTIONS = [
  'sheet_pushed',
  'sheet_sync_committed',
  'sheet_household_imported',
  'sheet_household_updated',
  'walkins_written_to_sheet',
  'stripe_orders_written_to_sheet',
  'square.webhook.household_updated',
  // The same sign-in, twice. The `login` row is the better half: it carries the
  // address, the place and the phone, where this one carries "via: password".
  'staff_signed_in',
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

/**
 * Timestamps are stored in UTC and read in California, so the sheet shows local
 * time. Sortable order is kept — "YYYY-MM-DD HH:mm:ss", same shape as before.
 */
const PACIFIC = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'America/Los_Angeles',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
})

function pacific(iso: string): string {
  return PACIFIC.format(new Date(iso))
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
    // One row per sale. Square re-delivers the same payment as a stream of
    // payment.updated webhooks — one purchase this morning arrived five times —
    // and each delivery is its own idempotency record, so the raw stream shows
    // a family buying tickets over and over.
    //
    // The first delivery is the one shown, ranked over the whole table rather
    // than within this poll's window: "first" has to mean the same thing on
    // every run, or a later delivery would look like the earliest one this run
    // has seen and land in the sheet as a second row for a sale already listed.
    //
    // Its household is filled in from a sibling delivery, because the first
    // webhook lands before the app has worked out whose payment it is — leaving
    // the canonical row stable but nameless otherwise.
    //
    // A refund carries the payment's id too, so it is ranked separately: money
    // going back out is not the same event as money coming in.
    `with delivery as (
       select p.id,
              coalesce(p.external_payment_id, p.id::text) as sale,
              case when p.event_type like 'refund%' then 'refund' else 'payment' end as kind,
              p.household_id,
              p.created_at
         from payment_events p
     ),
     canonical as (
       select distinct on (sale, kind) id, sale, kind
         from delivery
        order by sale, kind, created_at, id
     ),
     named as (
       select distinct on (sale, kind) sale, kind, household_id
         from delivery
        where household_id is not null
        order by sale, kind, created_at, id
     )
     select e.event_id, e.occurred_at, e.category, e.action, e.actor, e.actor_type,
            e.actor_role, e.actor_email, e.ip, e.location, e.user_agent,
            coalesce(e.household, buyer.display_name) as household,
            e.detail
       from event_stream e
       left join canonical  c     on 'payment:' || c.id = e.event_id
       left join named      n     on n.sale = c.sale and n.kind = c.kind
       left join households buyer on buyer.id = n.household_id
      where e.occurred_at > coalesce($1::timestamptz, '-infinity'::timestamptz)
        and e.category <> 'sync'
        and not (e.category = 'action' and e.action = any($2::text[]))
        and (e.category <> 'payment' or c.id is not null)
      order by e.occurred_at asc
      limit ${PAGE}`,
    [
      valid ? new Date(sinceDate.getTime() - OVERLAP_SECONDS * 1000).toISOString() : null,
      HIDDEN_ACTIONS,
    ],
  )

  const values = rows.map((r) => [
    pacific(r.occurred_at),
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
