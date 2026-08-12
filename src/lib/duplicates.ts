import { query } from '@/lib/db'
import { normalizeName } from '@/lib/tokens'

/**
 * Identity grouping — one person, however many times they paid.
 *
 * Two households belong together on one of two grounds, and the distinction
 * matters more than the grouping itself:
 *
 *   strong — the same email address. Two Square checkouts by the same account
 *            is not a coincidence, so this is safe to act on automatically.
 *   weak   — the same name, and nothing else to corroborate it. Every Zelle row
 *            arrives without an email or phone, so name is all there is. Two
 *            families sharing a full name is unlikely, not impossible, and the
 *            cost of being wrong is folding strangers' tickets together.
 *
 * Nothing here mutates. This module answers "who looks like the same person",
 * and leaves "so merge them" to a caller that has a human's confirmation.
 */

export type MatchBasis = 'email' | 'name' | 'single'

export type GroupMember = {
  id: string
  displayName: string
  email: string | null
  ticketsPurchased: number
  ticketsRedeemed: number
  paymentStatus: string
  source: string | null
  createdAt: string
  /** Set once a pass has been emailed. The merge survivor must be one of these. */
  emailedAt: string | null
}

export type HouseholdGroup = {
  /** Stable across runs: the email, or `name:<normalized>`. */
  key: string
  basis: MatchBasis
  members: GroupMember[]
  /** The name shown to a human. Longest variant wins — it carries the most information. */
  primaryName: string
  /** Other spellings in the group, e.g. "Len Mathew P" beside "Len Mathew Painummoottil". */
  nameVariants: string[]
  /** The one address we know, if any member has one. */
  email: string | null
  ticketsByPurchase: number[]
  mergedTickets: number
  mergedRedeemed: number
}

type Row = {
  id: string
  display_name: string
  email: string | null
  normalized_email: string | null
  tickets_purchased: number
  tickets_redeemed: number
  payment_status: string
  source: string | null
  created_at: string
  emailed_at: string | null
}

/**
 * Every real household, grouped.
 *
 * Test households are excluded: they exist to be scanned at a rehearsal, and
 * folding them into a real person's group would be worse than useless.
 */
export async function loadHouseholdGroups(): Promise<HouseholdGroup[]> {
  const rows = await query<Row>(
    `select h.id, h.display_name, h.email, h.normalized_email,
            h.tickets_purchased, h.tickets_redeemed,
            h.payment_status::text as payment_status, h.source,
            h.created_at,
            (select min(d.sent_at) from email_deliveries d
              where d.household_id = h.id and d.status = 'sent') as emailed_at
       from households h
      where not h.is_test
      order by h.created_at, h.id`,
  )

  // Email first, so a group with an address is keyed by the strong signal even
  // when its members' names disagree.
  const byKey = new Map<string, { basis: MatchBasis; rows: Row[] }>()

  for (const row of rows) {
    const email = row.normalized_email?.trim() || null
    const key = email ?? `name:${normalizeName(row.display_name)}`
    const basis: MatchBasis = email ? 'email' : 'name'
    const bucket = byKey.get(key)
    if (bucket) bucket.rows.push(row)
    else byKey.set(key, { basis, rows: [row] })
  }

  const groups: HouseholdGroup[] = []
  for (const [key, { basis, rows: members }] of byKey) {
    const names = members.map((m) => m.display_name.trim()).filter(Boolean)
    // Longest name wins: "Len Mathew Painummoottil" tells a volunteer more at
    // the desk than "Len Mathew P" does.
    const primaryName =
      names.slice().sort((a, b) => b.length - a.length)[0] ?? members[0].display_name

    groups.push({
      key,
      basis: members.length > 1 ? basis : 'single',
      members: members.map((m) => ({
        id: m.id,
        displayName: m.display_name,
        email: m.email,
        ticketsPurchased: m.tickets_purchased,
        ticketsRedeemed: m.tickets_redeemed,
        paymentStatus: m.payment_status,
        source: m.source,
        createdAt: m.created_at,
        emailedAt: m.emailed_at,
      })),
      primaryName,
      nameVariants: [...new Set(names)].filter((n) => n !== primaryName),
      email: members.find((m) => m.email?.trim())?.email?.trim() ?? null,
      ticketsByPurchase: members.map((m) => m.tickets_purchased),
      mergedTickets: members.reduce((sum, m) => sum + m.tickets_purchased, 0),
      mergedRedeemed: members.reduce((sum, m) => sum + m.tickets_redeemed, 0),
    })
  }

  // Duplicates first and biggest first — the rows a human needs to act on
  // should not be buried under ninety single-purchase households.
  return groups.sort((a, b) => {
    const dup = Number(b.members.length > 1) - Number(a.members.length > 1)
    if (dup !== 0) return dup
    if (b.mergedTickets !== a.mergedTickets) return b.mergedTickets - a.mergedTickets
    return a.primaryName.localeCompare(b.primaryName)
  })
}

export function isDuplicate(group: HouseholdGroup): boolean {
  return group.members.length > 1
}
