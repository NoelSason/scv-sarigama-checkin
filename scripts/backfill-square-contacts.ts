/**
 * Re-ask Square who bought a ticket, for the households it could not name.
 *
 *   npm run backfill:square              # plan only
 *   npm run backfill:square -- --commit
 *
 * Why this exists at all:
 *
 * A Square Online sale carries the buyer on the payment record, so the webhook
 * names the household on the spot. A card-present sale rung up on the terminal
 * carries nothing — no cardholder name, no billing address — and the "instant
 * profile" customer that Square attaches to the card is created empty and
 * filled in afterwards, when the buyer taps through the receipt prompt. The
 * webhook fires seconds before that, sees an empty profile, and falls back to
 * `Square order <id>`.
 *
 * Nothing ever went back to look again. This does.
 *
 * What it can and cannot recover: an email, sometimes a phone — whatever the
 * buyer gave the terminal for their receipt. A NAME is not recoverable, because
 * Square never captured one. Those rows still have to be typed in by hand at
 * the registration desk; this script's job is to shrink that list and to say
 * plainly which rows remain.
 *
 * Safe to re-run. It only ever fills in blanks: a name typed by a volunteer is
 * never overwritten, and neither is an email already on file.
 */
import { query } from '@/lib/db'
import { logAudit } from '@/lib/households'
import { resolveContact, squareClient } from '@/lib/square'
import { normalizeEmail, normalizePhone } from '@/lib/tokens'
import type { Square } from 'square'

type Row = {
  id: string
  display_name: string
  email: string | null
  phone: string | null
  square_order_id: string
  square_payment_id: string | null
}

const PLACEHOLDER = /^Square order /

async function main() {
  const commit = process.argv.includes('--commit')

  const rows = await query<Row>(
    `select id, display_name, email, phone, square_order_id, square_payment_id
       from households
      where not is_test
        and merged_into_id is null
        and square_order_id is not null
        and (display_name like 'Square order %' or email is null or phone is null)
      order by created_at`,
  )

  if (rows.length === 0) {
    console.log('Nothing to look up — every Square household already has a name and contact detail.')
    return
  }

  console.log(`Re-checking ${rows.length} Square household(s) against the API.\n`)

  const client = squareClient()
  const customers = new Map<string, Square.Customer | null>()
  let filled = 0
  const stillNameless: Row[] = []

  for (const row of rows) {
    const order = (await client.orders.get({ orderId: row.square_order_id })).order
    if (!order) {
      console.log(`  ${row.display_name} — order ${row.square_order_id} not found, skipped`)
      continue
    }

    let payment: Square.Payment | undefined
    if (row.square_payment_id) {
      try {
        payment = (await client.payments.get({ paymentId: row.square_payment_id })).payment
      } catch {
        // Contact detail is a nicety; a payment we cannot read is not an error.
      }
    }

    const contact = await resolveContact(client, order, customers, payment)
    const resolvedName = contact.name ?? contact.email

    // Only fill blanks. A volunteer's correction outranks anything Square has.
    const nextName = PLACEHOLDER.test(row.display_name) && resolvedName ? resolvedName : null
    const nextEmail = row.email ? null : (contact.email ?? null)
    const nextPhone = row.phone ? null : (contact.phone ?? null)

    if (!nextName && !nextEmail && !nextPhone) {
      if (PLACEHOLDER.test(row.display_name)) stillNameless.push(row)
      continue
    }

    const changes = [
      nextName && `name → ${nextName}`,
      nextEmail && `email → ${nextEmail}`,
      nextPhone && `phone → ${nextPhone}`,
    ].filter(Boolean)
    console.log(`  ${row.display_name}\n      ${changes.join('\n      ')}`)
    filled++

    if (PLACEHOLDER.test(row.display_name) && !nextName) stillNameless.push(row)

    if (!commit) continue

    await query(
      `update households
          set display_name     = coalesce($2, display_name),
              email            = coalesce($3, email),
              normalized_email = coalesce($4, normalized_email),
              phone            = coalesce($5, phone),
              normalized_phone = coalesce($6, normalized_phone)
        where id = $1`,
      [
        row.id,
        nextName,
        nextEmail,
        nextEmail ? normalizeEmail(nextEmail) : null,
        nextPhone,
        nextPhone ? normalizePhone(nextPhone) : null,
      ],
    )

    await logAudit('square.contact_backfilled', {
      actorType: 'system',
      householdId: row.id,
      metadata: {
        order_id: row.square_order_id,
        name: nextName,
        email: nextEmail,
        phone: nextPhone,
      },
    })
  }

  console.log(
    commit
      ? `\n${filled} household(s) updated.`
      : `\nDRY RUN — ${filled} household(s) would be updated. Re-run with --commit.`,
  )

  if (stillNameless.length > 0) {
    console.log(
      `\n${stillNameless.length} household(s) Square still cannot name. These were rung up on ` +
        `the terminal, where no name is ever captured — set them by hand at the registration ` +
        `desk (search the order id, then Edit contact details):\n`,
    )
    for (const r of stillNameless) {
      const known = [r.email, r.phone].filter(Boolean).join(' / ')
      console.log(`  ${r.square_order_id}${known ? `  (${known})` : '  (no contact detail at all)'}`)
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
