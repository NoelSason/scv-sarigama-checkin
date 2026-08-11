import { describe, expect, it } from 'vitest'
import type { Square } from 'square'
import {
  contactFromOrder,
  mapOrderToEntitlement,
  paymentStatusFor,
  variationMapFromEnv,
  type VariationMap,
} from '@/lib/square'

/**
 * Pure mapping tests. No network, no database, no env.
 *
 * The scenario these exist for: variation display names embed a price that is
 * no longer charged. A real Aug 9 order reads "(Ages 6+ [$25.00]) × 2 … $60.00"
 * — $30 each, labelled $25. Deriving quantity from either the name or the
 * amount gives the wrong number of meals.
 */

const ADULT = 'VAR_ADULT_AGES6PLUS'
const UNDER6 = 'VAR_UNDER_6'
const SPONSOR = 'VAR_SPONSOR'

const MAP: VariationMap = { [ADULT]: 'adult', [UNDER6]: 'under6', [SPONSOR]: 'sponsor' }

function line(
  catalogObjectId: string | null,
  quantity: string,
  variationName: string,
  totalCents?: number,
): Square.OrderLineItem {
  return {
    uid: `uid-${variationName}-${quantity}`,
    name: 'SCV SaRiGaMa Onam Experience',
    variationName,
    quantity,
    ...(catalogObjectId ? { catalogObjectId } : {}),
    ...(totalCents == null
      ? {}
      : { totalMoney: { amount: BigInt(totalCents), currency: 'USD' as const } }),
  }
}

function order(lineItems: Square.OrderLineItem[], totalCents?: number): Square.Order {
  return {
    id: 'ORDER_TEST_1',
    locationId: 'LOC_TEST',
    state: 'COMPLETED',
    lineItems,
    ...(totalCents == null
      ? {}
      : { totalMoney: { amount: BigInt(totalCents), currency: 'USD' as const } }),
  }
}

describe('the stale-price trap', () => {
  it('takes quantity from line_item.quantity, not from the price in the display name', () => {
    // Exactly the shape of the real Aug 9 order: labelled $25, charged $30.
    const e = mapOrderToEntitlement(
      order([line(ADULT, '2', 'Ages 6+ [$25.00]', 6000)], 6000),
      MAP,
    )
    expect(e.adultQty).toBe(2)
    expect(e.ticketsPurchased).toBe(2)
    // amount ÷ labelled price = 2.4, amount ÷ real price = 2. Neither is consulted.
    expect(e.amountCents).toBe(6000)
  })

  it('is unaffected by the amount charged', () => {
    const labelled = mapOrderToEntitlement(order([line(ADULT, '3', 'Ages 6+ [$25.00]')], 7500), MAP)
    const raised = mapOrderToEntitlement(order([line(ADULT, '3', 'Ages 6+ [$25.00]')], 9000), MAP)
    expect(labelled.ticketsPurchased).toBe(3)
    expect(raised.ticketsPurchased).toBe(3)
  })

  it('matches on variation id, so a renamed variation still maps', () => {
    const e = mapOrderToEntitlement(
      order([line(ADULT, '1', 'Adults & Teens — 2027 pricing TBD')]),
      MAP,
    )
    expect(e.adultQty).toBe(1)
    expect(e.needsReview).toBe(false)
  })
})

describe('ticket mapping rules', () => {
  it('counts Ages 6+ as admissions', () => {
    const e = mapOrderToEntitlement(order([line(ADULT, '4', 'Ages 6+ [$25.00]')]), MAP)
    expect(e.ticketsPurchased).toBe(4)
    expect(e.childrenUnder6).toBe(0)
    expect(paymentStatusFor(e)).toBe('paid')
  })

  it('counts Sponsors as admissions and comps the household', () => {
    const e = mapOrderToEntitlement(order([line(SPONSOR, '2', 'Sponsors')]), MAP)
    expect(e.ticketsPurchased).toBe(2)
    expect(e.comped).toBe(true)
    expect(paymentStatusFor(e)).toBe('comped')
  })

  it('records Under 6 children but grants them no admission', () => {
    const e = mapOrderToEntitlement(order([line(UNDER6, '3', 'Under 6 years old')]), MAP)
    expect(e.under6Qty).toBe(3)
    expect(e.childrenUnder6).toBe(3)
    expect(e.ticketsPurchased).toBe(0)
  })

  it('sums repeated line items of the same variation', () => {
    const e = mapOrderToEntitlement(
      order([line(ADULT, '2', 'Ages 6+ [$25.00]'), line(ADULT, '3', 'Ages 6+ [$25.00]')]),
      MAP,
    )
    expect(e.adultQty).toBe(5)
    expect(e.ticketsPurchased).toBe(5)
  })

  it('produces the auditable rule string for a mixed order', () => {
    const e = mapOrderToEntitlement(
      order([
        line(ADULT, '4', 'Ages 6+ [$25.00]'),
        line(SPONSOR, '1', 'Sponsors'),
        line(UNDER6, '2', 'Under 6 years old'),
      ]),
      MAP,
    )
    expect(e.ticketsPurchased).toBe(5)
    expect(e.childrenUnder6).toBe(2)
    expect(e.rule).toBe('4 × Ages 6+ + 1 × Sponsors = 5; 2 × Under 6 excluded')
  })

  it('describes an under-6-only order without claiming admissions', () => {
    const e = mapOrderToEntitlement(order([line(UNDER6, '2', 'Under 6 years old')]), MAP)
    expect(e.rule).toBe('0 admissions; 2 × Under 6 excluded')
  })
})

describe('anything unexpected is reviewed, never guessed', () => {
  it('flags an unknown variation and withholds all admissions on that order', () => {
    const e = mapOrderToEntitlement(
      order([line(ADULT, '2', 'Ages 6+ [$25.00]'), line('VAR_MYSTERY', '1', 'Onam T-Shirt')]),
      MAP,
    )
    expect(e.needsReview).toBe(true)
    expect(e.adultQty).toBe(2) // the arithmetic is still reported …
    expect(e.ticketsPurchased).toBe(0) // … but nothing is granted
    expect(e.unmappedLines).toHaveLength(1)
    expect(e.unmappedLines[0].catalogObjectId).toBe('VAR_MYSTERY')
    expect(paymentStatusFor(e)).toBe('needs_review')
    expect(e.rule).toContain('NEEDS REVIEW')
  })

  it('flags a line item with no catalog variation id', () => {
    const e = mapOrderToEntitlement(
      order([line(ADULT, '1', 'Ages 6+ [$25.00]'), line(null, '1', 'Custom Amount')]),
      MAP,
    )
    expect(e.needsReview).toBe(true)
    expect(e.ticketsPurchased).toBe(0)
    expect(e.reviewReasons.join(' ')).toContain('no catalog variation id')
  })

  it('refuses a non-integer quantity rather than rounding it', () => {
    const e = mapOrderToEntitlement(order([line(ADULT, '1.5', 'Ages 6+ [$25.00]')]), MAP)
    expect(e.needsReview).toBe(true)
    expect(e.adultQty).toBe(0)
    expect(e.ticketsPurchased).toBe(0)
  })

  it('accepts a whole number written with decimals', () => {
    const e = mapOrderToEntitlement(order([line(ADULT, '2.00000000', 'Ages 6+ [$25.00]')]), MAP)
    expect(e.needsReview).toBe(false)
    expect(e.ticketsPurchased).toBe(2)
  })

  it('a sponsor line does not comp an order that needs review', () => {
    const e = mapOrderToEntitlement(
      order([line(SPONSOR, '1', 'Sponsors'), line('VAR_MYSTERY', '1', 'Something else')]),
      MAP,
    )
    expect(e.comped).toBe(false)
    expect(paymentStatusFor(e)).toBe('needs_review')
  })
})

describe('orders that are not ours', () => {
  it('does not match an order with no Onam variation, and does not flag it', () => {
    const e = mapOrderToEntitlement(order([line('VAR_OTHER_PRODUCT', '1', 'Coffee Mug')]), MAP)
    expect(e.matched).toBe(false)
    expect(e.needsReview).toBe(false)
    expect(e.ticketsPurchased).toBe(0)
  })

  it('handles an order with no line items', () => {
    const e = mapOrderToEntitlement(order([]), MAP)
    expect(e.matched).toBe(false)
    expect(e.rule).toBe('order has no line items')
  })
})

describe('contact extraction', () => {
  it('reads the pickup recipient', () => {
    const o: Square.Order = {
      ...order([line(ADULT, '1', 'Ages 6+ [$25.00]')]),
      fulfillments: [
        {
          type: 'PICKUP',
          pickupDetails: {
            recipient: {
              displayName: 'Kavitha Raveendra Raja',
              emailAddress: 'Kavitha@Example.COM',
              phoneNumber: '(661) 555-0134',
            },
          },
        },
      ],
    }
    expect(contactFromOrder(o)).toEqual({
      name: 'Kavitha Raveendra Raja',
      email: 'Kavitha@Example.COM',
      phone: '(661) 555-0134',
    })
  })

  it('skips fulfillments with no recipient', () => {
    const o: Square.Order = {
      ...order([line(ADULT, '1', 'Ages 6+ [$25.00]')]),
      fulfillments: [
        { type: 'PICKUP' },
        { type: 'PICKUP', pickupDetails: { recipient: { emailAddress: 'x@example.com' } } },
      ],
    }
    expect(contactFromOrder(o).email).toBe('x@example.com')
  })

  it('returns nulls when the order carries no contact', () => {
    expect(contactFromOrder(order([]))).toEqual({ name: null, email: null, phone: null })
  })
})

describe('variationMapFromEnv', () => {
  it('builds an id → role map', () => {
    expect(
      variationMapFromEnv({
        SQUARE_VARIATION_ADULT: ADULT,
        SQUARE_VARIATION_UNDER6: UNDER6,
        SQUARE_VARIATION_SPONSOR: SPONSOR,
      }),
    ).toEqual(MAP)
  })

  it('refuses to run half-configured — a missing id would silently unmap a variation', () => {
    expect(() =>
      variationMapFromEnv({
        SQUARE_VARIATION_ADULT: ADULT,
        SQUARE_VARIATION_UNDER6: UNDER6,
      }),
    ).toThrow(/SQUARE_VARIATION/)
  })
})
