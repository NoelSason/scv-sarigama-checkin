import { NextResponse } from 'next/server'
import { WebhooksHelper, type Square } from 'square'
import { query, queryOne } from '@/lib/db'
import { logAudit } from '@/lib/households'
import {
  mapOrderToEntitlement,
  paymentStatusFor,
  resolveContact,
  squareClient,
  variationMapFromEnv,
  webhookNotificationUrl,
  type Entitlement,
} from '@/lib/square'
import { generatePassToken, normalizeEmail, normalizePhone } from '@/lib/tokens'

/**
 * Square webhook receiver.
 *
 * Order of operations is the whole design:
 *
 *   1. read the RAW body (signature is over bytes, not over a reparse)
 *   2. verify the signature — invalid means 401 and nothing else happens
 *   3. claim the event by INSERTing payment_events(provider, external_event_id);
 *      a unique violation means we already have it, so return 200 and stop
 *   4. only then touch households
 *
 * Square retries non-2xx responses. Because step 3 has already claimed the
 * event id, a retry would be deduplicated rather than reprocessed — so a
 * failure inside step 4 is recorded on the event row and surfaced in the review
 * queue instead of being thrown back at Square.
 */

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const HANDLED = new Set(['payment.created', 'payment.updated', 'refund.updated'])

// Square sends raw API JSON: snake_case, unlike the SDK's camelCase types.
type EventMoney = { amount?: number; currency?: string }

type EventPayment = {
  id?: string
  status?: string
  order_id?: string
  customer_id?: string
  amount_money?: EventMoney
  total_money?: EventMoney
  buyer_email_address?: string
}

type EventRefund = {
  id?: string
  status?: string
  order_id?: string
  payment_id?: string
  amount_money?: EventMoney
}

type SquareEventEnvelope = {
  merchant_id?: string
  type?: string
  event_id?: string
  created_at?: string
  data?: {
    type?: string
    id?: string
    object?: { payment?: EventPayment; refund?: EventRefund }
  }
}

type HouseholdRow = {
  id: string
  display_name: string
  email: string | null
  phone: string | null
  tickets_purchased: number
  tickets_redeemed: number
  children_under_6: number
  payment_status: string
  amount_paid_cents: number | null
  pass_enabled: boolean
}

export async function POST(req: Request) {
  // Must happen before any parse: the signature covers these exact bytes.
  const rawBody = await req.text()
  const signature = req.headers.get('x-square-hmacsha256-signature')
  const signatureKey = process.env.SQUARE_WEBHOOK_SIGNATURE_KEY

  if (!signatureKey) {
    console.error('[square-webhook] SQUARE_WEBHOOK_SIGNATURE_KEY is not set')
    return NextResponse.json({ error: 'NOT_CONFIGURED' }, { status: 500 })
  }
  if (!signature) {
    return NextResponse.json({ error: 'UNSIGNED' }, { status: 401 })
  }

  let valid = false
  try {
    valid = await WebhooksHelper.verifySignature({
      requestBody: rawBody,
      signatureHeader: signature,
      signatureKey,
      notificationUrl: webhookNotificationUrl(),
    })
  } catch (err) {
    console.error('[square-webhook] signature verification failed', err)
    return NextResponse.json({ error: 'INVALID_SIGNATURE' }, { status: 401 })
  }
  if (!valid) {
    return NextResponse.json({ error: 'INVALID_SIGNATURE' }, { status: 401 })
  }

  let event: SquareEventEnvelope
  try {
    event = JSON.parse(rawBody) as SquareEventEnvelope
  } catch {
    return NextResponse.json({ error: 'BAD_JSON' }, { status: 400 })
  }

  const eventId = event.event_id
  const eventType = event.type ?? ''
  if (!eventId) return NextResponse.json({ error: 'MISSING_EVENT_ID' }, { status: 400 })

  const payment = event.data?.object?.payment
  const refund = event.data?.object?.refund
  const amountCents = payment?.amount_money?.amount ?? refund?.amount_money?.amount ?? null

  // Claim the event. Losing the race here means a duplicate delivery.
  const claimed = await queryOne<{ id: string }>(
    `insert into payment_events
       (provider, external_event_id, external_payment_id, external_order_id,
        event_type, amount_cents, raw_metadata)
     values ('square', $1, $2, $3, $4, $5, $6::jsonb)
     on conflict (provider, external_event_id) do nothing
     returning id`,
    [
      eventId,
      payment?.id ?? refund?.payment_id ?? null,
      payment?.order_id ?? refund?.order_id ?? null,
      eventType,
      amountCents,
      JSON.stringify(event),
    ],
  )
  if (!claimed) {
    return NextResponse.json({ ok: true, duplicate: true })
  }

  if (!HANDLED.has(eventType)) {
    await markProcessed(claimed.id, null, null)
    return NextResponse.json({ ok: true, ignored: eventType })
  }

  try {
    const householdId =
      eventType === 'refund.updated'
        ? await handleRefund(refund, eventId)
        : await handlePayment(payment, eventId)
    await markProcessed(claimed.id, householdId, null)
  } catch (err) {
    // Never rethrow: the event id is already claimed, so a Square retry would
    // be deduplicated. Record it and put a human on it.
    const message = err instanceof Error ? err.message : String(err)
    console.error('[square-webhook] processing failed', eventId, err)
    await markProcessed(claimed.id, null, message)
    await openReviewItem({
      kind: 'webhook_error',
      sourceRecordId: eventId,
      summary: `Square webhook ${eventType} could not be processed: ${message}`,
      payload: { event_id: eventId, event_type: eventType, error: message },
    })
  }

  return NextResponse.json({ ok: true })
}

async function markProcessed(
  eventRowId: string,
  householdId: string | null,
  error: string | null,
): Promise<void> {
  await query(
    `update payment_events
        set processed_at = now(), household_id = $2, error = $3
      where id = $1`,
    [eventRowId, householdId, error],
  )
}

async function openReviewItem(item: {
  kind: string
  householdId?: string | null
  sourceRecordId: string | null
  summary: string
  payload: Record<string, unknown>
}): Promise<void> {
  // The partial unique index keeps one open item per (kind, source, record).
  await query(
    `insert into review_items (kind, household_id, source, source_record_id, summary, payload)
     values ($1, $2, 'square', $3, $4, $5::jsonb)
     on conflict do nothing`,
    [
      item.kind,
      item.householdId ?? null,
      item.sourceRecordId,
      item.summary,
      JSON.stringify(item.payload),
    ],
  )
}

/** COMPLETED payments provision. Everything else is recorded and ignored. */
async function handlePayment(
  payment: EventPayment | undefined,
  eventId: string,
): Promise<string | null> {
  if (!payment) return null
  if (payment.status !== 'COMPLETED') return null

  const orderId = payment.order_id
  if (!orderId) {
    await openReviewItem({
      kind: 'missing_data',
      sourceRecordId: payment.id ?? eventId,
      summary: `Square payment ${payment.id ?? '(unknown)'} completed with no order id — cannot determine admissions.`,
      payload: { event_id: eventId, payment_id: payment.id ?? null },
    })
    return null
  }

  const client = squareClient()
  const variationMap = variationMapFromEnv()

  const orderRes = await client.orders.get({ orderId })
  const order = orderRes.order
  if (!order) throw new Error(`Square order ${orderId} not found`)

  const entitlement = mapOrderToEntitlement(order, variationMap)
  if (!entitlement.matched) {
    // Some other product sold through the same store. Not ours, not an error.
    return null
  }

  // Refetch the payment through the SDK: the webhook envelope carries only a
  // trimmed payment object, and the buyer's name lives on the full record's
  // shippingAddress. Without this, new sales arrive as nameless households and
  // the registration desk cannot find them by name.
  let fullPayment: Square.Payment | undefined
  if (payment.id) {
    try {
      fullPayment = (await client.payments.get({ paymentId: payment.id })).payment
    } catch {
      // Contact detail is a nicety; never fail provisioning over it.
    }
  }

  const contact = await resolveContact(client, order, undefined, fullPayment)
  const displayName = contact.name ?? contact.email ?? `Square order ${orderId}`

  const status = paymentStatusFor(entitlement)
  const amountCents = entitlement.amountCents

  // payment.created and payment.updated for the same order arrive nearly
  // together, so the insert must be the thing that decides who wins — not a
  // preceding SELECT. ON CONFLICT DO NOTHING makes the loser fall through to
  // the update path instead of raising a unique violation.
  const created = await queryOne<{ id: string }>(
    `insert into households
       (display_name, email, phone, normalized_email, normalized_phone,
        tickets_purchased, children_under_6, payment_status, payment_method,
        amount_paid_cents, pass_token, source, source_record_id,
        square_order_id, square_payment_id, notes)
     values ($1,$2,$3,$4,$5,$6,$7,$8::payment_status,'square',$9,$10,'square',$11,$11,$12,$13)
     on conflict (square_order_id) where square_order_id is not null do nothing
     returning id`,
    [
      displayName,
      contact.email,
      contact.phone,
      normalizeEmail(contact.email),
      normalizePhone(contact.phone),
      entitlement.ticketsPurchased,
      entitlement.childrenUnder6,
      status,
      amountCents,
      generatePassToken(),
      orderId,
      payment.id ?? null,
      entitlement.rule,
    ],
  )

  const existing = created
    ? null
    : await queryOne<HouseholdRow>(
        `select id, display_name, email, phone, tickets_purchased, tickets_redeemed,
                children_under_6, payment_status, amount_paid_cents, pass_enabled
           from households where square_order_id = $1`,
        [orderId],
      )

  let householdId: string
  if (created) {
    householdId = created.id
  } else {
    if (!existing) throw new Error(`household for Square order ${orderId} vanished mid-write`)
    householdId = existing.id

    // The database CHECK would reject this anyway; refuse it here so a human
    // sees why rather than a webhook 500.
    if (entitlement.ticketsPurchased < existing.tickets_redeemed) {
      await openReviewItem({
        kind: 'amount_mismatch',
        householdId,
        sourceRecordId: orderId,
        summary:
          `Square order ${orderId} now entitles ${entitlement.ticketsPurchased} admissions ` +
          `but ${existing.tickets_redeemed} have already been redeemed. Left unchanged.`,
        payload: { event_id: eventId, rule: entitlement.rule, entitlement: summarize(entitlement) },
      })
      return householdId
    }

    await query(
      `update households
          set display_name       = $2,
              email              = coalesce($3, email),
              phone              = coalesce($4, phone),
              normalized_email   = coalesce($5, normalized_email),
              normalized_phone   = coalesce($6, normalized_phone),
              tickets_purchased  = $7,
              children_under_6   = $8,
              payment_status     = $9::payment_status,
              payment_method     = 'square',
              amount_paid_cents  = $10,
              square_payment_id  = coalesce($11, square_payment_id)
        where id = $1`,
      // notes is deliberately not touched on update: staff write in it.
      [
        householdId,
        displayName,
        contact.email,
        contact.phone,
        normalizeEmail(contact.email),
        normalizePhone(contact.phone),
        entitlement.ticketsPurchased,
        entitlement.childrenUnder6,
        status,
        amountCents,
        payment.id ?? null,
      ],
    )
  }

  if (entitlement.needsReview) {
    await openReviewItem({
      kind: 'unmapped_square_item',
      householdId,
      sourceRecordId: orderId,
      summary:
        `Square order ${orderId} has items we do not map to an admission. ` +
        `Admissions withheld. ${entitlement.rule}`,
      payload: { event_id: eventId, entitlement: summarize(entitlement) },
    })
  }

  await logAudit(created ? 'square.webhook.household_created' : 'square.webhook.household_updated', {
    actorType: 'webhook',
    householdId,
    metadata: { event_id: eventId, order_id: orderId, rule: entitlement.rule },
  })

  return householdId
}

async function handleRefund(
  refund: EventRefund | undefined,
  eventId: string,
): Promise<string | null> {
  if (!refund) return null
  if (refund.status !== 'COMPLETED') return null

  const household = await queryOne<HouseholdRow & { square_order_id: string | null }>(
    `select id, display_name, email, phone, tickets_purchased, tickets_redeemed,
            children_under_6, payment_status, amount_paid_cents, pass_enabled, square_order_id
       from households
      where ($1::text is not null and square_order_id = $1)
         or ($2::text is not null and square_payment_id = $2)
      limit 1`,
    [refund.order_id ?? null, refund.payment_id ?? null],
  )

  if (!household) {
    await openReviewItem({
      kind: 'missing_data',
      sourceRecordId: refund.id ?? eventId,
      summary: `Square refund ${refund.id ?? '(unknown)'} has no matching household.`,
      payload: { event_id: eventId, refund_id: refund.id ?? null, order_id: refund.order_id ?? null },
    })
    return null
  }

  // The hard rule: once anyone has eaten, a refund never rewrites the ledger.
  if (household.tickets_redeemed > 0) {
    await openReviewItem({
      kind: 'refund_after_redemption',
      householdId: household.id,
      sourceRecordId: household.square_order_id ?? refund.id ?? eventId,
      summary:
        `Refund on ${household.display_name} after ${household.tickets_redeemed} of ` +
        `${household.tickets_purchased} admissions were already redeemed. Nothing changed — decide manually.`,
      payload: {
        event_id: eventId,
        refund_id: refund.id ?? null,
        refund_amount_cents: refund.amount_money?.amount ?? null,
        tickets_redeemed: household.tickets_redeemed,
      },
    })
    return household.id
  }

  const fullRefund = await isFullRefund(refund, household.amount_paid_cents)

  if (!fullRefund) {
    await openReviewItem({
      kind: 'amount_mismatch',
      householdId: household.id,
      sourceRecordId: household.square_order_id ?? refund.id ?? eventId,
      summary:
        `Partial refund on ${household.display_name} — how many admissions to remove is a judgement call. ` +
        `Marked partially_refunded; admissions unchanged.`,
      payload: {
        event_id: eventId,
        refund_id: refund.id ?? null,
        refund_amount_cents: refund.amount_money?.amount ?? null,
        amount_paid_cents: household.amount_paid_cents,
      },
    })
    await query(
      `update households set payment_status = 'partially_refunded'::payment_status where id = $1`,
      [household.id],
    )
    return household.id
  }

  await query(
    `update households
        set tickets_purchased = 0,
            children_under_6  = 0,
            payment_status    = 'refunded'::payment_status,
            pass_enabled      = false
      where id = $1`,
    [household.id],
  )
  await logAudit('square.webhook.refund_zeroed', {
    actorType: 'webhook',
    householdId: household.id,
    metadata: { event_id: eventId, refund_id: refund.id ?? null },
  })
  return household.id
}

/**
 * Square is the authority on how much of a payment has been refunded — the
 * refund event alone only carries this refund's amount, and there may be
 * several.
 */
async function isFullRefund(
  refund: EventRefund,
  amountPaidCents: number | null,
): Promise<boolean> {
  if (refund.payment_id) {
    try {
      const res = await squareClient().payments.get({ paymentId: refund.payment_id })
      const payment: Square.Payment | undefined = res.payment
      const total = payment?.totalMoney?.amount ?? payment?.amountMoney?.amount
      const refunded = payment?.refundedMoney?.amount
      if (total != null && refunded != null) return refunded >= total
    } catch {
      // fall through to the local comparison
    }
  }
  const refunded = refund.amount_money?.amount
  if (refunded == null || amountPaidCents == null) return false
  return refunded >= amountPaidCents
}

function summarize(e: Entitlement) {
  return {
    rule: e.rule,
    adult_qty: e.adultQty,
    sponsor_qty: e.sponsorQty,
    under6_qty: e.under6Qty,
    tickets_purchased: e.ticketsPurchased,
    review_reasons: e.reviewReasons,
    unmapped: e.unmappedLines.map((l) => ({
      catalog_object_id: l.catalogObjectId,
      label: l.label,
      quantity: l.quantity,
    })),
  }
}
