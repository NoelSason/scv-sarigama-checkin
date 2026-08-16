import { NextResponse } from 'next/server'
import { z } from 'zod'
import { query } from '@/lib/db'
import { PROGRAM } from '@/lib/analytics/program'
import { requestContext } from '@/lib/request-context'

export const dynamic = 'force-dynamic'

/**
 * Record when a run-sheet item actually started, or clear the record.
 *
 * Shared rather than kept in the browser: the point of the tracker is that the
 * three people running the show see the same answer to "how far behind are we",
 * and a localStorage version would give each of them their own.
 *
 * Like the attendance endpoint, this is reachable without a login, so the
 * damage a stranger can do is bounded by construction: the only thing that can
 * be written is a timestamp against one of the fixed item keys compiled into
 * the run sheet. No free-text keys, no rows created, nothing about money or
 * admissions.
 */

const ITEM_KEYS = new Set(PROGRAM.map((i) => i.key))

const Body = z.object({
  itemKey: z.string().max(64),
  /** ISO 8601. Omit for "right now"; null clears the mark. */
  startedAt: z.string().datetime().nullish(),
  clear: z.boolean().optional(),
})

export async function POST(req: Request) {
  let parsed: z.infer<typeof Body>
  try {
    parsed = Body.parse(await req.json())
  } catch {
    return NextResponse.json({ error: 'INVALID_REQUEST' }, { status: 400 })
  }

  if (!ITEM_KEYS.has(parsed.itemKey)) {
    return NextResponse.json({ error: 'UNKNOWN_ITEM' }, { status: 404 })
  }

  const item = PROGRAM.find((i) => i.key === parsed.itemKey)
  if (item?.derivedFrom) {
    // These two read off the scanner. Letting a tap overwrite them would
    // replace a measurement with a guess.
    return NextResponse.json({ error: 'ITEM_IS_DERIVED' }, { status: 409 })
  }

  if (parsed.clear) {
    await query(`delete from program_marks where item_key = $1`, [parsed.itemKey])
  } else {
    const at = parsed.startedAt ?? new Date().toISOString()
    await query(
      `insert into program_marks (item_key, started_at) values ($1, $2)
       on conflict (item_key) do update set started_at = excluded.started_at`,
      [parsed.itemKey, at],
    )
  }

  const ctx = await requestContext()
  await query(
    `insert into audit_logs
       (actor_type, actor_id, action, metadata, ip, user_agent,
        geo_city, geo_region, geo_country, request_path)
     values ('system', 'analytics_page', $1, $2, $3, $4, $5, $6, $7, '/2026onamanalytics')`,
    [
      parsed.clear ? 'program_item_unmarked' : 'program_item_started',
      JSON.stringify({ item: parsed.itemKey, title: item?.title, at: parsed.startedAt ?? 'now' }),
      ctx.ip,
      ctx.userAgent,
      ctx.geoCity,
      ctx.geoRegion,
      ctx.geoCountry,
    ],
  )

  return NextResponse.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } })
}
