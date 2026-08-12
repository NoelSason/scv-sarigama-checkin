/**
 * Send every guest their pass.
 *
 *   npm run send-passes                    # plan only, sends nothing
 *   npm run send-passes -- --limit 3 --commit
 *   npm run send-passes -- --commit
 *
 * Dry run is the default. A forgotten flag costs nothing; the opposite mistake
 * cannot be undone, because there is no recalling 72 emails.
 *
 * Safe to re-run. Anyone with a successful delivery on record is skipped, so a
 * run that dies halfway is fixed by running it again — not by working out who
 * got one.
 */
import { query } from '@/lib/db'
import { sendPassEmail } from '@/lib/email'
import { testRedirectTarget } from '@/lib/email/provider'
import type { Household } from '@/lib/households'

/** Resend's default is 2 requests/second. Sit well under it. */
const GAP_MS = 700

function arg(name: string): string | null {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`))
  if (hit) return hit.split('=')[1]
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] ?? null : null
}

/**
 * Refuse to send links nobody can open.
 *
 * The pass URL and the QR are both built from APP_BASE_URL, so running this
 * against a local .env.local would mail 72 people a localhost link and a
 * localhost QR code — undetectable until a guest is standing at the door.
 */
function assertPublicBaseUrl(): string {
  const base = process.env.APP_BASE_URL?.trim() ?? ''
  if (!base || /localhost|127\.0\.0\.1|0\.0\.0\.0/.test(base)) {
    throw new Error(
      `APP_BASE_URL is "${base || '(unset)'}" — every link and QR would point at your laptop.\n` +
        `Re-run with the live host, e.g.\n` +
        `  APP_BASE_URL=https://checkin.scvsarigama.com npm run send-passes -- --commit`,
    )
  }
  return base
}

type Row = Household & { already_sent: string | null }

async function main() {
  const commit = process.argv.includes('--commit')
  const limit = Number(arg('limit') ?? '0') || null
  const base = assertPublicBaseUrl()

  const redirect = testRedirectTarget()
  const from = process.env.EMAIL_FROM?.trim()

  console.log(`base url:  ${base}`)
  console.log(`from:      ${from ?? '(EMAIL_FROM unset — provider default)'}`)
  console.log(`api key:   ${process.env.RESEND_API_KEY ? 'set' : 'MISSING — nothing will send'}`)
  if (redirect) {
    console.log(`REDIRECT:  EMAIL_TEST_REDIRECT is set — everything goes to ${redirect}, no guest gets anything`)
  }
  console.log('')

  // The gate mirrors sendPassEmail() exactly, so the plan cannot promise a send
  // the sender would then refuse.
  const rows = await query<Row>(
    `select h.*,
            (select max(d.sent_at)::text from email_deliveries d
              where d.household_id = h.id and d.status = 'sent') as already_sent
       from households h
      where not h.is_test
        and h.merged_into_id is null
        and h.pass_enabled
        and h.payment_status in ('paid', 'comped')
        and coalesce(trim(h.email), '') <> ''
      order by h.tickets_purchased desc, h.display_name`,
  )

  const pending = rows.filter((r) => !r.already_sent)
  const done = rows.length - pending.length
  const batch = limit ? pending.slice(0, limit) : pending

  const skipped = await query<{ reason: string; n: number; tickets: number }>(
    `select case
              when coalesce(trim(email), '') = '' then 'no email address'
              when merged_into_id is not null      then 'merged into another pass'
              when not pass_enabled                then 'pass disabled'
              else 'payment not settled'
            end as reason,
            count(*)::int as n,
            coalesce(sum(tickets_purchased), 0)::int as tickets
       from households
      where not is_test
        and (coalesce(trim(email), '') = '' or merged_into_id is not null
             or not pass_enabled or payment_status not in ('paid', 'comped'))
      group by 1 order by 2 desc`,
  )

  console.log(`eligible:      ${rows.length}`)
  console.log(`already sent:  ${done}`)
  console.log(`to send now:   ${batch.length}${limit && pending.length > limit ? ` (of ${pending.length}, --limit ${limit})` : ''}`)
  console.log(`admissions:    ${batch.reduce((n, r) => n + r.tickets_purchased, 0)}`)
  console.log('\nnot receiving anything:')
  for (const s of skipped) console.log(`  ${String(s.n).padStart(3)}  ${s.reason}  (${s.tickets} admissions)`)
  console.log('')

  if (!commit) {
    for (const r of batch.slice(0, 10)) {
      console.log(`  would send  ${r.display_name} <${r.email}>  ${r.tickets_purchased} admissions`)
    }
    if (batch.length > 10) console.log(`  … and ${batch.length - 10} more`)
    console.log('\nDRY RUN — nothing sent. Re-run with --commit.')
    return
  }

  let sent = 0
  const failures: Array<{ name: string; email: string; error: string }> = []

  for (const [i, household] of batch.entries()) {
    const label = `[${i + 1}/${batch.length}] ${household.display_name} <${household.email}>`
    const result = await sendPassEmail(household)
    if (result.ok) {
      sent++
      console.log(`ok    ${label}  ${household.tickets_purchased} admissions`)
    } else {
      failures.push({
        name: household.display_name,
        email: household.email ?? '',
        error: `${result.reason}: ${result.error}`,
      })
      console.error(`FAIL  ${label}  ${result.reason}: ${result.error}`)
    }
    if (i < batch.length - 1) await new Promise((r) => setTimeout(r, GAP_MS))
  }

  console.log(`\n--- sent ${sent}, failed ${failures.length} ---`)
  if (failures.length) {
    for (const f of failures) console.log(`  ${f.name} <${f.email}>: ${f.error}`)
    console.log('\nRe-run the same command to retry only these — successes are not resent.')
    process.exitCode = 1
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(`\n${err instanceof Error ? err.message : err}`)
    process.exit(1)
  })
