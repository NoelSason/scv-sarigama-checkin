/**
 * Demo/test households.
 *
 * Every row is is_test = true and prefixed "TEST —", so it is impossible to
 * mistake one for a real guest, and `--purge` clears them all in one go
 * without any chance of touching real data.
 *
 *   npm run seed          # create the four demo households
 *   npm run seed -- --purge
 */
import { query } from '@/lib/db'
import { generatePassToken } from '@/lib/tokens'

const FIXTURES = [
  { name: 'TEST — Family A', purchased: 5, redeemed: 0, status: 'paid', under6: 0 },
  { name: 'TEST — Family B', purchased: 2, redeemed: 1, status: 'paid', under6: 2 },
  { name: 'TEST — Family C', purchased: 3, redeemed: 0, status: 'unpaid', under6: 0 },
  { name: 'TEST — Family D', purchased: 5, redeemed: 5, status: 'paid', under6: 0 },
] as const

async function purge() {
  // Order matters: child rows first, and only ever where is_test.
  for (const table of [
    'audit_logs',
    'redemption_adjustments',
    'redemptions',
    'email_deliveries',
    'review_items',
  ]) {
    await query(
      `delete from ${table} where household_id in (select id from households where is_test)`,
    )
  }
  const gone = await query('delete from households where is_test returning id')
  console.log(`Purged ${gone.length} test household(s).`)
}

async function seed() {
  await purge()

  for (const f of FIXTURES) {
    const [row] = await query<{ id: string; pass_token: string }>(
      `insert into households
         (display_name, tickets_purchased, tickets_redeemed, children_under_6,
          payment_status, payment_method, amount_paid_cents, pass_token,
          source, is_test, notes)
       values ($1,$2,$3,$4,$5::payment_status,'cash',$6,$7,'seed',true,
               'Seeded demo data. Safe to delete.')
       returning id, pass_token`,
      [
        f.name,
        f.purchased,
        f.redeemed,
        f.under6,
        f.status,
        f.purchased * 3000,
        generatePassToken(),
      ],
    )

    // Family B has one admission already used; give it a matching redemption
    // row so the history view and reversal flow have something real to show.
    if (f.redeemed > 0) {
      await query(
        `insert into redemptions (household_id, quantity, device_name, metadata)
         values ($1, $2, 'seed', '{"seeded": true}'::jsonb)`,
        [row.id, f.redeemed],
      )
    }

    const base = process.env.APP_BASE_URL?.replace(/\/$/, '') ?? 'http://localhost:3000'
    console.log(
      `${f.name.padEnd(22)} ${f.purchased - f.redeemed}/${f.purchased} left  ${base}/p/${row.pass_token}`,
    )
  }
}

const arg = process.argv[2]
const run = arg === '--purge' ? purge : seed

run()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
