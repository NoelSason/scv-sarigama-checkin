import { query, queryOne } from '@/lib/db'
import { generatePassToken } from '@/lib/tokens'

export type Household = {
  id: string
  display_name: string
  tickets_purchased: number
  tickets_redeemed: number
  tickets_remaining: number
  children_under_6: number
  payment_status: string
  pass_enabled: boolean
  pass_token: string
}

let seq = 0

/**
 * Rows created by the test suite carry this source so cleanup can target them
 * exactly. `is_test` alone is not specific enough: seeded demo households are
 * also flagged is_test, and a test run must never delete those.
 */
const TEST_SOURCE = 'vitest'

/**
 * Create a throwaway household. Always is_test = true so a stray row can
 * never be confused with a real guest, and purgeTestData() can clear it.
 */
export async function makeHousehold(opts: {
  purchased?: number
  redeemed?: number
  status?: string
  enabled?: boolean
  under6?: number
  name?: string
}): Promise<Household> {
  const name = opts.name ?? `TEST Household ${Date.now()}-${seq++}`
  const row = await queryOne<Household>(
    `insert into households
       (display_name, tickets_purchased, tickets_redeemed, children_under_6,
        payment_status, pass_enabled, pass_token, is_test, source)
     values ($1, $2, $3, $4, $5::payment_status, $6, $7, true, $8)
     returning *`,
    [
      name,
      opts.purchased ?? 0,
      opts.redeemed ?? 0,
      opts.under6 ?? 0,
      opts.status ?? 'paid',
      opts.enabled ?? true,
      generatePassToken(),
      TEST_SOURCE,
    ],
  )
  if (!row) throw new Error('failed to create test household')
  return row
}

export async function getHousehold(id: string): Promise<Household | null> {
  return queryOne<Household>('select * from households where id = $1', [id])
}

export async function redeem(
  householdId: string,
  quantity: number,
  device = 'test-device',
): Promise<Record<string, unknown>> {
  const row = await queryOne<{ redeem_tickets: Record<string, unknown> }>(
    'select redeem_tickets($1::uuid, $2::int, null, $3::text) as redeem_tickets',
    [householdId, quantity, device],
  )
  return row!.redeem_tickets
}

export async function reverse(
  redemptionId: string,
  quantity: number,
  reason: string,
): Promise<Record<string, unknown>> {
  const row = await queryOne<{ reverse_redemption: Record<string, unknown> }>(
    'select reverse_redemption($1::uuid, $2::int, $3::text, null) as reverse_redemption',
    [redemptionId, quantity, reason],
  )
  return row!.reverse_redemption
}

export async function giveBack(
  householdId: string,
  quantity: number,
  reason: string,
): Promise<Record<string, unknown>> {
  const row = await queryOne<{ give_back_tickets: Record<string, unknown> }>(
    'select give_back_tickets($1::uuid, $2::int, $3::text, null) as give_back_tickets',
    [householdId, quantity, reason],
  )
  return row!.give_back_tickets
}

export async function adjustCount(
  householdId: string,
  newTotal: number,
  reason: string,
): Promise<Record<string, unknown>> {
  const row = await queryOne<{ adjust_ticket_count: Record<string, unknown> }>(
    'select adjust_ticket_count($1::uuid, $2::int, $3::text, null) as adjust_ticket_count',
    [householdId, newTotal, reason],
  )
  return row!.adjust_ticket_count
}

export async function auditFor(householdId: string) {
  return query<{ action: string; metadata: Record<string, unknown> }>(
    'select action, metadata from audit_logs where household_id = $1 order by created_at',
    [householdId],
  )
}

/**
 * Remove rows this suite created — and only those.
 *
 * Scoped to source = 'vitest' rather than to is_test, so running the tests can
 * never wipe seeded demo households (which are also is_test) or, obviously,
 * anything real.
 */
export async function purgeTestData(): Promise<void> {
  const scope = `select id from households where source = '${TEST_SOURCE}'`
  for (const table of [
    'audit_logs',
    'redemption_adjustments',
    'redemptions',
    'email_deliveries',
    'review_items',
  ]) {
    await query(`delete from ${table} where household_id in (${scope})`)
  }
  await query(`delete from households where source = $1`, [TEST_SOURCE])
}
