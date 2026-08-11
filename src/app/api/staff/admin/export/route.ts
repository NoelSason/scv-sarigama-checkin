import { requireStaffApi } from '@/lib/auth'
import { query } from '@/lib/db'
import { logAudit, passUrl } from '@/lib/households'

export const dynamic = 'force-dynamic'

type Row = {
  id: string
  display_name: string
  email: string | null
  phone: string | null
  payment_status: string
  payment_method: string | null
  amount_paid_cents: number | null
  tickets_purchased: number
  tickets_redeemed: number
  tickets_remaining: number
  children_under_6: number
  pass_enabled: boolean
  pass_token: string
  source: string | null
  source_record_id: string | null
  square_order_id: string | null
  is_test: boolean
  notes: string | null
  created_at: unknown
  updated_at: unknown
}

const HEADERS = [
  'household_id',
  'name',
  'email',
  'phone',
  'payment_status',
  'payment_method',
  'amount_paid_usd',
  'tickets_purchased',
  'tickets_redeemed',
  'tickets_remaining',
  'children_under_6_not_ticketed',
  'pass_enabled',
  'pass_url',
  'source',
  'source_record_id',
  'square_order_id',
  'is_test_row',
  'notes',
  'created_at',
  'updated_at',
]

/**
 * A cell starting with = + - or @ is executed as a formula by Excel and Sheets.
 * This export is opened by volunteers on their own laptops, and a household
 * name is attacker-controlled text, so neutralise it with a leading quote.
 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let s = value instanceof Date ? value.toISOString() : String(value)
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

/**
 * Full household export.
 *
 * Includes test rows, flagged in their own column, because an export that
 * silently dropped rows would be a worse lie than one that labels them.
 */
export async function GET() {
  const staff = await requireStaffApi('admin')
  if (!staff) return new Response('Unauthorized', { status: 401 })

  const rows = await query<Row>(
    `select id, display_name, email, phone,
            payment_status::text as payment_status,
            payment_method::text as payment_method,
            amount_paid_cents, tickets_purchased, tickets_redeemed, tickets_remaining,
            children_under_6, pass_enabled, pass_token, source, source_record_id,
            square_order_id, is_test, notes, created_at, updated_at
       from households
      order by display_name asc`,
  )

  const lines = [HEADERS.join(',')]
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.display_name,
        r.email,
        r.phone,
        r.payment_status,
        r.payment_method,
        r.amount_paid_cents === null ? '' : (r.amount_paid_cents / 100).toFixed(2),
        r.tickets_purchased,
        r.tickets_redeemed,
        r.tickets_remaining,
        r.children_under_6,
        r.pass_enabled ? 'yes' : 'no',
        passUrl(r.pass_token),
        r.source,
        r.source_record_id,
        r.square_order_id,
        r.is_test ? 'TEST' : '',
        r.notes,
        r.created_at,
        r.updated_at,
      ]
        .map(cell)
        .join(','),
    )
  }

  await logAudit('admin_csv_export', {
    actorId: staff.id,
    metadata: { by: staff.name, rows: rows.length },
  })

  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')

  // BOM so Excel reads it as UTF-8 — Malayalam names come out as mojibake
  // without it.
  return new Response('﻿' + lines.join('\r\n') + '\r\n', {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="onam-households-${stamp}.csv"`,
      'Cache-Control': 'no-store',
    },
  })
}
