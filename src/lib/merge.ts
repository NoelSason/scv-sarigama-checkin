import { query, queryOne } from '@/lib/db'
import { logAudit } from '@/lib/households'
import type { GroupMember, HouseholdGroup } from '@/lib/duplicates'

/**
 * Folding one person's several purchases into a single pass.
 *
 * Two rules decide everything here:
 *
 *   1. The survivor is the row that has already been emailed. A guest holding a
 *      QR code must keep it working forever, so a merge may never retire a pass
 *      token that is already in somebody's inbox. Where nothing has been sent
 *      yet, the oldest row wins, which keeps the choice deterministic.
 *   2. The absorbed row is kept and flagged, never deleted. See 0006_merge.sql —
 *      deleting it just invites the next sync to recreate it.
 *
 * Tickets and redemptions both move. Moving purchases without redemptions would
 * hand back admissions that were already eaten.
 */

export type MergePlan = {
  survivor: GroupMember
  absorbed: GroupMember[]
  basis: 'email' | 'name'
  ticketsBefore: number
  ticketsAfter: number
  /** True when a pass for this group is already in a guest's inbox. */
  alreadyEmailed: boolean
}

export function planMerge(group: HouseholdGroup): MergePlan | null {
  if (group.members.length < 2) return null
  if (group.basis === 'single') return null

  const emailed = group.members.filter((m) => m.emailedAt)
  // Ties broken by age so the same group always plans the same way. The driver
  // hands back timestamps as Date objects, so compare epoch values rather than
  // assuming either shape.
  const age = (m: GroupMember) => new Date(m.createdAt).getTime()
  const byAge = [...group.members].sort((a, b) => age(a) - age(b))
  const survivor = emailed.length > 0
    ? [...emailed].sort((a, b) => age(a) - age(b))[0]
    : byAge[0]

  const absorbed = group.members.filter((m) => m.id !== survivor.id)

  return {
    survivor,
    absorbed,
    basis: group.basis,
    ticketsBefore: survivor.ticketsPurchased,
    ticketsAfter: group.mergedTickets,
    alreadyEmailed: emailed.length > 0,
  }
}

/**
 * More than one row already emailed means two QR codes are in the wild for one
 * person. Merging still helps — but one of those codes stops carrying its own
 * admissions, so a human has to know to tell that guest.
 */
export function strandsAPass(group: HouseholdGroup): boolean {
  return group.members.filter((m) => m.emailedAt).length > 1
}

/**
 * Undo one merge.
 *
 * Used when two purchases turn out not to belong on the same pass — most often
 * because one of them was never actually paid. The absorbed row comes back with
 * its admissions, and the survivor gives them up.
 *
 * `restoreTickets: false` returns the row to life with zero admissions, which is
 * what an unpaid purchase should carry: the record exists, the pass grants
 * nothing until somebody pays at the desk.
 */
export async function unmergeHousehold(
  absorbedId: string,
  opts: { restoreTickets?: boolean; staffId?: string | null } = {},
): Promise<{ survivorId: string; ticketsReturned: number }> {
  const { restoreTickets = true, staffId = null } = opts

  const record = await queryOne<{
    survivor_id: string
    tickets_moved: number
    redeemed_moved: number
  }>(
    `select survivor_id, tickets_moved, redeemed_moved
       from household_merges where absorbed_id = $1`,
    [absorbedId],
  )
  if (!record) throw new Error(`no merge on record for household ${absorbedId}`)

  await query('begin')
  try {
    await query(
      `update households
          set tickets_purchased = greatest(tickets_purchased - $2, 0),
              tickets_redeemed  = greatest(tickets_redeemed  - $3, 0)
        where id = $1`,
      [record.survivor_id, record.tickets_moved, record.redeemed_moved],
    )

    await query(
      `update households
          set merged_into_id    = null,
              merged_at         = null,
              tickets_purchased = $2,
              tickets_redeemed  = $3
        where id = $1`,
      [
        absorbedId,
        restoreTickets ? record.tickets_moved : 0,
        restoreTickets ? record.redeemed_moved : 0,
      ],
    )

    await query(`delete from household_merges where absorbed_id = $1`, [absorbedId])
    await query('commit')
  } catch (err) {
    await query('rollback')
    throw err
  }

  await logAudit('household_unmerged', {
    actorType: staffId ? 'staff' : 'system',
    actorId: staffId,
    householdId: record.survivor_id,
    metadata: { absorbedId, ticketsReturned: record.tickets_moved, restoreTickets },
  })

  return { survivorId: record.survivor_id, ticketsReturned: record.tickets_moved }
}

export type MergeResult = {
  survivorId: string
  survivorName: string
  absorbedIds: string[]
  ticketsBefore: number
  ticketsAfter: number
}

/**
 * Apply one plan, in a single transaction.
 *
 * Redemption history is repointed rather than summed away: the desk's "who
 * scanned this and when" view has to keep working across a merge, and the
 * reversal flow needs the original rows to still exist.
 */
export async function applyMerge(
  plan: MergePlan,
  staffId: string | null = null,
): Promise<MergeResult> {
  const { survivor, absorbed } = plan

  await query('begin')
  try {
    for (const row of absorbed) {
      // Re-read inside the transaction: a webhook may have changed the counts
      // between planning and applying, and the sheet must not lose that sale.
      const current = await queryOne<{
        tickets_purchased: number
        tickets_redeemed: number
        merged_into_id: string | null
      }>(
        `select tickets_purchased, tickets_redeemed, merged_into_id
           from households where id = $1 for update`,
        [row.id],
      )
      if (!current) throw new Error(`household ${row.id} disappeared mid-merge`)
      if (current.merged_into_id) continue // already folded in by an earlier run

      await query(
        `insert into household_merges
           (survivor_id, absorbed_id, basis, tickets_moved, redeemed_moved,
            absorbed_snapshot, staff_user_id)
         values ($1,$2,$3,$4,$5,$6,$7)`,
        [
          survivor.id,
          row.id,
          plan.basis,
          current.tickets_purchased,
          current.tickets_redeemed,
          JSON.stringify(row),
          staffId,
        ],
      )

      await query(
        `update households
            set tickets_purchased = tickets_purchased + $2,
                tickets_redeemed  = tickets_redeemed  + $3
          where id = $1`,
        [survivor.id, current.tickets_purchased, current.tickets_redeemed],
      )

      // History follows the tickets, or the desk loses the audit trail.
      await query(`update redemptions set household_id = $1 where household_id = $2`, [
        survivor.id,
        row.id,
      ])
      await query(`update redemption_adjustments set household_id = $1 where household_id = $2`, [
        survivor.id,
        row.id,
      ])

      // Zeroed so that if anything ever reads this row directly it cannot issue
      // a second helping of the same admissions.
      await query(
        `update households
            set tickets_purchased = 0,
                tickets_redeemed  = 0,
                pass_enabled      = false,
                merged_into_id    = $2,
                merged_at         = now()
          where id = $1`,
        [row.id, survivor.id],
      )
    }

    // An address on any absorbed row is worth keeping if the survivor has none.
    const donorEmail = absorbed.find((a) => a.email?.trim())?.email?.trim()
    if (!survivor.email?.trim() && donorEmail) {
      await query(
        `update households
            set email = $2, normalized_email = lower(trim($2))
          where id = $1 and coalesce(trim(email), '') = ''`,
        [survivor.id, donorEmail],
      )
    }

    await query('commit')
  } catch (err) {
    await query('rollback')
    throw err
  }

  await logAudit('households_merged', {
    actorType: staffId ? 'staff' : 'system',
    actorId: staffId,
    householdId: survivor.id,
    metadata: {
      absorbed: absorbed.map((a) => a.id),
      basis: plan.basis,
      ticketsBefore: plan.ticketsBefore,
      ticketsAfter: plan.ticketsAfter,
    },
  })

  return {
    survivorId: survivor.id,
    survivorName: survivor.displayName,
    absorbedIds: absorbed.map((a) => a.id),
    ticketsBefore: plan.ticketsBefore,
    ticketsAfter: plan.ticketsAfter,
  }
}
