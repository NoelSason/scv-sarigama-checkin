import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest'
import { query, queryOne } from '@/lib/db'
import { sendThankYouEmail } from '@/lib/email'
import { AWAITING_THANKYOU } from '@/lib/email/dispatch'
import type { EmailMessage, EmailProvider, EmailResult } from '@/lib/email/provider'
import { renderThankYouEmail } from '@/lib/email/templates'
import { trackedLinkUrl, type Household } from '@/lib/households'
import { makeHousehold, purgeTestData } from './helpers'

/**
 * The after-the-event mailing.
 *
 * Two things are worth holding down. First, who it goes to: everyone who
 * actually came, and nobody who only paid — the audience question is the whole
 * difference between a note and a mailing list. Second, that it goes once, via
 * the same claim-by-insert the pass send uses.
 *
 * The provider is stubbed, so nothing here can reach a real inbox.
 */

const globalForEmail = globalThis as unknown as { __onamEmailProvider?: EmailProvider }

let sends: EmailMessage[] = []

const stub: EmailProvider = {
  name: 'stub',
  async send(message): Promise<EmailResult> {
    sends.push(message)
    await new Promise((r) => setTimeout(r, 150))
    return { ok: true, providerMessageId: `stub-${sends.length}`, deliveredTo: message.to }
  },
}

beforeEach(() => {
  sends = []
  globalForEmail.__onamEmailProvider = stub
})

afterEach(() => {
  delete globalForEmail.__onamEmailProvider
})

afterAll(async () => {
  await purgeTestData()
})

async function household(opts: {
  email?: string
  purchased?: number
  redeemed?: number
  enabled?: boolean
  status?: string
}): Promise<Household> {
  const created = await makeHousehold({ purchased: opts.purchased ?? 2, ...opts })
  return (await queryOne<Household>('select * from households where id = $1', [created.id]))!
}

/**
 * "Is this household owed a thank-you?" — asked with the dispatcher's own SQL,
 * so the answer here cannot drift from what would actually be mailed.
 *
 * `not h.is_test` is neutralised for the same reason it is in the pass tests:
 * the fixture must stay flagged, or the live dispatcher would mail it.
 */
async function awaiting(householdId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    `select h.id ${AWAITING_THANKYOU.replace('not h.is_test', 'true')} and h.id = $1`,
    [householdId],
  )
  return rows.length > 0
}

describe('who the thank-you is for', () => {
  it('TEST: a family that came is owed one', async () => {
    const h = await household({ email: 'came@example.test', purchased: 4, redeemed: 4 })
    expect(await awaiting(h.id)).toBe(true)
  })

  it('TEST: a family that paid but never arrived is not', async () => {
    const h = await household({ email: 'noshow@example.test', purchased: 4, redeemed: 0 })
    expect(await awaiting(h.id)).toBe(false)
  })

  it('TEST: somebody marked present by hand is owed one, though they never scanned', async () => {
    const h = await household({ email: 'marked@example.test', purchased: 2, redeemed: 0 })
    expect(await awaiting(h.id)).toBe(false)

    await query(`insert into attendance_marks (household_id, quantity) values ($1, 2)`, [h.id])
    expect(await awaiting(h.id)).toBe(true)
  })

  it('TEST: a disabled pass does not exclude somebody who was there', async () => {
    // The pass gate asks whether a ticket still works. After the event that is
    // not the question, and using it here would silently drop attendees.
    const h = await household({
      email: 'disabled@example.test',
      purchased: 2,
      redeemed: 2,
      enabled: false,
    })
    expect(await awaiting(h.id)).toBe(true)
  })

  it('TEST: no email address means no mailing, however much they attended', async () => {
    const h = await household({ purchased: 2, redeemed: 2 })
    expect(await awaiting(h.id)).toBe(false)
  })
})

describe('the thank-you sends exactly once', () => {
  it('TEST: two runs racing send one email and leave one delivery row', async () => {
    const h = await household({ email: 'race-ty@example.test', purchased: 2, redeemed: 2 })

    const [a, b] = await Promise.all([
      sendThankYouEmail(h, { auto: true }),
      sendThankYouEmail(h, { auto: true }),
    ])

    expect([a, b].filter((r) => r.ok)).toHaveLength(1)
    const loser = [a, b].find((r) => !r.ok)!
    expect(loser.ok === false && loser.reason).toBe('ALREADY_CLAIMED')
    expect(sends).toHaveLength(1)

    const rows = await query(`select id from email_deliveries where household_id = $1`, [h.id])
    expect(rows).toHaveLength(1)
  })

  it('TEST: once sent, the household drops out of the queue', async () => {
    const h = await household({ email: 'once@example.test', purchased: 2, redeemed: 2 })

    expect(await awaiting(h.id)).toBe(true)
    await sendThankYouEmail(h, { auto: true })
    expect(await awaiting(h.id)).toBe(false)
  })

  it('TEST: a household with no email is refused rather than recorded', async () => {
    const h = await household({ purchased: 2, redeemed: 2 })

    const result = await sendThankYouEmail(h, { auto: true })

    expect(result.ok).toBe(false)
    expect(result.ok === false && result.reason).toBe('NO_EMAIL')
    expect(sends).toHaveLength(0)
    const rows = await query(`select id from email_deliveries where household_id = $1`, [h.id])
    expect(rows).toHaveLength(0)
  })
})

describe('what the mailing contains', () => {
  it('TEST: the video link is the household-specific tracked one, not the raw URL', async () => {
    const h = await household({ email: 'link@example.test', purchased: 2, redeemed: 2 })

    await sendThankYouEmail(h, { auto: true })

    const tracked = trackedLinkUrl(h.pass_token, 'video')
    expect(sends[0].html).toContain(tracked)
    expect(sends[0].text).toContain(tracked)
    // Two families must never share a link, or a click cannot be attributed.
    expect(tracked).toContain(h.pass_token)
  })

  it('TEST: the feedback form is tracked separately, so the two clicks can be told apart', async () => {
    const previous = process.env.FEEDBACK_FORM_URL
    process.env.FEEDBACK_FORM_URL = 'https://forms.example.test/abc'
    try {
      const h = await household({ email: 'feedback@example.test', purchased: 2, redeemed: 2 })

      await sendThankYouEmail(h, { auto: true })

      const video = trackedLinkUrl(h.pass_token, 'video')
      const feedback = trackedLinkUrl(h.pass_token, 'feedback')
      expect(sends[0].html).toContain(feedback)
      expect(sends[0].text).toContain(feedback)
      expect(feedback).not.toBe(video)
      // The form's own address never reaches the guest: they go through us, or
      // the click is invisible.
      expect(sends[0].html).not.toContain('forms.example.test')
    } finally {
      if (previous === undefined) delete process.env.FEEDBACK_FORM_URL
      else process.env.FEEDBACK_FORM_URL = previous
    }
  })

  it('TEST: with no form configured the block drops out rather than shipping a dead button', () => {
    const rendered = renderThankYouEmail(
      { display_name: 'Test Family', tickets_purchased: 2 },
      { video: 'https://example.test/r/tok/video' },
    )

    expect(rendered.html).not.toMatch(/feedback/i)
    expect(rendered.text).not.toMatch(/feedback/i)
  })

  it('TEST: it carries no QR and no admission count — the event is over', () => {
    const rendered = renderThankYouEmail(
      { display_name: 'Test Family', tickets_purchased: 4 },
      { video: 'https://example.test/r/tok/video' },
    )

    expect(rendered.html).not.toContain('cid:')
    expect(rendered.html).not.toMatch(/admit/i)
    expect(rendered.text).not.toMatch(/admission/i)
  })

  it('TEST: the greeting uses the first name only', () => {
    const rendered = renderThankYouEmail(
      { display_name: 'Kavitha Raveendra Raja', tickets_purchased: 2 },
      { video: 'https://example.test/r/tok/video' },
    )

    expect(rendered.text).toContain('Hi Kavitha,')
    expect(rendered.html).toContain('Hi Kavitha,')
  })
})
