import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaffApi } from '@/lib/auth'
import { logAudit } from '@/lib/households'
import { SheetSchemaError, SheetsCredentialError } from '@/lib/sheets'
import { syncSheet } from '@/lib/sheet-sync'

export const dynamic = 'force-dynamic'
// A first import creates ~90 households one at a time. Steady-state runs are
// near-instant because unchanged rows cost nothing.
export const maxDuration = 60

const Body = z
  .object({
    commit: z.boolean().default(false),
    tab: z.string().trim().min(1).max(120).optional(),
    note: z.string().trim().max(200).optional(),
  })
  .default({ commit: false })

/**
 * Admin-triggered sheet sync.
 *
 * Admin-only, not registration-only: a sync can change ticket counts across
 * the whole event, which is not a decision to make from the check-in desk.
 * Defaults to a dry run so the button is safe to press to see what *would*
 * happen.
 */
export async function POST(req: Request) {
  const staff = await requireStaffApi('admin')
  if (!staff) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  let body: z.infer<typeof Body>
  try {
    const raw = await req.text()
    body = Body.parse(raw ? JSON.parse(raw) : {})
  } catch (err) {
    return NextResponse.json(
      { error: 'INVALID', detail: err instanceof z.ZodError ? err.issues : undefined },
      { status: 400 },
    )
  }

  try {
    const summary = await syncSheet({
      commit: body.commit,
      tab: body.tab,
      actorId: staff.id,
      note: body.note ?? `Sheet sync by ${staff.name}`,
    })

    if (body.commit) {
      await logAudit('sheet_sync_committed', {
        actorId: staff.id,
        metadata: {
          counts: summary.counts,
          reviewsOpened: summary.reviewsOpened,
          importBatchId: summary.importBatchId,
          by: staff.name,
        },
      })
    }

    return NextResponse.json(summary, { headers: { 'Cache-Control': 'no-store' } })
  } catch (err) {
    // A missing service account or a renamed tab is a configuration problem an
    // organizer can fix, so return the actionable message rather than a 500.
    if (err instanceof SheetsCredentialError || err instanceof SheetSchemaError) {
      return NextResponse.json({ error: 'SHEET_UNAVAILABLE', detail: err.message }, { status: 503 })
    }
    throw err
  }
}
