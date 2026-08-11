import { query, queryOne } from './db'
import { createHousehold, type PaymentStatus } from './households'
import { normalizeName } from './tokens'
import {
  SHEETS_SOURCE,
  fetchSheetValues,
  parseSheetRows,
  type ParseStats,
  type ParsedRow,
  type SkippedRow,
} from './sheets'

/**
 * Sheet → database sync.
 *
 * Two invariants govern everything here:
 *
 *   1. The sync never guesses. Anything ambiguous becomes a `review_items` row
 *      for a human. A queued review item costs an organizer thirty seconds; a
 *      duplicate household costs a family their meal at the door.
 *
 *   2. The sync never destroys. It creates, updates within guardrails, and
 *      flags. It does not delete households, does not lower a ticket count
 *      below what has already been redeemed, and does not re-enable a pass a
 *      human disabled.
 *
 * Re-runs are safe: identity is the row fingerprint, and
 * `households_source_record_uniq` turns a repeat insert into a no-op.
 */

/** Shown at the desk when a Zelle row arrived with no name on it. */
const UNNAMED_PLACEHOLDER = 'Unknown guest (Zelle)'

/**
 * Statuses a human or Square decided. The sheet does not get to overwrite
 * them — an organizer who comped a family should not have that undone by a
 * cron run.
 */
const PROTECTED_STATUSES: PaymentStatus[] = ['comped', 'refunded', 'partially_refunded']

/**
 * Trigram similarity above which two names are "close enough" to demand human
 * review before creating a second household. Deliberately loose: a false
 * positive queues a review, a false negative creates a duplicate.
 */
const NAME_MATCH_THRESHOLD = 0.45

export type SyncAction = 'create' | 'update' | 'unchanged' | 'review' | 'skip'

export type SyncItem = {
  action: SyncAction
  sheetRow: number | null
  fingerprint: string | null
  displayName: string
  amountCents: number | null
  people: number | null
  admissions: number
  paymentStatus: PaymentStatus | null
  passEnabled: boolean | null
  diagnostics: string[]
  /** Why this row was flagged or skipped. Empty for a clean create/update. */
  reason: string
  householdId: string | null
  changes: string[]
}

export type SyncCounts = Record<SyncAction, number>

export type SyncSummary = {
  dryRun: boolean
  syncRunId: string | null
  importBatchId: string | null
  parse: ParseStats
  counts: SyncCounts
  admissions: number
  reviewsOpened: number
  items: SyncItem[]
  error?: string
}

export type SyncOptions = {
  /** Default false: the safe mode is the one you get by forgetting a flag. */
  commit?: boolean
  /** Pre-loaded values (CSV export, tests). Skips the Google round trip. */
  values?: string[][]
  sheetId?: string
  tab?: string
  actorId?: string | null
  note?: string
}

type ExistingHousehold = {
  id: string
  display_name: string
  source_record_id: string
  tickets_purchased: number
  tickets_redeemed: number
  amount_paid_cents: number | null
  payment_status: PaymentStatus
  pass_enabled: boolean
}

type PendingReview = {
  kind: string
  householdId: string | null
  sourceRecordId: string | null
  summary: string
  payload: Record<string, unknown>
}

type PendingAudit = {
  action: string
  householdId: string | null
  metadata: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Name similarity — mirrors pg_trgm so desk search and sync agree on "close"
// ---------------------------------------------------------------------------

function trigrams(value: string): Set<string> {
  const padded = `  ${value} `
  const set = new Set<string>()
  for (let i = 0; i < padded.length - 2; i++) set.add(padded.slice(i, i + 3))
  return set
}

function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0
  if (a === b) return 1
  const ta = trigrams(a)
  const tb = trigrams(b)
  let shared = 0
  for (const t of ta) if (tb.has(t)) shared++
  const union = ta.size + tb.size - shared
  return union === 0 ? 0 : shared / union
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

export async function syncSheet(options: SyncOptions = {}): Promise<SyncSummary> {
  const dryRun = options.commit !== true

  const syncRunId = await startSyncRun(dryRun)

  try {
    const values = options.values ?? (await fetchSheetValues(options))
    const parsed = parseSheetRows(values)

    const existing = await query<ExistingHousehold>(
      `select id, display_name, source_record_id, tickets_purchased, tickets_redeemed,
              amount_paid_cents, payment_status, pass_enabled
         from households
        where source = $1 and source_record_id is not null`,
      [SHEETS_SOURCE],
    )

    const byFingerprint = new Map(existing.map((h) => [h.source_record_id, h]))
    const items: SyncItem[] = []
    const reviews: PendingReview[] = []
    const audits: PendingAudit[] = []

    // Every household this sheet still accounts for. Whatever is left over is
    // an edited, deleted, or moved-to-Square row — never silently dropped.
    const claimed = new Set<string>()

    // Computed up front, not accumulated during the loop: whether a household
    // is an orphan must not depend on where its row happens to sit today.
    const presentFingerprints = new Set<string>([
      ...parsed.rows.map((r) => r.fingerprint),
      ...parsed.skipped.map((s) => s.fingerprint).filter((f): f is string => f !== null),
    ])

    const importBatchId = dryRun ? null : await startImportBatch(options.note)

    for (const row of parsed.rows) {
      const match = byFingerprint.get(row.fingerprint)
      if (match) {
        claimed.add(match.id)
        items.push(
          await applyUpdate(row, match, { dryRun, importBatchId, reviews, audits }),
        )
        continue
      }

      // Fingerprint miss. Before creating anything, check whether this looks
      // like an edit of a household we already issued a pass for. Duplicate
      // purchaser names are legitimate in this sheet, so only households the
      // sheet no longer accounts for are candidates.
      const candidate = findEditCandidate(row, existing, presentFingerprints, claimed)
      if (candidate) {
        claimed.add(candidate.household.id)
        reviews.push({
          kind: 'sheet_row_changed',
          householdId: candidate.household.id,
          sourceRecordId: row.fingerprint,
          summary:
            `Sheet row for "${row.displayName || '(no name)'}" no longer matches imported ` +
            `household "${candidate.household.display_name}" — resolve as update or new household.`,
          payload: {
            sheetRow: row.sheetRow,
            newFingerprint: row.fingerprint,
            existingFingerprint: candidate.household.source_record_id,
            similarity: Number(candidate.similarity.toFixed(3)),
            sheet: {
              name: row.displayName,
              amountCents: row.amountCents,
              people: row.people,
            },
            household: {
              id: candidate.household.id,
              name: candidate.household.display_name,
              ticketsPurchased: candidate.household.tickets_purchased,
              ticketsRedeemed: candidate.household.tickets_redeemed,
              amountPaidCents: candidate.household.amount_paid_cents,
            },
          },
        })
        items.push({
          ...itemFromRow(row),
          action: 'review',
          householdId: candidate.household.id,
          reason: `possible edit of existing household "${candidate.household.display_name}"`,
          changes: [],
        })
        continue
      }

      items.push(await applyCreate(row, { dryRun, importBatchId, reviews, audits }))
    }

    // Skipped rows: Credit Card is expected (Square owns it); anything else is
    // money we could not attribute and an organizer should see it.
    for (const skip of parsed.skipped) {
      if (skip.reason === 'empty_row' || skip.reason === 'total_row' || skip.reason === 'header_repeat') {
        continue
      }

      // A row that flipped Zelle → Credit Card keeps its fingerprint, so the
      // household we already issued still exists while Square is about to
      // issue its own. That is the double-issue case; flag it loudly.
      const alreadyImported = skip.fingerprint ? byFingerprint.get(skip.fingerprint) : undefined
      if (alreadyImported) {
        claimed.add(alreadyImported.id)
        reviews.push({
          kind: 'possible_duplicate',
          householdId: alreadyImported.id,
          sourceRecordId: skip.fingerprint,
          summary:
            `Sheet row for "${skip.displayName}" is now "${skip.paymentMode}", but a Zelle ` +
            `household was already imported from it. Square may issue a second pass.`,
          payload: { sheetRow: skip.sheetRow, paymentMode: skip.paymentMode },
        })
      }

      if (skip.needsReview) {
        reviews.push({
          kind: 'missing_data',
          householdId: alreadyImported?.id ?? null,
          sourceRecordId: skip.fingerprint,
          summary:
            `Sheet row ${skip.sheetRow} ("${skip.displayName || 'no name'}") has payment mode ` +
            `"${skip.paymentMode || 'blank'}" — neither Zelle nor Credit Card, so nothing was imported.`,
          payload: { sheetRow: skip.sheetRow, paymentMode: skip.paymentMode, raw: skip.raw },
        })
      }

      items.push({
        ...itemFromSkip(skip),
        action: skip.needsReview || alreadyImported ? 'review' : 'skip',
      })
    }

    // Households the sheet stopped accounting for entirely.
    for (const household of existing) {
      if (claimed.has(household.id)) continue
      reviews.push({
        kind: 'sheet_row_changed',
        householdId: household.id,
        sourceRecordId: household.source_record_id,
        summary:
          `Imported household "${household.display_name}" has no matching sheet row anymore ` +
          `(row edited or deleted). Nothing was changed automatically.`,
        payload: {
          householdId: household.id,
          ticketsPurchased: household.tickets_purchased,
          ticketsRedeemed: household.tickets_redeemed,
        },
      })
      items.push({
        action: 'review',
        sheetRow: null,
        fingerprint: household.source_record_id,
        displayName: household.display_name,
        amountCents: household.amount_paid_cents,
        people: household.tickets_purchased,
        admissions: household.tickets_purchased,
        paymentStatus: household.payment_status,
        passEnabled: household.pass_enabled,
        diagnostics: [],
        reason: 'no matching sheet row',
        householdId: household.id,
        changes: [],
      })
    }

    if (!dryRun) {
      await flushReviews(reviews)
      await flushAudits(audits)
      if (importBatchId) await finishImportBatch(importBatchId, items)
    }

    const summary: SyncSummary = {
      dryRun,
      syncRunId,
      importBatchId,
      parse: parsed.stats,
      counts: countActions(items),
      admissions: parsed.stats.admissions,
      reviewsOpened: reviews.length,
      items,
    }

    await finishSyncRun(syncRunId, 'ok', summary)
    return summary
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await finishSyncRun(syncRunId, 'failed', null, message)
    throw err
  }
}

// ---------------------------------------------------------------------------
// Per-row application
// ---------------------------------------------------------------------------

type ApplyContext = {
  dryRun: boolean
  importBatchId: string | null
  reviews: PendingReview[]
  audits: PendingAudit[]
}

function itemFromRow(row: ParsedRow): SyncItem {
  return {
    action: 'unchanged',
    sheetRow: row.sheetRow,
    fingerprint: row.fingerprint,
    displayName: row.displayName || UNNAMED_PLACEHOLDER,
    amountCents: row.amountCents,
    people: row.people,
    admissions: row.admissions,
    paymentStatus: row.paymentStatus,
    passEnabled: row.passEnabled,
    diagnostics: row.diagnostics,
    reason: '',
    householdId: null,
    changes: [],
  }
}

function itemFromSkip(skip: SkippedRow): SyncItem {
  return {
    action: 'skip',
    sheetRow: skip.sheetRow,
    fingerprint: skip.fingerprint,
    displayName: skip.displayName,
    amountCents: null,
    people: null,
    admissions: 0,
    paymentStatus: null,
    passEnabled: null,
    diagnostics: [],
    reason: skip.reason,
    householdId: null,
    changes: [],
  }
}

function queueRowReviews(row: ParsedRow, householdId: string | null, reviews: PendingReview[]): void {
  if (row.blocking) {
    reviews.push({
      kind: 'missing_data',
      householdId,
      sourceRecordId: row.fingerprint,
      summary:
        `Sheet row ${row.sheetRow} is missing ${row.diagnostics.join(', ')} — imported with ` +
        `0 admissions and the pass disabled until someone fills in the gap.`,
      payload: { sheetRow: row.sheetRow, diagnostics: row.diagnostics, raw: row.raw },
    })
    return
  }

  if (row.diagnostics.includes('amount_mismatch')) {
    reviews.push({
      kind: 'amount_mismatch',
      householdId,
      sourceRecordId: row.fingerprint,
      summary:
        `${row.displayName} paid ${formatMoney(row.amountCents)} for ${row.people} ` +
        `— expected ${formatMoney((row.people ?? 0) * 2500)} or ${formatMoney((row.people ?? 0) * 3000)}. ` +
        `Admissions follow the head count, not the amount.`,
      payload: {
        sheetRow: row.sheetRow,
        amountCents: row.amountCents,
        people: row.people,
        admissions: row.admissions,
      },
    })
    return
  }

  if (row.diagnostics.length > 0) {
    reviews.push({
      kind: 'missing_data',
      householdId,
      sourceRecordId: row.fingerprint,
      summary: `Sheet row ${row.sheetRow} (${row.displayName}): ${row.diagnostics.join(', ')}.`,
      payload: { sheetRow: row.sheetRow, diagnostics: row.diagnostics, raw: row.raw },
    })
  }
}

async function applyCreate(row: ParsedRow, ctx: ApplyContext): Promise<SyncItem> {
  const item = itemFromRow(row)
  item.action = 'create'
  item.reason = row.diagnostics.length > 0 ? row.diagnostics.join(', ') : ''

  if (ctx.dryRun) {
    queueRowReviews(row, null, ctx.reviews)
    return item
  }

  try {
    const household = await createHousehold({
      displayName: row.displayName || UNNAMED_PLACEHOLDER,
      ticketsPurchased: row.admissions,
      paymentStatus: row.paymentStatus,
      paymentMethod: 'zelle',
      amountPaidCents: row.amountCents,
      source: SHEETS_SOURCE,
      sourceRecordId: row.fingerprint,
      notes: sheetNote(row),
      importBatchId: ctx.importBatchId,
    })

    // createHousehold always enables the pass; a row we could not read must
    // not hand out a scannable QR.
    if (!row.passEnabled) {
      await query('update households set pass_enabled = false where id = $1', [household.id])
    }

    item.householdId = household.id
    ctx.audits.push({
      action: 'sheet_household_imported',
      householdId: household.id,
      metadata: {
        sheetRow: row.sheetRow,
        fingerprint: row.fingerprint,
        admissions: row.admissions,
        amountCents: row.amountCents,
        diagnostics: row.diagnostics,
      },
    })
    queueRowReviews(row, household.id, ctx.reviews)
    return item
  } catch (err) {
    // 23505: a concurrent sync won the race. The unique index did its job —
    // fall through to an update rather than failing the whole run.
    if (!isUniqueViolation(err)) throw err
    const existing = await queryOne<ExistingHousehold>(
      `select id, display_name, source_record_id, tickets_purchased, tickets_redeemed,
              amount_paid_cents, payment_status, pass_enabled
         from households where source = $1 and source_record_id = $2`,
      [SHEETS_SOURCE, row.fingerprint],
    )
    if (!existing) throw err
    return applyUpdate(row, existing, ctx)
  }
}

async function applyUpdate(
  row: ParsedRow,
  existing: ExistingHousehold,
  ctx: ApplyContext,
): Promise<SyncItem> {
  const item = itemFromRow(row)
  item.householdId = existing.id

  const desiredName = row.displayName || UNNAMED_PLACEHOLDER
  const changes: string[] = []

  // Guardrail: tickets_purchased can never drop below what the door already
  // took. The CHECK constraint would reject it anyway; catching it here turns
  // a failed sync into a review item.
  let tickets = row.admissions
  if (tickets < existing.tickets_redeemed) {
    ctx.reviews.push({
      kind: 'sheet_row_changed',
      householdId: existing.id,
      sourceRecordId: row.fingerprint,
      summary:
        `Sheet now says ${tickets} admissions for "${desiredName}", but ${existing.tickets_redeemed} ` +
        `have already been redeemed. Ticket count left at ${existing.tickets_purchased}.`,
      payload: {
        sheetRow: row.sheetRow,
        sheetAdmissions: tickets,
        ticketsRedeemed: existing.tickets_redeemed,
      },
    })
    tickets = existing.tickets_purchased
  }

  if (desiredName !== existing.display_name) changes.push('display_name')
  if (tickets !== existing.tickets_purchased) changes.push('tickets_purchased')
  if ((row.amountCents ?? null) !== existing.amount_paid_cents) changes.push('amount_paid_cents')
  if (
    row.paymentStatus !== existing.payment_status &&
    !PROTECTED_STATUSES.includes(existing.payment_status)
  ) {
    changes.push('payment_status')
  }
  if (!row.passEnabled && existing.pass_enabled) changes.push('pass_enabled')

  item.action = changes.length === 0 ? 'unchanged' : 'update'
  item.changes = changes
  item.reason = row.diagnostics.length > 0 ? row.diagnostics.join(', ') : ''

  if (changes.length === 0) {
    // Still surface an outstanding problem so a resolved-then-reopened row
    // does not go quiet.
    queueRowReviews(row, existing.id, ctx.reviews)
    return item
  }

  if (ctx.dryRun) {
    queueRowReviews(row, existing.id, ctx.reviews)
    return item
  }

  await query(
    `update households
        set display_name      = $2,
            tickets_purchased = $3,
            amount_paid_cents = $4,
            payment_method    = 'zelle'::payment_method,
            payment_status    = case
                                  when payment_status = any($5::payment_status[])
                                    then payment_status
                                  else $6::payment_status
                                end,
            -- Only ever narrows: a pass a human switched off stays off.
            pass_enabled      = pass_enabled and $7,
            import_batch_id   = coalesce($8, import_batch_id)
      where id = $1`,
    [
      existing.id,
      desiredName,
      tickets,
      row.amountCents,
      PROTECTED_STATUSES,
      row.paymentStatus,
      row.passEnabled,
      ctx.importBatchId,
    ],
  )

  ctx.audits.push({
    action: 'sheet_household_updated',
    householdId: existing.id,
    metadata: { sheetRow: row.sheetRow, fingerprint: row.fingerprint, changes },
  })
  queueRowReviews(row, existing.id, ctx.reviews)
  return item
}

/**
 * A fingerprint miss plus a close name match means an organizer probably
 * edited the row. Only households the current sheet no longer accounts for
 * are eligible — otherwise the three legitimate Santhosh Ramankutty purchases
 * would each block the next.
 */
function findEditCandidate(
  row: ParsedRow,
  existing: ExistingHousehold[],
  presentFingerprints: Set<string>,
  claimed: Set<string>,
): { household: ExistingHousehold; similarity: number } | null {
  if (!row.normalizedName) return null

  let best: { household: ExistingHousehold; similarity: number } | null = null
  for (const household of existing) {
    if (claimed.has(household.id)) continue
    // Accounted for by some row in this very sheet, so it is not an orphan and
    // cannot be what this row is an edit of.
    if (presentFingerprints.has(household.source_record_id)) continue

    const similarity = nameSimilarity(row.normalizedName, normalizeName(household.display_name))
    if (similarity >= NAME_MATCH_THRESHOLD && (!best || similarity > best.similarity)) {
      best = { household, similarity }
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------

function sheetNote(row: ParsedRow): string {
  const parts = [`Imported from ${SHEETS_SOURCE} row ${row.sheetRow}.`]
  if (row.raw.prepay) parts.push(`Pre-pay: ${row.raw.prepay}.`)
  if (row.raw.bands) parts.push(`Bands: ${row.raw.bands}.`)
  if (row.raw.performing) parts.push(`Performing: ${row.raw.performing}.`)
  if (row.raw.performanceDetails) parts.push(`Performance: ${row.raw.performanceDetails}.`)
  return parts.join(' ')
}

function formatMoney(cents: number | null): string {
  if (cents === null) return '$—'
  return `$${(cents / 100).toFixed(2)}`
}

function countActions(items: SyncItem[]): SyncCounts {
  const counts: SyncCounts = { create: 0, update: 0, unchanged: 0, review: 0, skip: 0 }
  for (const item of items) counts[item.action]++
  return counts
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505'
}

/**
 * One multi-row insert rather than N round trips: a first import touches ~90
 * rows and the admin route has a request timeout to respect.
 *
 * `review_items_open_uniq` keeps a re-run from stacking duplicate open items;
 * the payload is refreshed so a reviewer always sees current data.
 */
async function flushReviews(reviews: PendingReview[]): Promise<void> {
  if (reviews.length === 0) return

  // De-dupe within the batch too — ON CONFLICT cannot resolve a row against
  // another row in the same statement.
  const unique = new Map<string, PendingReview>()
  for (const review of reviews) {
    unique.set(`${review.kind}|${review.sourceRecordId ?? ''}`, review)
  }

  const params: unknown[] = []
  const tuples: string[] = []
  for (const review of unique.values()) {
    const i = params.length
    tuples.push(`($${i + 1}, $${i + 2}::uuid, $${i + 3}, $${i + 4}, $${i + 5}, $${i + 6}::jsonb)`)
    params.push(
      review.kind,
      review.householdId,
      SHEETS_SOURCE,
      review.sourceRecordId,
      review.summary,
      JSON.stringify(review.payload),
    )
  }

  await query(
    `insert into review_items (kind, household_id, source, source_record_id, summary, payload)
     values ${tuples.join(', ')}
     on conflict (kind, coalesce(source, ''), coalesce(source_record_id, ''))
       where status = 'open'
     do update set summary = excluded.summary, payload = excluded.payload`,
    params,
  )
}

async function flushAudits(audits: PendingAudit[]): Promise<void> {
  if (audits.length === 0) return

  const params: unknown[] = []
  const tuples: string[] = []
  for (const audit of audits) {
    const i = params.length
    tuples.push(`('import', null, $${i + 1}, $${i + 2}::uuid, $${i + 3}::jsonb)`)
    params.push(audit.action, audit.householdId, JSON.stringify(audit.metadata))
  }

  await query(
    `insert into audit_logs (actor_type, actor_id, action, household_id, metadata)
     values ${tuples.join(', ')}`,
    params,
  )
}

async function startSyncRun(dryRun: boolean): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `insert into sync_runs (source, status, dry_run) values ($1, 'running', $2) returning id`,
    [SHEETS_SOURCE, dryRun],
  )
  return row?.id ?? null
}

async function finishSyncRun(
  id: string | null,
  status: 'ok' | 'failed',
  summary: SyncSummary | null,
  error?: string,
): Promise<void> {
  if (!id) return
  const stats = summary
    ? {
        counts: summary.counts,
        parse: summary.parse,
        reviewsOpened: summary.reviewsOpened,
        admissions: summary.admissions,
      }
    : {}
  await query(
    `update sync_runs set status = $2, stats = $3::jsonb, error = $4, finished_at = now()
      where id = $1`,
    [id, status, JSON.stringify(stats), error ?? null],
  )
}

async function startImportBatch(note?: string): Promise<string | null> {
  const row = await queryOne<{ id: string }>(
    `insert into import_batches (kind, status, note) values ($1, 'running', $2) returning id`,
    [SHEETS_SOURCE, note ?? null],
  )
  return row?.id ?? null
}

async function finishImportBatch(id: string, items: SyncItem[]): Promise<void> {
  await query(
    `update import_batches set status = 'committed', stats = $2::jsonb, finished_at = now()
      where id = $1`,
    [id, JSON.stringify(countActions(items))],
  )
}
