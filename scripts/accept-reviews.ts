/**
 * Accept every open amount-mismatch as paid, and lock it.
 *
 *   npm run accept-reviews              # plan only
 *   npm run accept-reviews -- --commit
 *
 * These are people who paid MORE than their seats cost — a donation folded into
 * the same Zelle transfer. The importer cannot tell that from a typo, so it
 * flags them; a human can, so a human clears them.
 *
 * Locking matters as much as the status change. Without it the next sync
 * recomputes `needs_review` from the same mismatched amount and the decision is
 * gone within five minutes.
 */
import { query } from '@/lib/db'
import { logAudit } from '@/lib/households'

async function main() {
  const commit = process.argv.includes('--commit')

  const rows = await query<{
    id: string
    display_name: string
    email: string | null
    tickets_purchased: number
    payment_status: string
    amount_paid_cents: number | null
  }>(
    // Deliberately NOT filtered on locked_at. A row can be locked and still
    // wrong: these five were accepted once, then the sheet sync overwrote the
    // status back to needs_review before the code that honours the lock was
    // deployed. Skipping locked rows made the script report "nothing to do"
    // while five people sat unsendable.
    //
    // partially_refunded is included when admissions remain: the guest paid,
    // some money went back, and the tickets they kept are valid. A full
    // 'refunded' is never picked up here.
    `select id, display_name, email, tickets_purchased,
            payment_status::text as payment_status, amount_paid_cents
       from households
      where not is_test
        and merged_into_id is null
        and (
          payment_status = 'needs_review'
          or (payment_status = 'partially_refunded' and tickets_purchased > 0)
        )
      order by tickets_purchased desc`,
  )

  if (rows.length === 0) {
    console.log('No needs_review households left.')
    return
  }

  for (const r of rows) {
    const paid = r.amount_paid_cents === null ? '—' : `$${(r.amount_paid_cents / 100).toFixed(2)}`
    console.log(
      `${commit ? 'ACCEPT' : 'would accept'}  ${r.display_name}  ` +
        `${r.tickets_purchased} admissions, paid ${paid}` +
        (r.email ? `  <${r.email}>` : '  (no email — desk collection)'),
    )
    if (!commit) continue

    await query(
      `update households
          set payment_status = 'paid'::payment_status,
              locked_at      = now(),
              locked_reason  = case
                when payment_status = 'partially_refunded'
                  then 'partially refunded; the admissions still held are valid'
                else 'amount mismatch accepted by organizer (overpayment / donation)'
              end
        where id = $1`,
      [r.id],
    )
    await logAudit('payment_accepted', {
      actorType: 'staff',
      householdId: r.id,
      metadata: { from: r.payment_status, to: 'paid', amountPaidCents: r.amount_paid_cents },
    })
  }

  if (commit) {
    const resolved = await query<{ id: string }>(
      `update review_items set status = 'resolved', resolved_at = now(),
              resolution = '{"action":"accepted_as_paid"}'::jsonb
        where status = 'open' and kind = 'amount_mismatch'
        returning id`,
    )
    console.log(`\n${rows.length} accepted and locked. ${resolved.length} review items closed.`)
  } else {
    console.log(`\nDRY RUN — ${rows.length} would be accepted. Re-run with --commit.`)
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
