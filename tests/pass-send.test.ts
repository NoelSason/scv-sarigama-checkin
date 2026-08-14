import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { query, queryOne } from '@/lib/db'
import { sendPassEmail } from '@/lib/email'
import type { EmailMessage, EmailProvider, EmailResult } from '@/lib/email/provider'
import type { Household } from '@/lib/households'
import { makeHousehold, purgeTestData } from './helpers'

/**
 * One automatic pass per guest, however many things ask for it at once.
 *
 * The incident these exist for: Square sent payment.created and payment.updated
 * for one order in the same second, they landed on two serverless instances,
 * both asked the database "has this guest been sent their pass?", both were told
 * no — because neither had written anything yet — and the guest received two
 * identical passes.
 *
 * The provider is stubbed, so nothing here can reach a real inbox. It counts
 * calls, which is the only thing worth asserting: a claim that stops a duplicate
 * row but still hands the message to Resend has fixed nothing.
 */

const globalForEmail = globalThis as unknown as { __onamEmailProvider?: EmailProvider }

let sends: EmailMessage[] = []
let nextResult: (message: EmailMessage) => EmailResult = (m) => ({
  ok: true,
  providerMessageId: `stub-${sends.length}`,
  deliveredTo: m.to,
})

const stub: EmailProvider = {
  name: 'stub',
  async send(message) {
    sends.push(message)
    // Long enough that two concurrent sends genuinely overlap rather than
    // happening to serialise on the network.
    await new Promise((r) => setTimeout(r, 150))
    return nextResult(message)
  },
}

beforeEach(() => {
  sends = []
  nextResult = (m) => ({ ok: true, providerMessageId: `stub-${sends.length}`, deliveredTo: m.to })
  globalForEmail.__onamEmailProvider = stub
})

afterEach(() => {
  delete globalForEmail.__onamEmailProvider
})

afterAll(async () => {
  await purgeTestData()
})

async function household(opts: { email: string; purchased?: number }): Promise<Household> {
  const created = await makeHousehold({ purchased: opts.purchased ?? 2, email: opts.email })
  return (await queryOne<Household>('select * from households where id = $1', [created.id]))!
}

async function deliveries(householdId: string) {
  return query<{ status: string; to_email: string; auto: boolean; tickets_at_send: number | null }>(
    `select status, to_email, auto, tickets_at_send
       from email_deliveries where household_id = $1 order by created_at`,
    [householdId],
  )
}

describe('automatic pass sends cannot double up', () => {
  it('TEST: two instances racing on the same payment send exactly one email', async () => {
    const h = await household({ email: 'race@example.test' })

    const [a, b] = await Promise.all([
      sendPassEmail(h, 'pass', { auto: true }),
      sendPassEmail(h, 'pass', { auto: true }),
    ])

    const winners = [a, b].filter((r) => r.ok)
    const losers = [a, b].filter((r) => !r.ok)

    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0].ok === false && losers[0].reason).toBe('ALREADY_CLAIMED')
    expect(sends).toHaveLength(1)
    expect(await deliveries(h.id)).toHaveLength(1)
  })

  it('TEST: a later automatic run does not send a second copy', async () => {
    const h = await household({ email: 'again@example.test' })

    await sendPassEmail(h, 'pass', { auto: true })
    const second = await sendPassEmail(h, 'pass', { auto: true })

    expect(second.ok).toBe(false)
    expect(second.ok === false && second.reason).toBe('ALREADY_CLAIMED')
    expect(sends).toHaveLength(1)
  })
})

describe('the sends that must still get through', () => {
  it('TEST: staff can resend by hand after the automatic one', async () => {
    const h = await household({ email: 'desk@example.test' })

    await sendPassEmail(h, 'pass', { auto: true })
    const manual = await sendPassEmail(h) // what the registration desk calls

    expect(manual.ok).toBe(true)
    expect(sends).toHaveLength(2)
  })

  it('TEST: buying again re-sends, because the old pass understates the total', async () => {
    const h = await household({ email: 'repeat@example.test', purchased: 2 })

    await sendPassEmail(h, 'pass', { auto: true })
    const after = await sendPassEmail({ ...h, tickets_purchased: 5 }, 'pass', { auto: true })

    expect(after.ok).toBe(true)
    expect(sends).toHaveLength(2)
    expect((await deliveries(h.id)).map((d) => d.tickets_at_send)).toEqual([2, 5])
  })

  it('TEST: a corrected address gets its own pass', async () => {
    const h = await household({ email: 'typo@example.test' })

    await sendPassEmail(h, 'pass', { auto: true })
    const corrected = await sendPassEmail({ ...h, email: 'fixed@example.test' }, 'pass', {
      auto: true,
    })

    expect(corrected.ok).toBe(true)
    expect(sends.map((s) => s.to)).toEqual(['typo@example.test', 'fixed@example.test'])
  })

  it('TEST: the reminder is a different mailing and still reaches everyone', async () => {
    const h = await household({ email: 'reminder@example.test' })

    await sendPassEmail(h, 'pass', { auto: true })
    const reminder = await sendPassEmail(h, 'reminder', { auto: true })

    expect(reminder.ok).toBe(true)
    expect(sends).toHaveLength(2)
  })

  it('TEST: a send that failed is retried rather than counted as delivered', async () => {
    const h = await household({ email: 'flaky@example.test' })

    nextResult = (m) => ({ ok: false, error: 'provider down', deliveredTo: m.to })
    const first = await sendPassEmail(h, 'pass', { auto: true })
    expect(first.ok === false && first.reason).toBe('SEND_FAILED')

    nextResult = (m) => ({ ok: true, providerMessageId: 'stub-retry', deliveredTo: m.to })
    const retry = await sendPassEmail(h, 'pass', { auto: true })

    expect(retry.ok).toBe(true)
    expect((await deliveries(h.id)).map((d) => d.status)).toEqual(['failed', 'sent'])
  })
})
