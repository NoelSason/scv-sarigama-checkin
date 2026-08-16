import { NextResponse } from 'next/server'
import { z } from 'zod'
import { query, queryOne } from '@/lib/db'
import { requestContext } from '@/lib/request-context'

export const dynamic = 'force-dynamic'

/**
 * Record (or clear) guests who ate without being scanned in.
 *
 * The Sadhya line outran the scanner near the end, so a number of families were
 * waved through un-checked-in. This lets the organizers say so afterwards.
 *
 * Deliberately NOT a redemption:
 *
 *   * It does not touch `tickets_redeemed`, so door-throughput numbers stay
 *     what the scanner actually observed.
 *   * It carries no timestamp of arrival, so the analytics page keeps it out of
 *     every clock-based chart rather than inventing a time.
 *
 * The page this serves has no login — the event is over and the organizers
 * wanted it open on any phone — so the endpoint's job is to make the worst
 * possible caller boring: it can only ever move a number between 0 and the
 * admissions that household actually paid for and did not scan, on a household
 * that already exists. Every call is written to the audit log with its address.
 */

const Body = z.object({
  householdId: z.string().uuid(),
  /** 0 clears the mark entirely. */
  quantity: z.number().int().min(0).max(100),
  note: z.string().trim().max(200).optional(),
})

export async function POST(req: Request) {
  let parsed: z.infer<typeof Body>
  try {
    parsed = Body.parse(await req.json())
  } catch {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 })
  }

  const household = await queryOne<{
    id: string
    display_name: string
    tickets_remaining: number
    is_test: boolean
    merged_into_id: string | null
  }>(
    `select id, display_name, tickets_remaining, is_test, merged_into_id
       from households where id = $1`,
    [parsed.householdId],
  )

  if (!household || household.is_test || household.merged_into_id) {
    return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })
  }

  // The ceiling is the ledger's, not the caller's. Nobody can be marked present
  // for more meals than they bought and did not already scan in for.
  if (parsed.quantity > household.tickets_remaining) {
    return NextResponse.json(
      { error: 'TOO_MANY', maximum: household.tickets_remaining },
      { status: 400 },
    )
  }

  if (parsed.quantity === 0) {
    await query(`delete from attendance_marks where household_id = $1`, [household.id])
  } else {
    await query(
      `insert into attendance_marks (household_id, quantity, note, marked_by)
            values ($1, $2, $3, 'analytics page')
       on conflict (household_id) do update
          set quantity = excluded.quantity,
              note     = excluded.note`,
      [household.id, parsed.quantity, parsed.note ?? null],
    )
  }

  const ctx = await requestContext()
  await query(
    `insert into audit_logs
       (actor_type, actor_id, action, household_id, metadata, ip, user_agent,
        geo_city, geo_region, geo_country, request_path)
     values ('system', 'analytics_page', $1, $2, $3, $4, $5, $6, $7, $8, '/2026onamanalytics')`,
    [
      parsed.quantity === 0 ? 'attendance_mark_cleared' : 'attendance_marked_present',
      household.id,
      JSON.stringify({
        quantity: parsed.quantity,
        of_remaining: household.tickets_remaining,
        note: parsed.note ?? null,
      }),
      ctx.ip,
      ctx.userAgent,
      ctx.geoCity,
      ctx.geoRegion,
      ctx.geoCountry,
    ],
  )

  return NextResponse.json(
    { ok: true, householdId: household.id, quantity: parsed.quantity },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
