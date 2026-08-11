import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaffApi } from '@/lib/auth'
import { queryOne } from '@/lib/db'
import { logAudit } from '@/lib/households'

export const dynamic = 'force-dynamic'

const Id = z.string().uuid()

const Body = z.object({
  action: z.enum(['resolve', 'dismiss', 'reopen']),
  note: z.string().trim().max(300).optional(),
})

type ReviewRow = {
  id: string
  kind: string
  household_id: string | null
  summary: string
  status: string
}

/**
 * Close out a review item.
 *
 * Nothing about the household changes here — an item is a note saying "a human
 * must look at this", and closing it only records that a human did. Any actual
 * correction happens through the ticket, pass, or reversal endpoints, each of
 * which leaves its own audit row.
 *
 * 'reopen' exists because dismissing the wrong row at 11pm the night before the
 * event should not be a one-way door.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaffApi('admin')
  if (!staff) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  const { id } = await params
  if (!Id.safeParse(id).success) return NextResponse.json({ error: 'INVALID' }, { status: 400 })

  let body: z.infer<typeof Body>
  try {
    body = Body.parse(await req.json())
  } catch (err) {
    return NextResponse.json(
      { error: 'INVALID', detail: err instanceof z.ZodError ? err.issues : undefined },
      { status: 400 },
    )
  }

  const before = await queryOne<ReviewRow>(
    'select id, kind, household_id, summary, status from review_items where id = $1',
    [id],
  )
  if (!before) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  const status =
    body.action === 'resolve' ? 'resolved' : body.action === 'dismiss' ? 'dismissed' : 'open'

  const updated = await queryOne<ReviewRow & { resolved_at: string | null }>(
    `update review_items
        set status      = $1::review_status,
            resolved_by = case when $1 = 'open' then null else $2::uuid end,
            resolved_at = case when $1 = 'open' then null else now() end,
            resolution  = case when $1 = 'open' then null else $3::jsonb end
      where id = $4
      returning id, kind, household_id, summary, status::text as status, resolved_at`,
    [status, staff.id, JSON.stringify({ by: staff.name, note: body.note?.trim() || null }), id],
  )

  const AUDIT_ACTION = {
    resolve: 'review_item_resolved',
    dismiss: 'review_item_dismissed',
    reopen: 'review_item_reopened',
  } as const

  await logAudit(AUDIT_ACTION[body.action], {
    actorId: staff.id,
    householdId: before.household_id,
    metadata: {
      by: staff.name,
      review_item_id: id,
      kind: before.kind,
      summary: before.summary,
      note: body.note?.trim() || null,
    },
  })

  return NextResponse.json({ item: updated }, { headers: { 'Cache-Control': 'no-store' } })
}
