import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { query } from '@/lib/db'
import { logAudit } from '@/lib/households'
import { CHECKIN_APP_MARKER } from '@/lib/sheets'

export const dynamic = 'force-dynamic'

/**
 * Walk-ins, for the Apps Script to append to the payments sheet.
 *
 * The app owns walk-ins, but the organizers' record of who paid is the
 * spreadsheet — so anyone reading it afterwards would otherwise see an
 * incomplete picture of the money.
 *
 * Two steps on purpose. GET hands over the rows; POST confirms they landed.
 * If the append fails halfway, nothing is marked and the next run retries.
 * Marking on read would lose a row on any network hiccup, and a lost row here
 * means a family missing from the financial record.
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
  display_name: string
  amount_paid_cents: number | null
  tickets_purchased: number
  children_under_6: number
  payment_method: string | null
  payment_status: string
  email: string | null
  phone: string | null
  created_at: string
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  // Walk-ins AND new online Square sales. Both are money the sheet would
  // otherwise never learn about: previously somebody typed each card purchase
  // in by hand. Everything present at import time was backfilled as already
  // exported, so the 51 Credit Card rows already in the sheet are not
  // duplicated — only sales made from here on flow back.
  const rows = await query<Row>(
    `select id, display_name, amount_paid_cents, tickets_purchased, children_under_6,
            payment_method::text as payment_method, payment_status::text as payment_status,
            email, phone, created_at
       from households
      where source in ('walk_in', 'square')
        and exported_to_sheet_at is null
        and not is_test
        and payment_status in ('paid', 'comped')
      order by created_at
      limit 200`,
  )

  // Column order mirrors "Form Responses 1" exactly:
  // Timestamp | Your Name | Amount Paid | No Of People | Payment Mode |
  // Pre-pay | Bands? | performing? | Individual or Group? | Details
  const values = rows.map((r) => {
    const method =
      r.payment_status === 'comped'
        ? 'Comp'
        : r.payment_method === 'square'
          ? 'Credit Card'
          : titleCase(r.payment_method ?? 'other')

    const notes = [
      r.payment_method === 'square' ? 'Bought online' : 'Added at the door via check-in app',
      r.children_under_6 > 0 ? `${r.children_under_6} under 6 (free)` : null,
      r.email,
      r.phone,
    ]
      .filter(Boolean)
      .join(' · ')

    return [
      formatTimestamp(r.created_at),
      r.display_name,
      r.amount_paid_cents == null ? '' : (r.amount_paid_cents / 100).toFixed(2),
      String(r.tickets_purchased),
      // The marker is what stops this row importing as a second household.
      `${method} ${CHECKIN_APP_MARKER}`,
      'TRUE',
      'FALSE',
      'No',
      '',
      notes,
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
    `update households
        set exported_to_sheet_at = now()
      where id = any($1::uuid[])
        and exported_to_sheet_at is null
      returning id`,
    [body.ids],
  )

  if (updated.length > 0) {
    await logAudit('walkins_written_to_sheet', {
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

function titleCase(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1)
}
