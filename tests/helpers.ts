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
     values ($1, $2, $3, $4, $5::payment_status, $6, $7, true, 'seed')
     returning *`,
    [
      name,
      opts.purchased ?? 0,
      opts.redeemed ?? 0,
      opts.under6 ?? 0,
      opts.status ?? 'paid',
      opts.enabled ?? true,
      generatePassToken(),
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

/** Remove every row created by tests. Never touches real households. */
export async function purgeTestData(): Promise<void> {
  await query(
    `delete from audit_logs where household_id in (select id from households where is_test)`,
  )
  await query(
    `delete from redemption_adjustments where household_id in (select id from households where is_test)`,
  )
  await query(
    `delete from redemptions where household_id in (select id from households where is_test)`,
  )
  await query(
    `delete from email_deliveries where household_id in (select id from households where is_test)`,
  )
  await query(
    `delete from review_items where household_id in (select id from households where is_test)`,
  )
  await query('delete from households where is_test')
}
