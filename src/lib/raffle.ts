import { query, queryOne } from './db'

/**
 * Raffle pool and draws.
 *
 * One ticket = one entry, under the name that bought it. Paid only — comped
 * passes get into the Sadhya but did not buy an entry — and never the seeded
 * demo households.
 *
 * raffle_excluded is the one way out of the pool that is not about money: a
 * household Square recorded with no announceable name (a card-present sale
 * carries no cardholder name, so the webhook could only store the order id).
 * They keep every ticket they paid for; they just cannot be read from a stage.
 * See db/migrations/0016_raffle_exclusion.sql.
 *
 * This filter is defined once and shared by every read here so the counter on
 * the stage, the names on the wheel, and the row the database actually picks
 * can never disagree about who is eligible. draw_raffle_winner() in
 * db/migrations/0016_raffle_exclusion.sql repeats it deliberately: the
 * invariant belongs in the database too, not only in the process that happens
 * to be calling.
 */
const ELIGIBLE = `
  not h.is_test
  and not h.raffle_excluded
  and h.payment_status = 'paid'
  and h.tickets_purchased > 0
  and not exists (select 1 from raffle_draws d
                   where d.household_id = h.id and d.voided_at is null)
`

export type RafflePoolEntry = {
  household_id: string
  display_name: string
  entries: number
}

export type RaffleDraw = {
  id: string
  household_id: string
  display_name: string
  prize: string
  entries_at_draw: number
  created_at: string
}

export type RaffleState = {
  /** Everyone still in the pool. The stage needs the names to build the wheel. */
  pool: RafflePoolEntry[]
  households: number
  entries: number
  /** Standing winners, newest first. */
  draws: RaffleDraw[]
}

export type DrawResult =
  | {
      success: true
      draw_id: string
      household_id: string
      display_name: string
      prize: string
      entries_at_draw: number
      pool_entries: number
      pool_households: number
    }
  | { success: false; error: 'POOL_EMPTY' | 'PRIZE_REQUIRED' }

export async function loadRaffleState(): Promise<RaffleState> {
  const [pool, draws] = await Promise.all([
    query<RafflePoolEntry>(
      `select h.id as household_id, h.display_name, h.tickets_purchased as entries
         from households h
        where ${ELIGIBLE}
        order by lower(h.display_name)`,
    ),
    query<RaffleDraw>(
      `select id, household_id, display_name, prize, entries_at_draw, created_at
         from raffle_draws
        where voided_at is null
        order by created_at desc`,
    ),
  ])

  return {
    pool,
    households: pool.length,
    entries: pool.reduce((n, p) => n + p.entries, 0),
    draws,
  }
}

/**
 * The database picks the winner and records it in one statement. The browser
 * is told who won and then animates towards that answer — it never decides.
 */
export async function drawWinner(prize: string, staffId: string | null): Promise<DrawResult> {
  const row = await queryOne<{ result: DrawResult }>(
    'select draw_raffle_winner($1::text, $2::uuid) as result',
    [prize, staffId],
  )
  return row!.result
}

/**
 * Undo one draw — a mis-typed prize, or a spin nobody was watching. The row
 * stays; only voided_at is set, so the history of what was announced survives.
 * Returns the household that went back into the pool, or null if that draw was
 * already voided or never existed.
 */
export async function voidDraw(
  drawId: string,
  staffId: string | null,
): Promise<{ display_name: string; household_id: string } | null> {
  const row = await queryOne<{ display_name: string; household_id: string; prize: string }>(
    `update raffle_draws
        set voided_at = now()
      where id = $1 and voided_at is null
      returning display_name, household_id, prize`,
    [drawId],
  )
  if (!row) return null

  await query(
    `insert into audit_logs (actor_type, actor_id, action, household_id, metadata)
     values ('staff', $1, 'raffle_draw_voided', $2, $3)`,
    [staffId, row.household_id, JSON.stringify({ draw_id: drawId, prize: row.prize })],
  )

  return { display_name: row.display_name, household_id: row.household_id }
}

/** Put everyone back in. Returns how many winners were released. */
export async function resetRaffle(staffId: string | null): Promise<number> {
  const rows = await query<{ id: string }>(
    `update raffle_draws set voided_at = now() where voided_at is null returning id`,
  )

  await query(
    `insert into audit_logs (actor_type, actor_id, action, metadata)
     values ('staff', $1, 'raffle_reset', $2)`,
    [staffId, JSON.stringify({ released: rows.length })],
  )

  return rows.length
}
