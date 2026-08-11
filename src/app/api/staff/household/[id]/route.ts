import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireStaffApi } from '@/lib/auth'
import { query } from '@/lib/db'
import { findById, logAudit } from '@/lib/households'
import { normalizeEmail, normalizePhone } from '@/lib/tokens'

export const dynamic = 'force-dynamic'

const Id = z.string().uuid()

const Patch = z.object({
  displayName: z.string().trim().min(2).max(120),
  email: z.string().trim().email().optional().or(z.literal('')),
  phone: z.string().trim().max(30).optional().or(z.literal('')),
  notes: z.string().trim().max(500).optional().or(z.literal('')),
})

type HistoryItem =
  | {
      kind: 'redemption'
      id: string
      at: string
      staff: string | null
      quantity: number
      device: string | null
      reversed: boolean
    }
  | { kind: 'adjustment'; id: string; at: string; staff: string | null; delta: number; reason: string }
  | {
      kind: 'audit'
      id: string
      at: string
      staff: string | null
      action: string
      metadata: Record<string, unknown>
    }

/**
 * Household detail plus its full paper trail.
 *
 * History is assembled from three tables. audit_logs rows for 'redemption' and
 * 'redemption_reversal' are dropped because the redemptions and
 * redemption_adjustments rows are the same events with better fields — showing
 * both would make every scan look like it happened twice.
 *
 * Staff names are joined here rather than stored on the events, so a row
 * written by a database function (which only records the staff uuid) still
 * reads as a person's name at the desk.
 */
async function loadHistory(householdId: string): Promise<HistoryItem[]> {
  const [redemptions, adjustments, audits] = await Promise.all([
    query<{
      id: string
      at: string
      staff: string | null
      quantity: number
      device: string | null
      reversed_at: string | null
    }>(
      `select r.id, r.created_at as at, u.name as staff, r.quantity,
              r.device_name as device, r.reversed_at
         from redemptions r
         left join staff_users u on u.id = r.staff_user_id
        where r.household_id = $1
        order by r.created_at desc
        limit 200`,
      [householdId],
    ),
    query<{ id: string; at: string; staff: string | null; delta: number; reason: string }>(
      `select a.id, a.created_at as at, u.name as staff,
              a.quantity_delta as delta, a.reason
         from redemption_adjustments a
         left join staff_users u on u.id = a.staff_user_id
        where a.household_id = $1
        order by a.created_at desc
        limit 200`,
      [householdId],
    ),
    query<{
      id: string
      at: string
      staff: string | null
      action: string
      metadata: Record<string, unknown>
    }>(
      // actor_id is text and may hold non-uuid values ('system'), so cast the
      // staff id to text rather than the other way round.
      `select l.id, l.created_at as at, u.name as staff, l.action, l.metadata
         from audit_logs l
         left join staff_users u
           on l.actor_type = 'staff' and u.id::text = l.actor_id
        where l.household_id = $1
          and l.action not in ('redemption', 'redemption_reversal')
        order by l.created_at desc
        limit 200`,
      [householdId],
    ),
  ])

  const items: HistoryItem[] = [
    ...redemptions.map((r) => ({
      kind: 'redemption' as const,
      id: r.id,
      at: r.at,
      staff: r.staff,
      quantity: r.quantity,
      device: r.device,
      reversed: r.reversed_at !== null,
    })),
    ...adjustments.map((a) => ({
      kind: 'adjustment' as const,
      id: a.id,
      at: a.at,
      staff: a.staff,
      delta: a.delta,
      reason: a.reason,
    })),
    ...audits.map((l) => ({
      kind: 'audit' as const,
      id: l.id,
      at: l.at,
      staff: l.staff,
      action: l.action,
      metadata: l.metadata ?? {},
    })),
  ]

  return items.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime())
}

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaffApi('registration')
  if (!staff) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  const { id } = await params
  if (!Id.safeParse(id).success) {
    return NextResponse.json({ error: 'INVALID' }, { status: 400 })
  }

  const household = await findById(id)
  if (!household) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  const history = await loadHistory(id)
  return NextResponse.json({ household, history }, { headers: { 'Cache-Control': 'no-store' } })
}

/**
 * Contact detail correction — never touches money or ticket counts, so it needs
 * no confirmation step. The normalized columns are rewritten alongside the raw
 * ones or search would keep finding the old address.
 */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const staff = await requireStaffApi('registration')
  if (!staff) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  const { id } = await params
  if (!Id.safeParse(id).success) {
    return NextResponse.json({ error: 'INVALID' }, { status: 400 })
  }

  let body: z.infer<typeof Patch>
  try {
    body = Patch.parse(await req.json())
  } catch (err) {
    return NextResponse.json(
      { error: 'INVALID', detail: err instanceof z.ZodError ? err.issues : undefined },
      { status: 400 },
    )
  }

  const before = await findById(id)
  if (!before) return NextResponse.json({ error: 'NOT_FOUND' }, { status: 404 })

  const email = body.email?.trim() || null
  const phone = body.phone?.trim() || null

  await query(
    `update households
        set display_name     = $1,
            email            = $2,
            phone            = $3,
            normalized_email = $4,
            normalized_phone = $5,
            notes            = $6
      where id = $7`,
    [
      body.displayName.trim(),
      email,
      phone,
      normalizeEmail(email),
      normalizePhone(phone),
      body.notes?.trim() || null,
      id,
    ],
  )

  const household = await findById(id)

  await logAudit('contact_details_edited', {
    actorId: staff.id,
    householdId: id,
    metadata: {
      by: staff.name,
      from: { name: before.display_name, email: before.email, phone: before.phone },
      to: { name: body.displayName.trim(), email, phone },
    },
  })

  return NextResponse.json({ household })
}
