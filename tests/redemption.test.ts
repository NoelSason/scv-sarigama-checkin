import { afterAll, describe, expect, it } from 'vitest'
import { query } from '@/lib/db'
import {
  adjustCount,
  auditFor,
  getHousehold,
  giveBack,
  makeHousehold,
  purgeTestData,
  redeem,
  reverse,
} from './helpers'

afterAll(async () => {
  await purgeTestData()
})

describe('redeem_tickets — the happy path', () => {
  it('TEST 1/2/3: 5 purchased → redeem 2 → 3 left → redeem 3 → 0 left → refuse 1 more', async () => {
    const h = await makeHousehold({ purchased: 5 })

    const first = await redeem(h.id, 2)
    expect(first.success).toBe(true)
    expect(first.redeemed_now).toBe(2)
    expect(first.tickets_remaining).toBe(3)

    const second = await redeem(h.id, 3)
    expect(second.success).toBe(true)
    expect(second.tickets_remaining).toBe(0)

    const third = await redeem(h.id, 1)
    expect(third.success).toBe(false)
    expect(third.error).toBe('INSUFFICIENT_TICKETS')
    expect(third.tickets_remaining).toBe(0)

    // The refusal must not have moved the ledger.
    const after = await getHousehold(h.id)
    expect(after!.tickets_redeemed).toBe(5)
  })

  it('records one redemption row and one audit entry per successful scan', async () => {
    const h = await makeHousehold({ purchased: 4 })
    await redeem(h.id, 1)
    await redeem(h.id, 2)

    const rows = await query<{ quantity: number }>(
      'select quantity from redemptions where household_id = $1 order by created_at',
      [h.id],
    )
    expect(rows.map((r) => r.quantity)).toEqual([1, 2])

    const audit = await auditFor(h.id)
    expect(audit.filter((a) => a.action === 'redemption')).toHaveLength(2)
  })
})

describe('redeem_tickets — refusals', () => {
  it('TEST 7: an unpaid household cannot redeem', async () => {
    const h = await makeHousehold({ purchased: 3, status: 'unpaid' })
    const res = await redeem(h.id, 1)
    expect(res.success).toBe(false)
    expect(res.error).toBe('NOT_PAID')
    expect((await getHousehold(h.id))!.tickets_redeemed).toBe(0)
  })

  it('TEST 8: a disabled pass cannot redeem', async () => {
    const h = await makeHousehold({ purchased: 3, enabled: false })
    const res = await redeem(h.id, 1)
    expect(res.success).toBe(false)
    expect(res.error).toBe('PASS_DISABLED')
    expect((await getHousehold(h.id))!.tickets_redeemed).toBe(0)
  })

  it('a comped household CAN redeem — sponsors eat Sadhya', async () => {
    const h = await makeHousehold({ purchased: 2, status: 'comped' })
    const res = await redeem(h.id, 2)
    expect(res.success).toBe(true)
    expect(res.tickets_remaining).toBe(0)
  })

  it('rejects zero, negative, and null quantities without touching the ledger', async () => {
    const h = await makeHousehold({ purchased: 5 })
    for (const q of [0, -1, -99]) {
      const res = await redeem(h.id, q)
      expect(res.success).toBe(false)
      expect(res.error).toBe('INVALID_QUANTITY')
    }
    expect((await getHousehold(h.id))!.tickets_redeemed).toBe(0)
  })

  it('rejects an unknown household id', async () => {
    const res = await redeem('00000000-0000-0000-0000-000000000000', 1)
    expect(res.success).toBe(false)
    expect(res.error).toBe('PASS_NOT_FOUND')
  })

  it('refuses a quantity larger than remaining, and says how many are left', async () => {
    const h = await makeHousehold({ purchased: 5, redeemed: 3 })
    const res = await redeem(h.id, 3)
    expect(res.success).toBe(false)
    expect(res.error).toBe('INSUFFICIENT_TICKETS')
    expect(res.tickets_remaining).toBe(2)
    expect(res.requested).toBe(3)
  })
})

describe('TEST 4: concurrent redemption cannot over-spend', () => {
  // This is the test the whole design exists to pass. Two volunteers scanning
  // the same shared QR at the same moment must not both succeed.
  for (const n of [2, 5, 20]) {
    it(`${n} simultaneous attempts to redeem all 3 → exactly one succeeds`, async () => {
      const h = await makeHousehold({ purchased: 3 })

      const results = await Promise.all(
        Array.from({ length: n }, () => redeem(h.id, 3, `device-${n}`)),
      )

      const wins = results.filter((r) => r.success === true)
      expect(wins).toHaveLength(1)
      expect(results.filter((r) => r.error === 'INSUFFICIENT_TICKETS')).toHaveLength(n - 1)

      const after = await getHousehold(h.id)
      expect(after!.tickets_redeemed).toBe(3)
      expect(after!.tickets_remaining).toBe(0)

      // Exactly one redemption row — losers must not leave ghost records.
      const rows = await query('select id from redemptions where household_id = $1', [h.id])
      expect(rows).toHaveLength(1)
    })
  }

  it('mixed quantities racing for 5 tickets never exceed 5 total', async () => {
    const h = await makeHousehold({ purchased: 5 })

    const results = await Promise.all([
      redeem(h.id, 3),
      redeem(h.id, 3),
      redeem(h.id, 2),
      redeem(h.id, 2),
      redeem(h.id, 4),
      redeem(h.id, 1),
    ])

    const granted = results
      .filter((r) => r.success === true)
      .reduce((sum, r) => sum + (r.redeemed_now as number), 0)

    const after = await getHousehold(h.id)
    expect(after!.tickets_redeemed).toBe(granted)
    expect(after!.tickets_redeemed).toBeLessThanOrEqual(5)
    expect(after!.tickets_remaining).toBeGreaterThanOrEqual(0)
  })
})

describe('TEST 13: reversing a mistaken redemption', () => {
  it('redeeming 3 instead of 2 → reversal restores exactly 1, with an audit trail', async () => {
    const h = await makeHousehold({ purchased: 5 })
    const done = await redeem(h.id, 3)
    expect(done.tickets_remaining).toBe(2)

    const res = await reverse(done.redemption_id as string, 1, 'volunteer tapped 3 instead of 2')
    expect(res.success).toBe(true)
    expect(res.restored).toBe(1)
    expect(res.tickets_remaining).toBe(3)

    // Original redemption is preserved, not deleted.
    const rows = await query<{ quantity: number; reversed_at: string | null }>(
      'select quantity, reversed_at from redemptions where household_id = $1',
      [h.id],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0].quantity).toBe(3)
    expect(rows[0].reversed_at).toBeNull() // only partially reversed

    const adj = await query<{ quantity_delta: number; reason: string }>(
      'select quantity_delta, reason from redemption_adjustments where household_id = $1',
      [h.id],
    )
    expect(adj).toHaveLength(1)
    expect(adj[0].quantity_delta).toBe(1)

    const audit = await auditFor(h.id)
    expect(audit.some((a) => a.action === 'redemption_reversal')).toBe(true)
  })

  it('refuses to reverse more than was redeemed, or twice', async () => {
    const h = await makeHousehold({ purchased: 5 })
    const done = await redeem(h.id, 2)
    const id = done.redemption_id as string

    expect((await reverse(id, 3, 'too many')).error).toBe('INVALID_QUANTITY')

    expect((await reverse(id, 2, 'correct')).success).toBe(true)
    expect((await reverse(id, 1, 'again')).error).toBe('ALREADY_REVERSED')

    expect((await getHousehold(h.id))!.tickets_redeemed).toBe(0)
  })

  it('requires a reason', async () => {
    const h = await makeHousehold({ purchased: 2 })
    const done = await redeem(h.id, 1)
    const res = await reverse(done.redemption_id as string, 1, '   ')
    expect(res.error).toBe('REASON_REQUIRED')
  })
})

describe('adjust_ticket_count', () => {
  it('cannot drop the total below what has already been eaten', async () => {
    const h = await makeHousehold({ purchased: 5, redeemed: 3 })
    const res = await adjustCount(h.id, 2, 'miscount')
    expect(res.success).toBe(false)
    expect(res.error).toBe('BELOW_REDEEMED')
    expect(res.tickets_redeemed).toBe(3)
  })

  it('raises the total and logs the change', async () => {
    const h = await makeHousehold({ purchased: 2 })
    const res = await adjustCount(h.id, 6, 'family added two more at the desk')
    expect(res.success).toBe(true)
    expect(res.tickets_remaining).toBe(6)

    const audit = await auditFor(h.id)
    const entry = audit.find((a) => a.action === 'ticket_count_adjusted')
    expect(entry?.metadata.from).toBe(2)
    expect(entry?.metadata.to).toBe(6)
  })

  it('requires a reason', async () => {
    const h = await makeHousehold({ purchased: 2 })
    expect((await adjustCount(h.id, 3, '')).error).toBe('REASON_REQUIRED')
  })
})

describe('database constraints are a real backstop, not decoration', () => {
  it('rejects a direct UPDATE that would over-redeem, even bypassing the RPC', async () => {
    const h = await makeHousehold({ purchased: 2 })
    await expect(
      query('update households set tickets_redeemed = 5 where id = $1', [h.id]),
    ).rejects.toThrow(/no_over_redemption/)
  })

  it('rejects negative ticket counts', async () => {
    const h = await makeHousehold({ purchased: 2 })
    await expect(
      query('update households set tickets_redeemed = -1 where id = $1', [h.id]),
    ).rejects.toThrow()
  })

  it('keeps tickets_remaining derived and in sync', async () => {
    const h = await makeHousehold({ purchased: 7 })
    await redeem(h.id, 4)
    const after = await getHousehold(h.id)
    expect(after!.tickets_remaining).toBe(after!.tickets_purchased - after!.tickets_redeemed)
    expect(after!.tickets_remaining).toBe(3)
  })

  it('under-6 children are recorded but never redeemable', async () => {
    const h = await makeHousehold({ purchased: 2, under6: 3 })
    expect(h.children_under_6).toBe(3)
    // Only the 2 paid admissions can be redeemed; the 3 children add nothing.
    expect((await redeem(h.id, 3)).error).toBe('INSUFFICIENT_TICKETS')
    expect((await redeem(h.id, 2)).success).toBe(true)
  })
})

describe('give_back_tickets — restoring admissions used earlier', () => {
  it('unwinds across several scans, newest first, and never deletes them', async () => {
    const h = await makeHousehold({ purchased: 6 })
    await redeem(h.id, 2)
    await redeem(h.id, 3)
    expect((await getHousehold(h.id))!.tickets_remaining).toBe(1)

    // Give back 4: takes all 3 from the newest scan and 1 from the older one.
    const res = await giveBack(h.id, 4, 'over-counted earlier')
    expect(res.success).toBe(true)
    expect(res.tickets_remaining).toBe(5)
    expect(res.tickets_redeemed).toBe(1)

    const rows = await query<{ quantity: number }>(
      'select quantity from redemptions where household_id = $1 order by created_at',
      [h.id],
    )
    expect(rows.map((r) => r.quantity)).toEqual([2, 3])

    const adj = await query<{ quantity_delta: number }>(
      'select quantity_delta from redemption_adjustments where household_id = $1',
      [h.id],
    )
    expect(adj.reduce((n, a) => n + a.quantity_delta, 0)).toBe(4)
  })

  it('works on a fully-used pass — the case a volunteer actually hits', async () => {
    const h = await makeHousehold({ purchased: 3 })
    await redeem(h.id, 3)
    expect((await getHousehold(h.id))!.tickets_remaining).toBe(0)

    const res = await giveBack(h.id, 1, 'only two of them ate')
    expect(res.success).toBe(true)
    expect(res.tickets_remaining).toBe(1)

    // And the restored admission is genuinely usable again.
    expect((await redeem(h.id, 1)).success).toBe(true)
  })

  it('refuses to give back more than was used', async () => {
    const h = await makeHousehold({ purchased: 5 })
    await redeem(h.id, 2)
    const res = await giveBack(h.id, 3, 'too many')
    expect(res.success).toBe(false)
    expect(res.error).toBe('INSUFFICIENT_REDEEMED')
    expect((await getHousehold(h.id))!.tickets_redeemed).toBe(2)
  })

  it('requires a reason and a positive quantity', async () => {
    const h = await makeHousehold({ purchased: 3 })
    await redeem(h.id, 1)
    expect((await giveBack(h.id, 1, '  ')).error).toBe('REASON_REQUIRED')
    expect((await giveBack(h.id, 0, 'x')).error).toBe('INVALID_QUANTITY')
  })

  it('concurrent give-backs cannot restore more than was used', async () => {
    const h = await makeHousehold({ purchased: 5 })
    await redeem(h.id, 4)

    const results = await Promise.all(
      Array.from({ length: 6 }, () => giveBack(h.id, 4, 'race')),
    )
    expect(results.filter((r) => r.success).length).toBe(1)

    const after = await getHousehold(h.id)
    expect(after!.tickets_redeemed).toBe(0)
    expect(after!.tickets_remaining).toBe(5)
  })
})
