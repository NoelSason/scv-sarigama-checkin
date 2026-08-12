import type { PoolClient } from '@neondatabase/serverless'
import { afterAll, describe, expect, it } from 'vitest'
import { transaction } from '@/lib/db'
import { loadRaffleState } from '@/lib/raffle'
import { generatePassToken } from '@/lib/tokens'
import { makeHousehold, purgeTestData } from './helpers'

afterAll(async () => {
  await purgeTestData()
})

// ---------------------------------------------------------------------------
// Eligibility — read-only, so these run straight against the shared database.
// ---------------------------------------------------------------------------

describe('raffle pool eligibility', () => {
  it('admits paid, non-demo, ticket-holding households and nobody else', async () => {
    const paid = await makeHousehold({ purchased: 4, status: 'paid', isTest: false })
    const comped = await makeHousehold({ purchased: 4, status: 'comped', isTest: false })
    const unpaid = await makeHousehold({ purchased: 4, status: 'unpaid', isTest: false })
    const review = await makeHousehold({ purchased: 4, status: 'needs_review', isTest: false })
    const refunded = await makeHousehold({ purchased: 4, status: 'refunded', isTest: false })
    const demo = await makeHousehold({ purchased: 4, status: 'paid', isTest: true })
    const noTickets = await makeHousehold({ purchased: 0, status: 'paid', isTest: false })

    const { pool } = await loadRaffleState()
    const byId = new Map(pool.map((p) => [p.household_id, p]))

    expect(byId.get(paid.id)?.entries).toBe(4)

    for (const excluded of [comped, unpaid, review, refunded, demo, noTickets]) {
      expect(byId.has(excluded.id)).toBe(false)
    }
  })

  it('counts entries from tickets bought, not tickets left — attendance is irrelevant', async () => {
    const soldOut = await makeHousehold({
      purchased: 6,
      redeemed: 6,
      status: 'paid',
      isTest: false,
    })

    const { pool } = await loadRaffleState()
    expect(pool.find((p) => p.household_id === soldOut.id)?.entries).toBe(6)
  })

  it('reports totals that match the rows it returns', async () => {
    const state = await loadRaffleState()
    expect(state.households).toBe(state.pool.length)
    expect(state.entries).toBe(state.pool.reduce((n, p) => n + p.entries, 0))
  })
})

// ---------------------------------------------------------------------------
// Draws.
//
// draw_raffle_winner() picks from every eligible household in the database,
// which at this point includes ~86 real families. A test that called it
// directly would record real raffle wins and quietly remove those families
// from the draw the organizers are going to run for real.
//
// So each of these runs inside a transaction that is ALWAYS rolled back, and
// begins by parking every currently-eligible real household as already-drawn.
// Inside the transaction the pool contains only the rows the test creates;
// outside it, nothing happened at all.
// ---------------------------------------------------------------------------

const ROLLBACK = Symbol('rollback')

async function sandbox(fn: (c: PoolClient) => Promise<void>): Promise<void> {
  try {
    await transaction(async (c) => {
      await c.query(
        `insert into raffle_draws
           (household_id, display_name, prize, entries_at_draw, pool_entries, pool_households)
         select h.id, h.display_name, 'sandbox', h.tickets_purchased, 0, 0
           from households h
          where not h.is_test
            and h.payment_status = 'paid'
            and h.tickets_purchased > 0
            and not exists (select 1 from raffle_draws d
                             where d.household_id = h.id and d.voided_at is null)`,
      )
      await fn(c)
      throw ROLLBACK
    })
  } catch (err) {
    if (err !== ROLLBACK) throw err
  }
}

type Draw = {
  success: boolean
  error?: string
  draw_id?: string
  household_id?: string
  display_name?: string
  entries_at_draw?: number
  pool_entries?: number
  pool_households?: number
}

async function makeEntrant(c: PoolClient, name: string, tickets: number): Promise<string> {
  const res = await c.query(
    `insert into households
       (display_name, tickets_purchased, payment_status, pass_token, is_test, source)
     values ($1, $2, 'paid', $3, false, 'vitest') returning id`,
    [name, tickets, generatePassToken()],
  )
  return res.rows[0].id as string
}

async function draw(c: PoolClient, prize: string): Promise<Draw> {
  const res = await c.query('select draw_raffle_winner($1::text, null) as result', [prize])
  return res.rows[0].result as Draw
}

describe('draw_raffle_winner', () => {
  it('refuses a blank prize', async () => {
    await sandbox(async (c) => {
      await makeEntrant(c, 'TEST Blank Prize', 3)
      expect((await draw(c, '   ')).error).toBe('PRIZE_REQUIRED')
    })
  })

  it('never draws the same household twice, then reports POOL_EMPTY', async () => {
    await sandbox(async (c) => {
      const ids = new Set<string>()
      for (let i = 0; i < 5; i++) ids.add(await makeEntrant(c, `TEST Entrant ${i}`, 2))

      const winners = new Set<string>()
      for (let i = 0; i < 5; i++) {
        const result = await draw(c, `Prize ${i}`)
        expect(result.success).toBe(true)
        winners.add(result.household_id!)
      }

      expect(winners.size).toBe(5)
      expect([...winners].every((id) => ids.has(id))).toBe(true)
      expect((await draw(c, 'One too many')).error).toBe('POOL_EMPTY')
    })
  })

  it('records the pool size as it was at the moment of the draw', async () => {
    await sandbox(async (c) => {
      await makeEntrant(c, 'TEST Snapshot A', 3)
      await makeEntrant(c, 'TEST Snapshot B', 7)

      const first = await draw(c, 'Gift hamper')
      expect(first.pool_households).toBe(2)
      expect(first.pool_entries).toBe(10)

      const second = await draw(c, 'Gold coin')
      expect(second.pool_households).toBe(1)
      expect(second.pool_entries).toBe(10 - first.entries_at_draw!)
    })
  })

  it('weights the draw by tickets, not by name', async () => {
    await sandbox(async (c) => {
      const one = await makeEntrant(c, 'TEST One Ticket', 1)
      await makeEntrant(c, 'TEST Nine Tickets', 9)

      const ROUNDS = 240
      let heavyWins = 0

      for (let i = 0; i < ROUNDS; i++) {
        const result = await draw(c, 'Weighting')
        expect(result.success).toBe(true)
        if (result.household_id !== one) heavyWins++
        // Void immediately so the same two households are back for the next
        // round — this measures the pick, not the removal.
        await c.query('update raffle_draws set voided_at = now() where id = $1', [result.draw_id])
      }

      // Expectation is 90%. The band is ±5 standard deviations at n = 240, so
      // this fails on a broken weighting and not on an unlucky evening.
      const share = heavyWins / ROUNDS
      expect(share).toBeGreaterThan(0.8)
      expect(share).toBeLessThan(0.97)
    })
  })

  it('lets a voided winner win again, and keeps the voided row', async () => {
    await sandbox(async (c) => {
      const only = await makeEntrant(c, 'TEST Sole Entrant', 5)

      const first = await draw(c, 'Prize one')
      expect(first.household_id).toBe(only)
      expect((await draw(c, 'Prize two')).error).toBe('POOL_EMPTY')

      await c.query('update raffle_draws set voided_at = now() where id = $1', [first.draw_id])

      const second = await draw(c, 'Prize two')
      expect(second.household_id).toBe(only)

      const rows = await c.query('select id from raffle_draws where household_id = $1', [only])
      expect(rows.rows).toHaveLength(2)
    })
  })

  it('a reset puts everyone back without deleting the history', async () => {
    await sandbox(async (c) => {
      for (let i = 0; i < 4; i++) await makeEntrant(c, `TEST Reset ${i}`, 3)
      for (let i = 0; i < 4; i++) expect((await draw(c, `Prize ${i}`)).success).toBe(true)
      expect((await draw(c, 'Nobody left')).error).toBe('POOL_EMPTY')

      const released = await c.query(
        'update raffle_draws set voided_at = now() where voided_at is null returning id',
      )
      // The four test draws plus the parked real households.
      expect(released.rows.length).toBeGreaterThanOrEqual(4)

      const again = await draw(c, 'After reset')
      expect(again.success).toBe(true)
      expect(again.pool_households).toBeGreaterThanOrEqual(4)
    })
  })

  it('rejects a second standing win for the same household at the database level', async () => {
    await sandbox(async (c) => {
      const id = await makeEntrant(c, 'TEST Double Win', 2)
      const first = await draw(c, 'Prize')
      expect(first.household_id).toBe(id)

      // The guard behind the advisory lock: even a caller that skipped every
      // check in draw_raffle_winner cannot leave two standing wins on one name.
      await expect(
        c.query(
          `insert into raffle_draws
             (household_id, display_name, prize, entries_at_draw, pool_entries, pool_households)
           values ($1, 'TEST Double Win', 'Sneaky', 2, 2, 1)`,
          [id],
        ),
      ).rejects.toThrow()
    })
  })
})
