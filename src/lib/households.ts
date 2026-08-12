import { query, queryOne } from './db'
import { generatePassToken, normalizeEmail, normalizeName, normalizePhone } from './tokens'

export type PaymentStatus =
  | 'unpaid'
  | 'pending'
  | 'paid'
  | 'refunded'
  | 'partially_refunded'
  | 'comped'
  | 'needs_review'

export type PaymentMethod = 'square' | 'zelle' | 'cash' | 'complimentary' | 'other'

export type Household = {
  id: string
  display_name: string
  email: string | null
  phone: string | null
  payment_status: PaymentStatus
  payment_method: PaymentMethod | null
  amount_paid_cents: number | null
  tickets_purchased: number
  tickets_redeemed: number
  tickets_remaining: number
  children_under_6: number
  pass_token: string
  pass_enabled: boolean
  source: string | null
  source_record_id: string | null
  square_order_id: string | null
  is_test: boolean
  notes: string | null
  created_at: string
  updated_at: string
}

const COLUMNS = `
  id, display_name, email, phone, payment_status, payment_method,
  amount_paid_cents, tickets_purchased, tickets_redeemed, tickets_remaining,
  children_under_6, pass_token, pass_enabled, source, source_record_id,
  square_order_id, is_test, notes, created_at, updated_at
`

/**
 * Resolve a scanned or visited pass token.
 *
 * A token belonging to a merged-away purchase follows the pointer to the pass
 * that now carries its admissions. Merges normally keep whichever row was
 * already emailed, so this rarely fires — but if a guest ever holds the other
 * code, it must open their real pass rather than a disabled husk showing zero.
 */
export async function findByToken(token: string): Promise<Household | null> {
  const found = await queryOne<Household & { merged_into_id: string | null }>(
    `select ${COLUMNS}, merged_into_id from households where pass_token = $1`,
    [token],
  )
  if (!found) return null
  if (!found.merged_into_id) return found
  return findById(found.merged_into_id)
}

export async function findById(id: string): Promise<Household | null> {
  return queryOne<Household>(`select ${COLUMNS} from households where id = $1`, [id])
}

/**
 * Staff search across name, email, phone, and Square order id.
 *
 * Trigram similarity on the name means a volunteer typing "kavita" still finds
 * "Kavitha Raveendra Raja" — important when the desk is reading a name off a
 * phone screen. Exact matches sort first so the obvious answer is on top.
 */
export async function searchHouseholds(term: string, limit = 25): Promise<Household[]> {
  const raw = term.trim()
  if (raw.length < 2) return []

  const email = normalizeEmail(raw)
  const phone = normalizePhone(raw)
  const name = normalizeName(raw)

  return query<Household>(
    `select ${COLUMNS}
       from households
      where display_name ilike '%' || $1 || '%'
         or similarity(lower(display_name), $2) > 0.3
         or normalized_email = $3
         or email ilike '%' || $1 || '%'
         or normalized_phone = $4
         or phone like '%' || $1 || '%'
         or square_order_id = $1
         or source_record_id = $1
      order by
        (lower(display_name) = $2) desc,
        similarity(lower(display_name), $2) desc,
        display_name asc
      limit $5`,
    [raw, name, email, phone, limit],
  )
}

export type CreateHouseholdInput = {
  displayName: string
  email?: string | null
  phone?: string | null
  ticketsPurchased: number
  childrenUnder6?: number
  paymentStatus: PaymentStatus
  paymentMethod: PaymentMethod
  amountPaidCents?: number | null
  source: string
  sourceRecordId?: string | null
  squareOrderId?: string | null
  squarePaymentId?: string | null
  notes?: string | null
  isTest?: boolean
  importBatchId?: string | null
}

export async function createHousehold(input: CreateHouseholdInput): Promise<Household> {
  const row = await queryOne<Household>(
    `insert into households
       (display_name, email, phone, normalized_email, normalized_phone,
        tickets_purchased, children_under_6, payment_status, payment_method,
        amount_paid_cents, pass_token, source, source_record_id,
        square_order_id, square_payment_id, notes, is_test, import_batch_id)
     values ($1,$2,$3,$4,$5,$6,$7,$8::payment_status,$9::payment_method,
             $10,$11,$12,$13,$14,$15,$16,$17,$18)
     returning ${COLUMNS}`,
    [
      input.displayName.trim(),
      input.email?.trim() || null,
      input.phone?.trim() || null,
      normalizeEmail(input.email),
      normalizePhone(input.phone),
      input.ticketsPurchased,
      input.childrenUnder6 ?? 0,
      input.paymentStatus,
      input.paymentMethod,
      input.amountPaidCents ?? null,
      generatePassToken(),
      input.source,
      input.sourceRecordId ?? null,
      input.squareOrderId ?? null,
      input.squarePaymentId ?? null,
      input.notes ?? null,
      input.isTest ?? false,
      input.importBatchId ?? null,
    ],
  )
  if (!row) throw new Error('failed to create household')
  return row
}

export async function logAudit(
  action: string,
  opts: {
    actorType?: string
    actorId?: string | null
    householdId?: string | null
    metadata?: Record<string, unknown>
  } = {},
): Promise<void> {
  await query(
    `insert into audit_logs (actor_type, actor_id, action, household_id, metadata)
     values ($1, $2, $3, $4, $5)`,
    [
      opts.actorType ?? 'staff',
      opts.actorId ?? null,
      action,
      opts.householdId ?? null,
      JSON.stringify(opts.metadata ?? {}),
    ],
  )
}

export type RedeemResult = {
  success: boolean
  error?: string
  display_name?: string
  redemption_id?: string
  redeemed_now?: number
  requested?: number
  tickets_purchased?: number
  tickets_redeemed?: number
  tickets_remaining?: number
  payment_status?: string
}

/**
 * The only way tickets are ever consumed. One statement, atomic, authoritative.
 */
export async function redeemTickets(
  householdId: string,
  quantity: number,
  staffId: string | null,
  device: string | null,
): Promise<RedeemResult> {
  const row = await queryOne<{ result: RedeemResult }>(
    'select redeem_tickets($1::uuid, $2::int, $3::uuid, $4::text) as result',
    [householdId, quantity, staffId, device],
  )
  return row!.result
}

export async function reverseRedemption(
  redemptionId: string,
  quantity: number,
  reason: string,
  staffId: string | null,
): Promise<RedeemResult & { restored?: number; max_reversible?: number }> {
  const row = await queryOne<{ result: RedeemResult & { restored?: number } }>(
    'select reverse_redemption($1::uuid, $2::int, $3::text, $4::uuid) as result',
    [redemptionId, quantity, reason, staffId],
  )
  return row!.result
}

/**
 * Restore N admissions to a household without needing to know which scan they
 * came from. Used by the scanner when a family was over-counted earlier.
 */
export async function giveBackTickets(
  householdId: string,
  quantity: number,
  reason: string,
  staffId: string | null,
): Promise<RedeemResult & { restored?: number }> {
  const row = await queryOne<{ result: RedeemResult & { restored?: number } }>(
    'select give_back_tickets($1::uuid, $2::int, $3::text, $4::uuid) as result',
    [householdId, quantity, reason, staffId],
  )
  return row!.result
}

export async function adjustTicketCount(
  householdId: string,
  newTotal: number,
  reason: string,
  staffId: string | null,
): Promise<RedeemResult> {
  const row = await queryOne<{ result: RedeemResult }>(
    'select adjust_ticket_count($1::uuid, $2::int, $3::text, $4::uuid) as result',
    [householdId, newTotal, reason, staffId],
  )
  return row!.result
}

export function passUrl(token: string): string {
  const base = process.env.APP_BASE_URL?.replace(/\/$/, '') ?? 'http://localhost:3000'
  return `${base}/p/${token}`
}
