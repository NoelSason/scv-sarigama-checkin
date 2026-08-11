/**
 * Square → households import.
 *
 *   npx dotenv -e .env.local -- npx tsx scripts/import-square.ts             # dry run (default)
 *   npx dotenv -e .env.local -- npx tsx scripts/import-square.ts --commit
 *   ... --since 2026-01-01T00:00:00Z --out out-import/square-preview.csv
 *
 * Dry run is the default and writes NOTHING — not a household, not a review
 * item, not a sync_runs row. It only produces out-import/square-preview.csv.
 *
 * The CSV shows its work per row (which variation, what quantity, the arithmetic)
 * because a wrong admission count is the one failure this event cannot absorb.
 * Admissions come from line_item.quantity matched by catalog variation id —
 * never from an amount, never from a display name (those quote a stale price).
 *
 * --commit runs every write inside ONE transaction tagged with an
 * import_batches row, so the whole import lands or none of it does. Re-running
 * updates the same households (matched on square_order_id); it never duplicates.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import type { PoolClient } from '@neondatabase/serverless'
import type { Square } from 'square'
import { query, transaction } from '../src/lib/db'
import {
  fetchPaidOrders,
  mapOrderToEntitlement,
  paymentStatusFor,
  resolveContact,
  squareClient,
  squareLocationId,
  variationMapFromEnv,
  type Contact,
  type Entitlement,
} from '../src/lib/square'
import { generatePassToken, normalizeEmail, normalizePhone } from '../src/lib/tokens'

type Action = 'create' | 'update' | 'unchanged' | 'review' | 'skip' | 'blocked'

type Row = {
  action: Action
  order: Square.Order
  entitlement: Entitlement
  contact: Contact
  existing: ExistingHousehold | null
  paymentStatus: string
  note: string
}

type ExistingHousehold = {
  id: string
  display_name: string
  email: string | null
  phone: string | null
  tickets_purchased: number
  tickets_redeemed: number
  children_under_6: number
  payment_status: string
  amount_paid_cents: number | null
}

function arg(name: string, fallback: string | null = null): string | null {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1]
  }
  const inline = process.argv.find((a) => a.startsWith(`--${name}=`))
  return inline ? inline.slice(name.length + 3) : fallback
}

function csvCell(value: unknown): string {
  const s = value == null ? '' : String(value)
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

function dollars(cents: number | null): string {
  return cents == null ? '' : (cents / 100).toFixed(2)
}

async function main() {
  const commit = process.argv.includes('--commit')
  const since = arg('since', '2026-01-01T00:00:00Z')!
  const outPath = resolve(process.cwd(), arg('out', 'out-import/square-preview.csv')!)
  const maxArg = arg('max')
  const max = maxArg ? Number(maxArg) : undefined

  const client = squareClient()
  const variationMap = variationMapFromEnv()
  const locationId = squareLocationId()

  // Payment-driven: an order only counts if money actually arrived for it.
  console.log(`Fetching paid orders since ${since} …`)
  const { orders, paymentsByOrder } = await fetchPaidOrders(client, { locationId, since, max })
  console.log(`  ${orders.length} paid orders`)

  // Every order we have already imported, in one round trip.
  const orderIds = orders.map((o) => o.id).filter((id): id is string => Boolean(id))
  const existingByOrder = await loadExisting(orderIds)

  const customerCache = new Map<string, Square.Customer | null>()
  const rows: Row[] = []

  for (const order of orders) {
    const entitlement = mapOrderToEntitlement(order, variationMap)

    if (!entitlement.matched) {
      // Not an Onam purchase. Still listed in the CSV so nothing is silently dropped.
      rows.push({
        action: 'skip',
        order,
        entitlement,
        contact: { name: null, email: null, phone: null },
        existing: null,
        paymentStatus: '',
        note: 'no Onam variation on this order',
      })
      continue
    }

    // The payment carries the buyer's name and email; the order does not.
    const contact = await resolveContact(
      client,
      order,
      customerCache,
      order.id ? paymentsByOrder.get(order.id) : undefined,
    )
    const existing = order.id ? (existingByOrder.get(order.id) ?? null) : null
    const paymentStatus = paymentStatusFor(entitlement)

    let action: Action
    let note = ''

    if (entitlement.needsReview) {
      action = 'review'
      note = 'admissions withheld pending review'
    } else if (!existing) {
      action = 'create'
    } else if (entitlement.ticketsPurchased < existing.tickets_redeemed) {
      action = 'blocked'
      note = `${existing.tickets_redeemed} admissions already redeemed — refusing to lower to ${entitlement.ticketsPurchased}`
    } else if (isUnchanged(existing, entitlement, contact, paymentStatus)) {
      action = 'unchanged'
    } else {
      action = 'update'
      note = `was ${existing.tickets_purchased} admissions / ${existing.children_under_6} under-6`
    }

    rows.push({ action, order, entitlement, contact, existing, paymentStatus, note })
  }

  writePreview(outPath, rows)
  console.log(`\nPreview written to ${outPath}`)
  printSummary(rows)

  if (!commit) {
    console.log('\nDRY RUN — nothing was written to the database. Re-run with --commit to apply.')
    return
  }

  const stats = await applyRows(rows, since)
  console.log('\nCOMMITTED')
  console.log(JSON.stringify(stats, null, 2))
}

function isUnchanged(
  existing: ExistingHousehold,
  entitlement: Entitlement,
  contact: Contact,
  paymentStatus: string,
): boolean {
  const name = contact.name ?? contact.email ?? existing.display_name
  return (
    existing.tickets_purchased === entitlement.ticketsPurchased &&
    existing.children_under_6 === entitlement.childrenUnder6 &&
    existing.payment_status === paymentStatus &&
    existing.amount_paid_cents === entitlement.amountCents &&
    existing.display_name === name &&
    (contact.email == null || existing.email === contact.email) &&
    (contact.phone == null || existing.phone === contact.phone)
  )
}

async function loadExisting(orderIds: string[]): Promise<Map<string, ExistingHousehold>> {
  const map = new Map<string, ExistingHousehold>()
  if (orderIds.length === 0) return map
  const rows = await query<ExistingHousehold & { square_order_id: string }>(
    `select id, display_name, email, phone, tickets_purchased, tickets_redeemed,
            children_under_6, payment_status, amount_paid_cents, square_order_id
       from households
      where square_order_id = any($1::text[])`,
    [orderIds],
  )
  for (const row of rows) map.set(row.square_order_id, row)
  return map
}

const CSV_HEADER = [
  'source',
  'action',
  'square_order_id',
  'created_at',
  'name',
  'email',
  'phone',
  'amount_usd',
  'ages_6_plus_qty',
  'sponsors_qty',
  'under_6_qty',
  'tickets_purchased',
  'children_under_6',
  'rule',
  'payment_status',
  'line_items',
  'existing_tickets_purchased',
  'existing_tickets_redeemed',
  'note',
]

function writePreview(outPath: string, rows: Row[]): void {
  const lines = [CSV_HEADER.join(',')]

  for (const r of rows) {
    const e = r.entitlement
    // Raw Square labels, quantities and ids — the reviewer can check every claim.
    const lineItems = e.lines
      .map((l) => `${l.quantity ?? '?'} × ${l.label} [${l.catalogObjectId ?? 'no-variation-id'}]`)
      .join(' | ')

    lines.push(
      [
        'square',
        r.action,
        r.order.id ?? '',
        r.order.createdAt ?? '',
        r.contact.name ?? '',
        r.contact.email ?? '',
        r.contact.phone ?? '',
        dollars(e.amountCents),
        e.adultQty,
        e.sponsorQty,
        e.under6Qty,
        r.action === 'skip' ? '' : e.ticketsPurchased,
        r.action === 'skip' ? '' : e.childrenUnder6,
        e.rule,
        r.paymentStatus,
        lineItems,
        r.existing?.tickets_purchased ?? '',
        r.existing?.tickets_redeemed ?? '',
        r.note,
      ]
        .map(csvCell)
        .join(','),
    )
  }

  mkdirSync(dirname(outPath), { recursive: true })
  writeFileSync(outPath, `${lines.join('\n')}\n`, 'utf8')
}

function printSummary(rows: Row[]): void {
  const counts: Record<string, number> = {}
  for (const r of rows) counts[r.action] = (counts[r.action] ?? 0) + 1

  const applied = rows.filter((r) => r.action === 'create' || r.action === 'update')
  const admissions = applied.reduce((n, r) => n + r.entitlement.ticketsPurchased, 0)
  const under6 = applied.reduce((n, r) => n + r.entitlement.childrenUnder6, 0)

  console.log('\nSummary')
  for (const [action, n] of Object.entries(counts).sort()) console.log(`  ${action.padEnd(10)} ${n}`)
  console.log(`  admissions in create+update rows: ${admissions}`)
  console.log(`  under-6 children (not admissions): ${under6}`)

  for (const r of rows.filter((x) => x.action === 'review' || x.action === 'blocked')) {
    console.log(`  ! ${r.action} ${r.order.id}: ${r.entitlement.rule} ${r.note}`)
  }
}

/** Every write for the whole import, in one transaction, tagged with a batch. */
async function applyRows(rows: Row[], since: string): Promise<Record<string, number>> {
  const stats = { created: 0, updated: 0, unchanged: 0, review_items: 0, skipped: 0, blocked: 0 }

  await transaction(async (c: PoolClient) => {
    const batch = await c.query<{ id: string }>(
      `insert into import_batches (kind, status, note) values ('square', 'running', $1) returning id`,
      [`square import since ${since}`],
    )
    const batchId = batch.rows[0].id

    for (const r of rows) {
      if (r.action === 'skip') {
        stats.skipped++
        continue
      }
      if (r.action === 'unchanged') {
        stats.unchanged++
        continue
      }

      const orderId = r.order.id!
      const e = r.entitlement
      const name = r.contact.name ?? r.contact.email ?? `Square order ${orderId}`

      if (r.action === 'blocked') {
        stats.blocked++
        await openReview(c, {
          kind: 'amount_mismatch',
          householdId: r.existing?.id ?? null,
          sourceRecordId: orderId,
          summary: `Square order ${orderId}: ${r.note}`,
          payload: { rule: e.rule, tickets_purchased: e.ticketsPurchased },
        })
        stats.review_items++
        continue
      }

      // 'review' rows are still created/updated so the household exists at the
      // desk — but with 0 admissions, needs_review, and a review item.
      let householdId: string
      let inserted: { rows: Array<{ id: string }> } = { rows: [] }

      if (!r.existing) {
        // ON CONFLICT DO NOTHING: the webhook may have created this household
        // between the preview and the commit. Falling through to the update
        // beats rolling the whole batch back.
        inserted = await c.query<{ id: string }>(
          `insert into households
             (display_name, email, phone, normalized_email, normalized_phone,
              tickets_purchased, children_under_6, payment_status, payment_method,
              amount_paid_cents, pass_token, source, source_record_id,
              square_order_id, notes, import_batch_id)
           values ($1,$2,$3,$4,$5,$6,$7,$8::payment_status,'square',$9,$10,'square',$11,$11,$12,$13)
           on conflict (square_order_id) where square_order_id is not null do nothing
           returning id`,
          [
            name,
            r.contact.email,
            r.contact.phone,
            normalizeEmail(r.contact.email),
            normalizePhone(r.contact.phone),
            e.ticketsPurchased,
            e.childrenUnder6,
            r.paymentStatus,
            e.amountCents,
            generatePassToken(),
            orderId,
            e.rule,
            batchId,
          ],
        )
      }

      if (inserted.rows.length > 0) {
        householdId = inserted.rows[0].id
        stats.created++
      } else {
        const current = await c.query<{ id: string; tickets_redeemed: number }>(
          `select id, tickets_redeemed from households where square_order_id = $1`,
          [orderId],
        )
        if (current.rows.length === 0) {
          throw new Error(`household for Square order ${orderId} could not be created or found`)
        }
        householdId = current.rows[0].id

        if (e.ticketsPurchased < current.rows[0].tickets_redeemed) {
          stats.blocked++
          await openReview(c, {
            kind: 'amount_mismatch',
            householdId,
            sourceRecordId: orderId,
            summary:
              `Square order ${orderId} entitles ${e.ticketsPurchased} admissions but ` +
              `${current.rows[0].tickets_redeemed} are already redeemed. Left unchanged.`,
            payload: { rule: e.rule, tickets_purchased: e.ticketsPurchased },
          })
          stats.review_items++
          continue
        }

        await c.query(
          `update households
              set display_name      = $2,
                  email             = coalesce($3, email),
                  phone             = coalesce($4, phone),
                  normalized_email  = coalesce($5, normalized_email),
                  normalized_phone  = coalesce($6, normalized_phone),
                  tickets_purchased = $7,
                  children_under_6  = $8,
                  payment_status    = $9::payment_status,
                  payment_method    = 'square',
                  amount_paid_cents = $10,
                  source            = 'square',
                  source_record_id  = $11,
                  import_batch_id   = $12
            where id = $1`,
          // notes is left alone: staff write in it.
          [
            householdId,
            name,
            r.contact.email,
            r.contact.phone,
            normalizeEmail(r.contact.email),
            normalizePhone(r.contact.phone),
            e.ticketsPurchased,
            e.childrenUnder6,
            r.paymentStatus,
            e.amountCents,
            orderId,
            batchId,
          ],
        )
        stats.updated++
      }

      if (e.needsReview) {
        await openReview(c, {
          kind: 'unmapped_square_item',
          householdId,
          sourceRecordId: orderId,
          summary: `Square order ${orderId} has items we do not map to an admission. Admissions withheld. ${e.rule}`,
          payload: {
            rule: e.rule,
            review_reasons: e.reviewReasons,
            unmapped: e.unmappedLines.map((l) => ({
              catalog_object_id: l.catalogObjectId,
              label: l.label,
              quantity: l.quantity,
            })),
          },
        })
        stats.review_items++
      }

      await c.query(
        `insert into audit_logs (actor_type, actor_id, action, household_id, metadata)
         values ('import', 'square', $1, $2, $3::jsonb)`,
        [
          inserted.rows.length > 0
            ? 'square.import.household_created'
            : 'square.import.household_updated',
          householdId,
          JSON.stringify({ order_id: orderId, rule: e.rule, batch_id: batchId }),
        ],
      )
    }

    await c.query(
      `update import_batches
          set status = 'committed', finished_at = now(), stats = $2::jsonb
        where id = $1`,
      [batchId, JSON.stringify(stats)],
    )

    await c.query(
      `insert into sync_runs (source, status, dry_run, stats, finished_at)
       values ('square', 'ok', false, $1::jsonb, now())`,
      [JSON.stringify({ ...stats, batch_id: batchId, since })],
    )
  })

  return stats
}

async function openReview(
  c: PoolClient,
  item: {
    kind: string
    householdId: string | null
    sourceRecordId: string
    summary: string
    payload: Record<string, unknown>
  },
): Promise<void> {
  await c.query(
    `insert into review_items (kind, household_id, source, source_record_id, summary, payload)
     values ($1, $2, 'square', $3, $4, $5::jsonb)
     on conflict do nothing`,
    [item.kind, item.householdId, item.sourceRecordId, item.summary, JSON.stringify(item.payload)],
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
