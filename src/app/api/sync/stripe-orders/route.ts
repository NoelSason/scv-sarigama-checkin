import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { query } from '@/lib/db'
import { logAudit } from '@/lib/households'

export const dynamic = 'force-dynamic'

/**
 * Paid Stripe orders, for the Apps Script to append to the "Stripe Orders" tab.
 *
 * The walk-ins feed already puts each Stripe household into the ledger, but the
 * ledger's columns can't carry an order's breakdown — sponsorships, donations,
 * and the Onam Program Registration answers collected at checkout (the Google
 * Form they replace was closed). Those live in pay_orders, so they get their
 * own tab.
 *
 * Two steps on purpose, same as the walk-ins. GET hands over the rows; POST
 * confirms they landed. If the append fails halfway, nothing is marked and the
 * next run retries. Marking on read would lose an order on any network hiccup,
 * and a lost row here means a purchase missing from the organizers' record.
 */

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const offered = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const a = Buffer.from(offered)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

type Row = {
  id: string
  order_number: string
  customer_name: string
  email: string | null
  phone: string | null
  amount_total_cents: number
  adults: number
  kids: number
  sponsor_gold: number
  sponsor_silver: number
  donation_cents: number
  perform_interested: boolean | null
  perform_kind: string | null
  perform_name: string | null
  perform_members: string | null
  perform_type: string | null
  perform_type_other: string | null
  perform_media: boolean | null
  perform_stage: boolean | null
  paid_at: string
  perform_notes: string | null
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  // Only rows the webhook has confirmed. A pending row is an abandoned (or
  // not-yet-finished) checkout and must never reach the money record.
  // paid_at is coalesced defensively: a paid row without it would otherwise
  // crash the export and block everything behind it.
  const rows = await query<Row>(
    `select id, order_number, customer_name, email, phone,
            amount_total_cents, adults, kids, sponsor_gold, sponsor_silver,
            donation_cents, perform_interested, perform_kind, perform_name,
            perform_members, perform_type, perform_type_other, perform_media,
            perform_stage, perform_notes,
            coalesce(paid_at, created_at) as paid_at
       from pay_orders
      where status = 'paid'
        and not is_test
        and exported_to_sheet_at is null
      order by paid_at
      limit 200`,
  )

  // Column order mirrors the "Stripe Orders" tab header exactly:
  // Timestamp | Order # | Name | Email | Phone | Total $ | Adults (6+) |
  // Under 6 | Gold | Silver | Donation $ | Performing? | Individual or Group |
  // Performer name | Members | Performance type | Media? | Stage/requirements
  const values = rows.map((r) => {
    // The registration questions are optional at checkout, so null means
    // "never asked / never answered" — a blank cell, not a No.
    const performanceType =
      r.perform_type == null
        ? ''
        : r.perform_type === 'other' && r.perform_type_other
          ? `Other: ${r.perform_type_other}`
          : titleCase(r.perform_type)

    const stage =
      r.perform_stage === true
        ? r.perform_notes
          ? `Yes — ${r.perform_notes}`
          : 'Yes'
        : yesNo(r.perform_stage)

    return [
      formatTimestamp(r.paid_at),
      r.order_number,
      r.customer_name,
      r.email ?? '',
      r.phone ?? '',
      (r.amount_total_cents / 100).toFixed(2),
      String(r.adults),
      String(r.kids),
      String(r.sponsor_gold),
      String(r.sponsor_silver),
      // Blank when nothing was donated: a column of 0.00s buries the orders
      // that actually carried one.
      r.donation_cents > 0 ? (r.donation_cents / 100).toFixed(2) : '',
      yesNo(r.perform_interested),
      r.perform_kind ? titleCase(r.perform_kind) : '',
      r.perform_name ?? '',
      r.perform_members ?? '',
      performanceType,
      yesNo(r.perform_media),
      stage,
    ]
  })

  return NextResponse.json(
    { ids: rows.map((r) => r.id), values },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

const Confirm = z.object({ ids: z.array(z.string().uuid()).min(1).max(200) })

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  let body: z.infer<typeof Confirm>
  try {
    body = Confirm.parse(await req.json())
  } catch {
    return NextResponse.json({ error: 'INVALID' }, { status: 400 })
  }

  const updated = await query<{ id: string }>(
    `update pay_orders
        set exported_to_sheet_at = now()
      where id = any($1::uuid[])
        and exported_to_sheet_at is null
      returning id`,
    [body.ids],
  )

  if (updated.length > 0) {
    await logAudit('stripe_orders_written_to_sheet', {
      actorType: 'system',
      metadata: { count: updated.length },
    })
  }

  return NextResponse.json({ ok: true, marked: updated.length })
}

/** Matches the sheet's existing `M/D/YYYY H:MM:SS` style. */
function formatTimestamp(iso: string): string {
  const d = new Date(iso)
  const date = `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`
  const time = d.toLocaleTimeString('en-US', { hour12: false })
  return `${date} ${time}`
}

/** null stays blank — an unanswered question is not a No. */
function yesNo(value: boolean | null): string {
  return value == null ? '' : value ? 'Yes' : 'No'
}

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
