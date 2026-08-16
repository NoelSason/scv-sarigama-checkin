import { afterAll, describe, expect, it } from 'vitest'
import { findByToken, searchHouseholds } from '@/lib/households'
import { makeHousehold, purgeTestData, redeem, reverse } from './helpers'

afterAll(async () => {
  await purgeTestData()
})

/**
 * The scan history a volunteer reads at the door.
 *
 * What is being protected here is a judgement call, not a number: a pass used
 * ninety seconds ago at another station is a phone travelling back down the
 * queue, and the only thing that tells the volunteer so is the time. If these
 * come back empty, wrong-order, or including scans that were given back, the
 * door goes back to guessing.
 */
describe('recent_scans on a looked-up pass', () => {
  it('is empty for a pass nobody has used', async () => {
    const h = await makeHousehold({ purchased: 4 })
    const found = await findByToken(h.pass_token)
    expect(found?.recent_scans).toEqual([])
  })

  it('lists every scan newest first, with its count and station', async () => {
    const h = await makeHousehold({ purchased: 6 })
    await redeem(h.id, 2, 'Door 1')
    await redeem(h.id, 3, 'Door 2')

    const found = await findByToken(h.pass_token)
    const scans = found!.recent_scans!
    expect(scans).toHaveLength(2)
    expect(scans[0]).toMatchObject({ quantity: 3, device: 'Door 2' })
    expect(scans[1]).toMatchObject({ quantity: 2, device: 'Door 1' })

    // Parseable by both clients, and newest genuinely first.
    const times = scans.map((s) => new Date(s.at).getTime())
    expect(times.every((t) => Number.isFinite(t))).toBe(true)
    expect(times[0]).toBeGreaterThanOrEqual(times[1])
  })

  it('drops a scan that was fully given back, and keeps a partly reversed one', async () => {
    const h = await makeHousehold({ purchased: 8 })
    const undone = await redeem(h.id, 2)
    const trimmed = await redeem(h.id, 4)

    await reverse(undone.redemption_id as string, 2, 'counted a family twice')
    await reverse(trimmed.redemption_id as string, 1, 'one of them did not eat')

    const scans = (await findByToken(h.pass_token))!.recent_scans!
    // The reversed scan admitted nobody; challenging a family over it would be
    // challenging them over a meal they never ate.
    expect(scans).toHaveLength(1)
    // A partial reversal still admitted people, so it stays — at the count the
    // scan was made with, which is what the audit trail records.
    expect(scans[0]).toMatchObject({ quantity: 4 })
  })

  it('rides along on a name search, so the manual path sees it too', async () => {
    const name = `TEST Searchable ${Date.now()}`
    const h = await makeHousehold({ purchased: 3, name, isTest: false })
    await redeem(h.id, 1, 'Door 1')

    const results = await searchHouseholds(name)
    const row = results.find((r) => r.id === h.id)
    expect(row?.recent_scans?.[0]).toMatchObject({ quantity: 1, device: 'Door 1' })
  })
})
