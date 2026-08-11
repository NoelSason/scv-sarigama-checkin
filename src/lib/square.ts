import { SquareClient, SquareEnvironment, type Square } from 'square'

/**
 * Square integration primitives.
 *
 * This module holds no database access on purpose: mapOrderToEntitlement() is
 * the single place that decides how many people an order admits, and it must be
 * testable without a network or a database.
 *
 * The one rule everything here exists to enforce:
 *
 *   ADMISSIONS COME FROM line_item.quantity, MATCHED BY CATALOG VARIATION ID.
 *
 * Never from an amount, never from a display name. A real Aug 9 order reads
 * "(Ages 6+ [$25.00]) × 2 … $60.00" — the price was raised to $30 but the
 * variation's *name* still carries the old $25, so both the name string and
 * amount ÷ price arithmetic produce wrong answers. Only the quantity and the
 * variation id are trustworthy.
 */

export type VariationRole = 'adult' | 'under6' | 'sponsor'

/**
 * Canonical labels. Deliberately OUR strings, not Square's display names —
 * Square's names embed a stale price and would leak it into the preview CSV.
 */
export const ROLE_LABEL: Record<VariationRole, string> = {
  adult: 'Ages 6+',
  sponsor: 'Sponsors',
  under6: 'Under 6',
}

/** Catalog variation id → role. Built from env, never from names. */
export type VariationMap = Record<string, VariationRole>

export function variationMapFromEnv(env: Record<string, string | undefined> = process.env): VariationMap {
  const entries: Array<[string, VariationRole]> = [
    [env.SQUARE_VARIATION_ADULT ?? '', 'adult'],
    [env.SQUARE_VARIATION_UNDER6 ?? '', 'under6'],
    [env.SQUARE_VARIATION_SPONSOR ?? '', 'sponsor'],
  ]
  const missing = entries.filter(([id]) => id.trim().length === 0)
  if (missing.length > 0) {
    throw new Error(
      'SQUARE_VARIATION_ADULT, SQUARE_VARIATION_UNDER6 and SQUARE_VARIATION_SPONSOR must all be set. ' +
        'Run `npx tsx scripts/square-catalog.ts` to list the variation ids.',
    )
  }
  const map: VariationMap = {}
  for (const [id, role] of entries) map[id.trim()] = role
  return map
}

export function squareClient(env: Record<string, string | undefined> = process.env): SquareClient {
  const token = env.SQUARE_ACCESS_TOKEN
  if (!token) throw new Error('SQUARE_ACCESS_TOKEN is not set')
  return new SquareClient({
    token,
    environment:
      env.SQUARE_ENVIRONMENT === 'production'
        ? SquareEnvironment.Production
        : SquareEnvironment.Sandbox,
  })
}

export function squareLocationId(env: Record<string, string | undefined> = process.env): string {
  const id = env.SQUARE_LOCATION_ID
  if (!id) throw new Error('SQUARE_LOCATION_ID is not set')
  return id
}

/**
 * The URL Square signs against. Must byte-match the notification URL registered
 * on the webhook subscription, including scheme and any trailing path.
 */
export function webhookNotificationUrl(env: Record<string, string | undefined> = process.env): string {
  const explicit = env.SQUARE_WEBHOOK_NOTIFICATION_URL
  if (explicit) return explicit
  const base = (env.APP_BASE_URL ?? '').replace(/\/$/, '')
  if (!base) throw new Error('APP_BASE_URL (or SQUARE_WEBHOOK_NOTIFICATION_URL) is not set')
  return `${base}/api/webhooks/square`
}

// ---------------------------------------------------------------------------
// Mapping — pure
// ---------------------------------------------------------------------------

export type MappedLine = {
  uid: string | null
  catalogObjectId: string | null
  /** Square's own label, kept only for the audit trail. May embed a stale price. */
  label: string
  /** Parsed from line_item.quantity. null when it is not a whole number. */
  quantity: number | null
  role: VariationRole | null
  problem: string | null
}

export type Entitlement = {
  orderId: string | null
  /** True when at least one line item matched a known Onam variation id. */
  matched: boolean
  adultQty: number
  sponsorQty: number
  under6Qty: number
  /** Admissions to grant. Forced to 0 whenever needsReview is set. */
  ticketsPurchased: number
  childrenUnder6: number
  comped: boolean
  needsReview: boolean
  reviewReasons: string[]
  lines: MappedLine[]
  unmappedLines: MappedLine[]
  amountCents: number | null
  currency: string | null
  /** Human-auditable derivation, e.g. "4 × Ages 6+ + 1 × Sponsors = 5; 2 × Under 6 excluded". */
  rule: string
}

/**
 * Square sends quantity as a string. Anything that is not a whole number
 * (a measurement-unit quantity, "1.5", "") is refused rather than rounded —
 * a wrong admission count is worse than a human looking at one row.
 */
function parseQuantity(raw: string | null | undefined): number | null {
  if (raw == null) return null
  const trimmed = raw.trim()
  if (!/^\d+(\.0+)?$/.test(trimmed)) return null
  const n = Math.trunc(Number(trimmed))
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

function lineLabel(item: Square.OrderLineItem): string {
  const name = item.name?.trim()
  const variation = item.variationName?.trim()
  if (name && variation) return `${name} (${variation})`
  return name || variation || '(unnamed line item)'
}

/**
 * Decide what an order entitles a household to.
 *
 * PURE. No network, no clock, no env. Everything it needs is the order and the
 * variation-id → role map.
 */
export function mapOrderToEntitlement(
  order: Square.Order,
  variationMap: VariationMap,
): Entitlement {
  const lines: MappedLine[] = []
  const unmappedLines: MappedLine[] = []
  const reviewReasons: string[] = []

  let adultQty = 0
  let sponsorQty = 0
  let under6Qty = 0
  let matched = false

  for (const item of order.lineItems ?? []) {
    const catalogObjectId = item.catalogObjectId?.trim() || null
    const role = catalogObjectId ? (variationMap[catalogObjectId] ?? null) : null
    const quantity = parseQuantity(item.quantity)

    const line: MappedLine = {
      uid: item.uid ?? null,
      catalogObjectId,
      label: lineLabel(item),
      quantity,
      role,
      problem: null,
    }

    if (role === null) {
      line.problem = catalogObjectId
        ? `unrecognised catalog variation ${catalogObjectId}`
        : 'line item has no catalog variation id (custom amount?)'
      unmappedLines.push(line)
      lines.push(line)
      continue
    }

    matched = true

    if (quantity === null) {
      line.problem = `quantity "${item.quantity}" is not a whole number`
      reviewReasons.push(`${line.label}: ${line.problem}`)
      lines.push(line)
      continue
    }

    // The only arithmetic that ever touches admissions.
    if (role === 'adult') adultQty += quantity
    else if (role === 'sponsor') sponsorQty += quantity
    else under6Qty += quantity

    lines.push(line)
  }

  // An unmapped line only matters on an order that is otherwise ours. A store
  // selling something unrelated should not fill the review queue.
  if (matched && unmappedLines.length > 0) {
    for (const line of unmappedLines) {
      reviewReasons.push(`${line.label}: ${line.problem}`)
    }
  }

  const needsReview = matched && reviewReasons.length > 0
  const admissions = adultQty + sponsorQty

  const amount = order.totalMoney?.amount
  const amountCents = amount == null ? null : Number(amount)

  const entitlement: Entitlement = {
    orderId: order.id ?? null,
    matched,
    adultQty,
    sponsorQty,
    under6Qty,
    // Withheld, not guessed, whenever any line is in doubt.
    ticketsPurchased: needsReview ? 0 : admissions,
    // Not an admission, so a review on another line does not invalidate it.
    childrenUnder6: under6Qty,
    comped: !needsReview && sponsorQty > 0,
    needsReview,
    reviewReasons,
    lines,
    unmappedLines,
    amountCents,
    currency: order.totalMoney?.currency ?? null,
    rule: '',
  }
  entitlement.rule = describeEntitlement(entitlement)
  return entitlement
}

/** The "show your work" string that lands in the preview CSV and the audit log. */
export function describeEntitlement(e: Entitlement): string {
  if (!e.matched) {
    const names = e.lines.map((l) => l.label).join(', ')
    return names ? `no Onam variation on this order (${names})` : 'order has no line items'
  }

  const parts: string[] = []
  if (e.adultQty > 0) parts.push(`${e.adultQty} × ${ROLE_LABEL.adult}`)
  if (e.sponsorQty > 0) parts.push(`${e.sponsorQty} × ${ROLE_LABEL.sponsor}`)

  const admissions = e.adultQty + e.sponsorQty
  let rule = parts.length > 0 ? `${parts.join(' + ')} = ${admissions}` : '0 admissions'
  if (e.under6Qty > 0) rule += `; ${e.under6Qty} × ${ROLE_LABEL.under6} excluded`
  if (e.needsReview) rule += `; NEEDS REVIEW (${e.reviewReasons.join('; ')}); admissions withheld`
  return rule
}

export type SquarePaymentStatus = 'paid' | 'comped' | 'needs_review'

export function paymentStatusFor(e: Entitlement): SquarePaymentStatus {
  if (e.needsReview) return 'needs_review'
  if (e.comped) return 'comped'
  return 'paid'
}

// ---------------------------------------------------------------------------
// Contact extraction
// ---------------------------------------------------------------------------

export type Contact = { name: string | null; email: string | null; phone: string | null }

/** Pure: whatever the order itself carries, in fulfillment order. */
export function contactFromOrder(order: Square.Order): Contact {
  for (const fulfillment of order.fulfillments ?? []) {
    const recipient = fulfillment.pickupDetails?.recipient
    if (!recipient) continue
    const email = recipient.emailAddress?.trim() || null
    const name = recipient.displayName?.trim() || null
    const phone = recipient.phoneNumber?.trim() || null
    if (email || name || phone) return { name, email, phone }
  }
  return { name: null, email: null, phone: null }
}

/**
 * Order first, customer record only as a fallback — the pickup recipient is who
 * actually shows up at the desk, which is not always the account holder.
 */
/**
 * Buyer identity for a Square Online sale.
 *
 * Order of preference matters, and is driven by where the data actually lives
 * in this account rather than where the docs suggest it might:
 *
 *   1. the PAYMENT — `buyerEmailAddress` and `shippingAddress.firstName/
 *      lastName`. This is the only place a Square Online ticket sale reliably
 *      records who bought it.
 *   2. the order's fulfillment recipient — empty here: these fulfillments are
 *      type DIGITAL with no recipient block.
 *   3. the customer record — reached via `payment.customerId`, because
 *      `order.customerId` is undefined on every one of these orders.
 *
 * Without step 1 the import produced 52 nameless households, which would have
 * been unfindable at the registration desk.
 */
export async function resolveContact(
  client: SquareClient,
  order: Square.Order,
  cache?: Map<string, Square.Customer | null>,
  payment?: Square.Payment,
): Promise<Contact> {
  const fromOrder = contactFromOrder(order)
  const fromPayment = contactFromPayment(payment)

  const merged: Contact = {
    name: fromOrder.name ?? fromPayment.name,
    email: fromOrder.email ?? fromPayment.email,
    phone: fromOrder.phone ?? fromPayment.phone,
  }
  if (merged.email && merged.name) return merged

  const customerId = (order.customerId ?? payment?.customerId)?.trim()
  if (!customerId) return merged

  let customer = cache?.get(customerId) ?? null
  if (!cache?.has(customerId)) {
    try {
      const res = await client.customers.get({ customerId })
      customer = res.customer ?? null
    } catch {
      customer = null // a missing customer must never fail an import row
    }
    cache?.set(customerId, customer)
  }
  if (!customer) return merged

  const fullName = [customer.givenName, customer.familyName]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(' ')

  return {
    name: merged.name ?? (fullName || customer.companyName?.trim() || null),
    email: merged.email ?? (customer.emailAddress?.trim() || null),
    phone: merged.phone ?? (customer.phoneNumber?.trim() || null),
  }
}

/** Name/email/phone as recorded on the payment itself. */
function contactFromPayment(payment?: Square.Payment): Contact {
  if (!payment) return { name: null, email: null, phone: null }

  const addr = payment.shippingAddress ?? payment.billingAddress
  const name = [addr?.firstName, addr?.lastName]
    .map((p) => p?.trim())
    .filter(Boolean)
    .join(' ')

  // Square's Address type carries no phone field; a phone number, when there
  // is one, comes from the customer record instead.
  return {
    name: name || null,
    email: payment.buyerEmailAddress?.trim() || null,
    phone: null,
  }
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export type CatalogVariation = {
  id: string
  name: string | null
  sku: string | null
  priceCents: number | null
  currency: string | null
}

export type CatalogItemSummary = {
  id: string
  name: string | null
  variations: CatalogVariation[]
}

function toVariation(object: Square.CatalogObject): CatalogVariation | null {
  if (object.type !== 'ITEM_VARIATION') return null
  const data = object.itemVariationData
  return {
    id: object.id,
    name: data?.name ?? null,
    sku: data?.sku ?? null,
    priceCents: data?.priceMoney?.amount == null ? null : Number(data.priceMoney.amount),
    currency: data?.priceMoney?.currency ?? null,
  }
}

/**
 * Find the Onam item(s) and their variation ids. Used only by the CLI that
 * fills in the env vars — the runtime never searches the catalog by name.
 */
export async function findCatalogItems(
  client: SquareClient,
  keywords: string[],
): Promise<CatalogItemSummary[]> {
  const res = await client.catalog.search({
    objectTypes: ['ITEM'],
    query: { textQuery: { keywords } },
    includeRelatedObjects: true,
  })

  // An item's `variations` are often id-only stubs; the real objects come back
  // in relatedObjects when includeRelatedObjects is set.
  const related = new Map<string, Square.CatalogObject>()
  for (const object of res.relatedObjects ?? []) {
    if (object.id) related.set(object.id, object)
  }

  const items: CatalogItemSummary[] = []
  for (const object of res.objects ?? []) {
    if (object.type !== 'ITEM' || !object.id) continue
    const variations: CatalogVariation[] = []
    for (const raw of object.itemData?.variations ?? []) {
      const full = raw.id ? (related.get(raw.id) ?? raw) : raw
      const resolved = toVariation(raw) ?? toVariation(full)
      if (resolved) variations.push(resolved)
    }
    items.push({ id: object.id, name: object.itemData?.name ?? null, variations })
  }
  return items
}

/** Exact SKU lookup, for confirming the item the variations belong to. */
export async function findVariationsBySku(
  client: SquareClient,
  sku: string,
): Promise<CatalogVariation[]> {
  const res = await client.catalog.search({
    objectTypes: ['ITEM_VARIATION'],
    query: { exactQuery: { attributeName: 'sku', attributeValue: sku } },
  })
  return (res.objects ?? []).map(toVariation).filter((v): v is CatalogVariation => v !== null)
}

// ---------------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------------

/**
 * Orders that were actually paid for, oldest first.
 *
 * Driven by PAYMENTS, not by order state. This matters: Square Online leaves a
 * ticket order in state OPEN forever, because nothing ever marks it fulfilled.
 * Filtering orders on state = COMPLETED returned 1 of 53 real sales here — an
 * import that would have quietly issued almost no tickets.
 *
 * Going through payments also excludes the 15 DRAFT orders sitting in this
 * account, which are abandoned checkouts that were never paid. Money received
 * is the only thing that should ever grant an admission.
 */
export async function fetchPaidOrders(
  client: SquareClient,
  opts: { locationId: string; since?: string; max?: number },
): Promise<{ orders: Square.Order[]; paymentsByOrder: Map<string, Square.Payment> }> {
  const paymentsByOrder = new Map<string, Square.Payment>()
  let cursor: string | undefined

  do {
    const res = await client.payments.list({
      locationId: opts.locationId,
      beginTime: opts.since,
      cursor,
      limit: 100,
    })
    for (const payment of res.data ?? []) {
      if (payment.status !== 'COMPLETED') continue
      if (!payment.orderId) continue
      // One payment per order is the norm here; keep the first COMPLETED one.
      if (!paymentsByOrder.has(payment.orderId)) {
        paymentsByOrder.set(payment.orderId, payment)
      }
    }
    cursor = res.response?.cursor
  } while (cursor && (opts.max == null || paymentsByOrder.size < opts.max))

  const ids = [...paymentsByOrder.keys()].slice(0, opts.max ?? undefined)
  const orders: Square.Order[] = []

  // batchGet caps at 100 ids per call.
  for (let i = 0; i < ids.length; i += 100) {
    const res = await client.orders.batchGet({ orderIds: ids.slice(i, i + 100) })
    orders.push(...(res.orders ?? []))
  }

  orders.sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
  return { orders, paymentsByOrder }
}
