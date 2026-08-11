import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { logAudit } from '@/lib/households'
import { syncSheet } from '@/lib/sheet-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

const Body = z.object({
  // Raw grid straight off the sheet, header row included. The parser owns all
  // interpretation, so the Apps Script stays a dumb pipe and never has to know
  // which column means what.
  values: z.array(z.array(z.string())).min(1).max(2000),
  commit: z.boolean().default(true),
})

/**
 * Push endpoint for the Google Apps Script bound to the payments sheet.
 *
 * Why push rather than pull: pulling needs a Google service account with the
 * sheet shared to it. The Apps Script already runs as the sheet's owner, so it
 * can just hand us the rows — no extra credential to create, leak, or rotate.
 *
 * Safe to call repeatedly. Row identity is a content fingerprint and the
 * unique index on (source, source_record_id) means an unchanged row is a
 * no-op; an edited row that can't be matched confidently opens a review item
 * instead of silently creating a second household for the same family.
 */
export async function POST(req: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) {
    return NextResponse.json({ error: 'NOT_CONFIGURED' }, { status: 503 })
  }

  const offered = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const a = Buffer.from(offered)
  const b = Buffer.from(secret)
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }

  let body: z.infer<typeof Body>
  try {
    body = Body.parse(await req.json())
  } catch (err) {
    return NextResponse.json(
      { error: 'INVALID', detail: err instanceof z.ZodError ? err.issues : undefined },
      { status: 400 },
    )
  }

  try {
    const summary = await syncSheet({
      values: body.values,
      commit: body.commit,
      actorId: null,
      note: 'apps script push',
    })

    // Only worth an audit line when something actually moved — this runs on a
    // timer and a quiet log is what makes the noisy entries findable.
    const changed = summary.counts.create + summary.counts.update + summary.counts.review
    if (changed > 0) {
      await logAudit('sheet_pushed', {
        actorType: 'system',
        metadata: { counts: summary.counts, rows: body.values.length },
      })
    }

    return NextResponse.json(
      { ok: true, counts: summary.counts, stats: summary.stats },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : 'sync failed'
    return NextResponse.json({ ok: false, error: message }, { status: 500 })
  }
}
