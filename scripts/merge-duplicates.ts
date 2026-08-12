/**
 * Fold each person's separate purchases into one pass.
 *
 *   npm run merge            # plan only, writes nothing
 *   npm run merge -- --commit
 *   npm run merge -- --commit --email-only   # only same-email groups
 *
 * Dry run is the default, so a forgotten flag costs nothing.
 */
import { loadHouseholdGroups } from '@/lib/duplicates'
import { applyMerge, planMerge, strandsAPass } from '@/lib/merge'

async function main() {
  const commit = process.argv.includes('--commit')
  const emailOnly = process.argv.includes('--email-only')

  const groups = await loadHouseholdGroups()
  const dupes = groups
    .filter((g) => g.members.length > 1)
    .filter((g) => (emailOnly ? g.basis === 'email' : true))

  if (dupes.length === 0) {
    console.log('Nothing to merge.')
    return
  }

  console.log(`${commit ? 'MERGING' : 'DRY RUN —'} ${dupes.length} groups\n`)

  let ticketsBefore = 0
  let ticketsAfter = 0
  const stranded: string[] = []

  for (const group of dupes) {
    const plan = planMerge(group)
    if (!plan) continue

    ticketsBefore += group.mergedTickets
    ticketsAfter += plan.ticketsAfter

    const basis = plan.basis === 'email' ? 'same email' : 'same name'
    console.log(
      `${group.primaryName}  (${basis})\n` +
        `   ${group.ticketsByPurchase.join(' + ')} = ${plan.ticketsAfter} admissions on one pass` +
        (plan.alreadyEmailed ? '  [keeping the already-emailed pass]' : ''),
    )

    if (strandsAPass(group)) {
      // Two codes already in the wild for one person. Merging is still right,
      // but somebody has to tell that guest which one to bring.
      stranded.push(group.primaryName)
      console.log('   WARNING: more than one pass already emailed — one code will stop counting')
    }

    if (commit) {
      const result = await applyMerge(plan)
      console.log(`   merged -> ${result.survivorId}`)
    }
    console.log('')
  }

  console.log('---')
  console.log(`admissions before: ${ticketsBefore}   after: ${ticketsAfter}`)
  if (ticketsBefore !== ticketsAfter) {
    console.error('TICKET TOTAL CHANGED — this is a bug. Nothing should be created or lost.')
    process.exitCode = 1
  }
  if (stranded.length) {
    console.log(`\nTell these guests to use their newest email: ${stranded.join(', ')}`)
  }
  if (!commit) console.log('\nNothing written. Re-run with --commit to apply.')
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
