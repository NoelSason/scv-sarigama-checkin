import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { query } from '@/lib/db'
import { loadHouseholdGroups } from '@/lib/duplicates'
import { logAudit } from '@/lib/households'
import { normalizeEmail } from '@/lib/tokens'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * The contacts tab: one row per person, for collecting the addresses we don't
 * have.
 *
 * A separate tab from the payments ledger, deliberately. The ledger holds Zelle
 * rows only, so most of the addresses we already know — every Square buyer —
 * have no row there to sit in. And the importer resolves ledger columns by
 * matching header substrings, so adding columns to that tab risks a new header
 * quietly capturing a field the parser needs.
 *
 * GET  hands the Apps Script the grid to write.
 * POST takes the grid back after a human has filled the blanks.
 */

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const offered = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const a = Buffer.from(offered)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

/**
 * Column order is the contract between this route and the Apps Script. Email
 * sits second because it is the one column a human is here to type.
 *
 * REF is last and holds the household ids. It is how a filled-in address finds
 * its way home: names get retyped and rows get re-sorted, so neither can be an
 * identifier.
 */
export const CONTACT_HEADERS = [
  'Name',
  'Email',
  'Tickets (merged)',
  'Purchases',
  'Paid via',
  'Status',
  'Duplicate?',
  'Also known as',
  'REF — do not edit',
] as const

const SOURCE_LABELS: Record<string, string> = {
  google_sheets: 'Zelle / sheet',
  square: 'Card / Square',
  walk_in: 'Walk-in',
  seed: 'Test',
}

function sourceLabel(sources: Array<string | null>): string {
  const labels = [...new Set(sources.map((s) => (s && SOURCE_LABELS[s]) || s || 'unknown'))]
  return labels.join(' + ')
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  const groups = await loadHouseholdGroups()

  const values: string[][] = [[...CONTACT_HEADERS]]
  for (const g of groups) {
    const duplicate = g.members.length > 1
    values.push([
      g.primaryName,
      g.email ?? '',
      String(g.mergedTickets),
      // "5 + 4" reads as two purchases at a glance; a lone "9" would not.
      g.ticketsByPurchase.join(' + '),
      sourceLabel(g.members.map((m) => m.source)),
      [...new Set(g.members.map((m) => m.paymentStatus))].join(' / '),
      duplicate ? (g.basis === 'email' ? 'Yes — same email' : 'Check — same name') : '',
      g.nameVariants.join(' / '),
      g.members.map((m) => m.id).join(','),
    ])
  }

  const duplicates = groups.filter((g) => g.members.length > 1)
  return NextResponse.json(
    {
      ok: true,
      headers: CONTACT_HEADERS,
      values,
      stats: {
        people: groups.length,
        households: groups.reduce((n, g) => n + g.members.length, 0),
        missingEmail: groups.filter((g) => !g.email).length,
        duplicateGroups: duplicates.length,
        duplicatesByEmail: duplicates.filter((g) => g.basis === 'email').length,
        duplicatesByName: duplicates.filter((g) => g.basis === 'name').length,
      },
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

const Body = z.object({
  values: z.array(z.array(z.string())).min(1).max(2000),
  commit: z.boolean().default(true),
})

type Outcome = {
  filled: number
  unchanged: number
  corrected: Array<{ name: string; from: string; to: string }>
  invalid: Array<{ name: string; offered: string }>
  unknownRefs: number
}

/**
 * Take the tab back and write the new addresses onto the households.
 *
 * The sheet wins. An earlier version refused to overwrite, on the theory that a
 * spreadsheet typo should not redirect somebody's pass — but that gets it
 * backwards in practice: the typo is what lands first, and the correction is
 * what gets rejected. `sojan.thomas@gmail.co` sat there precisely because the
 * fixed `.com` could not replace it.
 *
 * The old value goes into the audit log on every change, so a wrong overwrite is
 * always recoverable.
 */
export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  let body: z.infer<typeof Body>
  try {
    body = Body.parse(await req.json())
  } catch (err) {
    return NextResponse.json(
      { error: 'INVALID', detail: err instanceof z.ZodError ? err.issues : undefined },
      { status: 400 },
    )
  }

  const header = body.values[0] ?? []
  const emailCol = header.findIndex((h) => h.trim().toLowerCase() === 'email')
  const refCol = header.findIndex((h) => h.trim().toUpperCase().startsWith('REF'))
  const nameCol = header.findIndex((h) => h.trim().toLowerCase() === 'name')
  if (emailCol === -1 || refCol === -1) {
    return NextResponse.json(
      { error: 'BAD_LAYOUT', detail: 'Expected "Email" and "REF" columns in the header row.' },
      { status: 400 },
    )
  }

  const outcome: Outcome = { filled: 0, unchanged: 0, corrected: [], invalid: [], unknownRefs: 0 }

  for (let i = 1; i < body.values.length; i++) {
    const row = body.values[i] ?? []
    const refs = (row[refCol] ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    if (refs.length === 0) continue

    const raw = (row[emailCol] ?? '').trim()
    if (!raw) continue

    const name = (row[nameCol] ?? '').trim() || '(unnamed)'
    const email = normalizeEmail(raw)
    if (!email) {
      outcome.invalid.push({ name, offered: raw })
      continue
    }

    for (const id of refs) {
      // Follow a merge. A tab printed before the merge still carries the
      // absorbed row's id, and an address written there would land on a row
      // nothing reads — the guest would look like they still had no email.
      const existing = await query<{ id: string; email: string | null; display_name: string }>(
        `select coalesce(s.id, h.id)       as id,
                coalesce(s.email, h.email) as email,
                coalesce(s.display_name, h.display_name) as display_name
           from households h
           left join households s on s.id = h.merged_into_id
          where h.id = $1 and not h.is_test`,
        [id],
      )
      if (existing.length === 0) {
        outcome.unknownRefs++
        continue
      }

      const current = existing[0].email?.trim() ?? null
      if (current && normalizeEmail(current) === email) {
        outcome.unchanged++
        continue
      }
      if (current) {
        outcome.corrected.push({ name: existing[0].display_name, from: current, to: raw.trim() })
      }

      // The RESOLVED id, not the one from the sheet: after a merge those differ,
      // and writing to the absorbed row would silently do nothing useful.
      const target = existing[0].id
      if (body.commit) {
        await query(
          `update households set email = $2, normalized_email = $3 where id = $1`,
          [target, raw.trim(), email],
        )
        await logAudit('contact_email_filled', {
          actorType: 'import',
          householdId: target,
          // previous value recorded so an unwanted overwrite can be undone
          metadata: { email: raw.trim(), previous: current, via: 'contacts tab', sheetRef: id },
        })
      }
      if (!current) outcome.filled++
    }
  }

  return NextResponse.json(
    { ok: true, commit: body.commit, ...outcome },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
