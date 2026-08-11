import { normalizeName, sha256 } from './tokens'

/**
 * Google Sheets ingestion for the Zelle ledger.
 *
 * This file is deliberately split in two:
 *
 *   parseSheetRows()   — PURE. No network, no database, no env. Everything
 *                        that decides how many admissions a guest gets lives
 *                        here so it can be tested exhaustively.
 *   fetchSheetValues() — the only part that touches Google, and only ever
 *                        read-only. The sheet is the organizers' working
 *                        document; we never write to it.
 *
 * The sheet's data hazards drive most of what follows:
 *   1. Timestamps were drag-filled from last year's template — dozens of rows
 *      share `8/27/2024 21:07:32`. Timestamp is neither an identifier nor an
 *      ordering key, so it is read for display only.
 *   2. Repeated purchaser names are real (one family bought three times).
 *      Name is not a key.
 *   3. Amount does not imply ticket count — several rows fold a donation into
 *      the payment. `No Of People` is the sole authority.
 *   4. Rows get re-sorted, so row number is not stable either.
 */

// Ticket price changed from $25 to $30 on Aug 7. The broken timestamps make it
// impossible to tell which applied to a given row, so a payment matching
// EITHER price is considered consistent.
export const TICKET_PRICES_CENTS = [2500, 3000] as const

export const SHEETS_SOURCE = 'google_sheets'

/**
 * Appears in the Payment Mode of any row this app wrote back, e.g. "Cash (app)".
 * Both sides of the round trip read this constant, so the marker cannot drift
 * apart and start re-importing our own walk-ins.
 */
export const CHECKIN_APP_MARKER = '(app)'
export const SHEETS_READONLY_SCOPE = 'https://www.googleapis.com/auth/spreadsheets.readonly'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RowDiagnostic =
  | 'missing_name'
  | 'missing_people'
  | 'unparseable_people'
  | 'zero_people'
  | 'missing_amount'
  | 'unparseable_amount'
  | 'amount_mismatch'

export type SkipReason =
  | 'empty_row'
  | 'total_row'
  | 'header_repeat'
  | 'credit_card'
  | 'other_payment_mode'
  | 'missing_payment_mode'
  /** A walk-in this app created and wrote back to the sheet. Already a
      household — importing it would issue the same family a second pass. */
  | 'from_checkin_app'

export type SheetField =
  | 'timestamp'
  | 'name'
  | 'amount'
  | 'people'
  | 'mode'
  | 'prepay'
  | 'bands'
  | 'performing'
  | 'performerType'
  | 'performanceDetails'

type RowBase = {
  /** 1-based position in the sheet, for humans only. NOT stable across sorts. */
  sheetRow: number
  raw: Partial<Record<SheetField, string>>
  rawValues: string[]
}

export type ParsedRow = RowBase & {
  displayName: string
  normalizedName: string
  amountCents: number | null
  people: number | null
  paymentMode: string

  occurrenceIndex: number
  fingerprint: string

  /** What tickets_purchased must be set to. Never inferred from the amount. */
  admissions: number
  paymentStatus: 'paid' | 'needs_review'
  passEnabled: boolean
  /**
   * True when the row is too broken to issue admissions from (no name, no
   * usable head count). Distinct from a mere amount mismatch, where the guest
   * genuinely paid and must still get through the door.
   */
  blocking: boolean
  diagnostics: RowDiagnostic[]
}

export type SkippedRow = RowBase & {
  reason: SkipReason
  paymentMode: string
  displayName: string
  /** Null for rows carrying no identity at all (blank rows, the total row). */
  fingerprint: string | null
  /** A skip we cannot explain away — an organizer should look at it. */
  needsReview: boolean
}

export type ParseStats = {
  dataRows: number
  imported: number
  clean: number
  needsReview: number
  admissions: number
  skippedCreditCard: number
  skippedOther: number
  skippedTotal: number
  skippedEmpty: number
}

export type ParseResult = {
  headers: string[]
  columns: Partial<Record<SheetField, number>>
  rows: ParsedRow[]
  skipped: SkippedRow[]
  stats: ParseStats
}

export class SheetSchemaError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SheetSchemaError'
  }
}

export class SheetsCredentialError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SheetsCredentialError'
  }
}

// ---------------------------------------------------------------------------
// Column resolution
// ---------------------------------------------------------------------------

const REQUIRED_FIELDS: SheetField[] = ['name', 'amount', 'people', 'mode']

/**
 * Matched on normalized headers rather than exact strings: organizers rename
 * form questions, and an import that dies on "Your Name " with a trailing
 * space the week of the event is worse than one that guesses sensibly.
 * First match wins, so order matters.
 */
const COLUMN_MATCHERS: Array<[SheetField, (h: string) => boolean]> = [
  ['timestamp', (h) => h.includes('timestamp')],
  ['amount', (h) => h.includes('amount')],
  ['people', (h) => h.includes('people') || h.includes('noof')],
  ['mode', (h) => h.includes('paymentmode') || h.includes('payment')],
  ['prepay', (h) => h.includes('prepay')],
  ['bands', (h) => h.includes('band')],
  ['performerType', (h) => h.includes('individual') || h.includes('group')],
  ['performanceDetails', (h) => h.includes('details')],
  ['performing', (h) => h.includes('perform')],
  ['name', (h) => h.includes('name')],
]

function normalizeHeader(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, '')
}

function resolveColumns(headers: string[]): Partial<Record<SheetField, number>> {
  const columns: Partial<Record<SheetField, number>> = {}
  headers.forEach((header, index) => {
    const h = normalizeHeader(header)
    if (!h) return
    for (const [field, matches] of COLUMN_MATCHERS) {
      if (columns[field] === undefined && matches(h)) {
        columns[field] = index
        return
      }
    }
  })
  return columns
}

// ---------------------------------------------------------------------------
// Cell parsing
// ---------------------------------------------------------------------------

function cell(values: string[], index: number | undefined): string {
  if (index === undefined) return ''
  return (values[index] ?? '').toString().trim()
}

type NumberParse = { value: number | null; state: 'ok' | 'missing' | 'unparseable' }

/** Accepts `500`, `$500`, `1,000.00`, `500.00 `. Rejects anything else. */
function parseMoneyCents(raw: string): NumberParse {
  if (!raw) return { value: null, state: 'missing' }
  const cleaned = raw.replace(/[$,\s]/g, '')
  if (!/^\d+(\.\d+)?$/.test(cleaned)) return { value: null, state: 'unparseable' }
  const amount = Number(cleaned)
  if (!Number.isFinite(amount)) return { value: null, state: 'unparseable' }
  return { value: Math.round(amount * 100), state: 'ok' }
}

/**
 * Head counts are parsed strictly. "4 adults 2 kids" is a human note, not a
 * number, and guessing at it would issue the wrong number of meals.
 */
function parseCount(raw: string): NumberParse {
  if (!raw) return { value: null, state: 'missing' }
  const cleaned = raw.replace(/[,\s]/g, '')
  if (!/^\d+(\.0+)?$/.test(cleaned)) return { value: null, state: 'unparseable' }
  return { value: Math.trunc(Number(cleaned)), state: 'ok' }
}

const TOTAL_ROW = /^(grand\s*)?totals?$/i

function isTotalRow(values: string[], columns: Partial<Record<SheetField, number>>): boolean {
  // The ledger's footer reads `Total | 8970 | 282`. Depending on which cell the
  // organizer typed it into it lands in the timestamp or the name column.
  const candidates = [cell(values, columns.timestamp), cell(values, columns.name), values[0] ?? '']
  return candidates.some((v) => TOTAL_ROW.test(v.trim()))
}

/** Only `Zelle` is ours. Credit Card rows are issued from the Square API. */
function classifyPaymentMode(mode: string): 'zelle' | SkipReason {
  // Tested against the RAW value, not the normalized one: normalizeHeader
  // strips punctuation, so "(app)" would survive only as "app" and could then
  // match an unrelated mode by accident.
  if (mode.toLowerCase().includes(CHECKIN_APP_MARKER)) return 'from_checkin_app'

  const m = normalizeHeader(mode)
  if (!m) return 'missing_payment_mode'
  if (m === 'zelle') return 'zelle'
  if (m.includes('credit') || m.includes('card') || m.includes('square')) return 'credit_card'
  return 'other_payment_mode'
}

// ---------------------------------------------------------------------------
// Fingerprinting
// ---------------------------------------------------------------------------

/**
 * The sheet has no stable row id: timestamps are duplicated, names repeat
 * legitimately, and rows get re-sorted. So identity is the content itself,
 * plus an occurrence index that separates genuinely identical rows.
 *
 * The index is assigned within a group of byte-identical rows, so it does not
 * depend on the order the rows arrive in — re-sorting the sheet produces the
 * same set of fingerprints.
 */
export function rowFingerprint(
  normalizedName: string,
  amountCents: number | null,
  people: number | null,
  occurrenceIndex: number,
): string {
  return sha256(
    [normalizedName, amountCents ?? '', people ?? '', occurrenceIndex].join('|'),
  )
}

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

export function amountMatchesTickets(amountCents: number | null, people: number | null): boolean {
  if (amountCents === null || people === null || people <= 0) return false
  return TICKET_PRICES_CENTS.some((price) => price * people === amountCents)
}

/**
 * Turn raw sheet values into typed records with per-row diagnostics.
 *
 * Pure: same input always yields the same output, including fingerprints.
 * `rows[0]` is expected to be the header; a title row above it is tolerated.
 */
export function parseSheetRows(rows: string[][]): ParseResult {
  const headerIndex = findHeaderRow(rows)
  if (headerIndex === -1) {
    throw new SheetSchemaError(
      `Could not find a header row containing ${REQUIRED_FIELDS.join(', ')}. ` +
        'The sheet layout has changed — re-check the tab name before importing.',
    )
  }

  const headers = (rows[headerIndex] ?? []).map((h) => (h ?? '').toString())
  const columns = resolveColumns(headers)

  const parsed: ParsedRow[] = []
  const skipped: SkippedRow[] = []
  const occurrences = new Map<string, number>()

  for (let i = headerIndex + 1; i < rows.length; i++) {
    const values = (rows[i] ?? []).map((v) => (v ?? '').toString())
    const sheetRow = i + 1

    const raw: Partial<Record<SheetField, string>> = {}
    for (const [field, index] of Object.entries(columns) as Array<[SheetField, number]>) {
      raw[field] = cell(values, index)
    }

    const base: RowBase = { sheetRow, raw, rawValues: values }
    const displayName = cell(values, columns.name)
    const paymentMode = cell(values, columns.mode)

    // "Empty" means carrying no identity, not literally every cell blank.
    // The real sheet's trailing rows hold a drag-filled timestamp and default
    // checkboxes (Pre-pay TRUE, Bands FALSE, performing No) with no name,
    // amount, head count, or payment mode. Requiring every cell to be blank
    // sent ten of those to the review queue as if money were unaccounted for,
    // which buries the flags that actually matter.
    const carriesIdentity =
      displayName !== '' ||
      paymentMode !== '' ||
      cell(values, columns.amount) !== '' ||
      cell(values, columns.people) !== ''

    if (!carriesIdentity) {
      skipped.push({ ...base, reason: 'empty_row', paymentMode, displayName, fingerprint: null, needsReview: false })
      continue
    }

    if (isTotalRow(values, columns)) {
      // `Total | 8970 | 282` would otherwise import as a 282-admission
      // household. Excluding it is the single most important skip here.
      skipped.push({ ...base, reason: 'total_row', paymentMode, displayName, fingerprint: null, needsReview: false })
      continue
    }

    if (isRepeatedHeader(values, headers)) {
      skipped.push({ ...base, reason: 'header_repeat', paymentMode, displayName, fingerprint: null, needsReview: false })
      continue
    }

    const amount = parseMoneyCents(cell(values, columns.amount))
    const count = parseCount(cell(values, columns.people))
    const normalizedName = displayName ? normalizeName(displayName) : ''

    // Fingerprint every candidate row, including ones we skip, so the sync can
    // key a review item on a Zelle row it refused to import.
    const groupKey = [normalizedName, amount.value ?? '', count.value ?? '', normalizeHeader(paymentMode)].join('|')
    const occurrenceIndex = occurrences.get(groupKey) ?? 0
    occurrences.set(groupKey, occurrenceIndex + 1)
    const fingerprint = rowFingerprint(normalizedName, amount.value, count.value, occurrenceIndex)

    const mode = classifyPaymentMode(paymentMode)
    if (mode !== 'zelle') {
      skipped.push({
        ...base,
        reason: mode,
        paymentMode,
        displayName,
        fingerprint,
        // A Credit Card row is expected here — Square owns it, and so is a row
        // this app wrote back. A blank or unrecognised mode is money we cannot
        // attribute to either importer, so a human should look at it.
        needsReview: mode !== 'credit_card' && mode !== 'from_checkin_app',
      })
      continue
    }

    const diagnostics: RowDiagnostic[] = []
    if (!displayName) diagnostics.push('missing_name')
    if (count.state === 'missing') diagnostics.push('missing_people')
    if (count.state === 'unparseable') diagnostics.push('unparseable_people')
    if (count.state === 'ok' && count.value === 0) diagnostics.push('zero_people')
    if (amount.state === 'missing') diagnostics.push('missing_amount')
    if (amount.state === 'unparseable') diagnostics.push('unparseable_amount')

    const blocking =
      !displayName || count.state !== 'ok' || count.value === null || count.value === 0

    // The amount is a cross-check and nothing more. `Malabar Gold / 500 / 2`
    // is a $450 donation plus two meals — it gets 2 admissions and a flag,
    // never 16 or 20.
    if (!blocking && amount.state === 'ok' && !amountMatchesTickets(amount.value, count.value)) {
      diagnostics.push('amount_mismatch')
    }

    parsed.push({
      ...base,
      displayName,
      normalizedName,
      amountCents: amount.value,
      people: count.value,
      paymentMode,
      occurrenceIndex,
      fingerprint,
      // Blocking rows import as a zero-admission placeholder: the payment is
      // on record, but nobody guesses a head count on the guest's behalf.
      admissions: blocking ? 0 : (count.value as number),
      paymentStatus: diagnostics.length > 0 ? 'needs_review' : 'paid',
      // An amount mismatch still lets the guest in — they paid. Only a row we
      // cannot read at all gets its pass withheld.
      passEnabled: !blocking,
      blocking,
      diagnostics,
    })
  }

  return {
    headers,
    columns,
    rows: parsed,
    skipped,
    stats: {
      dataRows: parsed.length + skipped.filter((s) => s.reason !== 'empty_row').length,
      imported: parsed.length,
      clean: parsed.filter((r) => r.diagnostics.length === 0).length,
      needsReview: parsed.filter((r) => r.diagnostics.length > 0).length,
      admissions: parsed.reduce((sum, r) => sum + r.admissions, 0),
      skippedCreditCard: skipped.filter((s) => s.reason === 'credit_card').length,
      skippedOther: skipped.filter(
        (s) => s.reason === 'other_payment_mode' || s.reason === 'missing_payment_mode',
      ).length,
      skippedTotal: skipped.filter((s) => s.reason === 'total_row').length,
      skippedEmpty: skipped.filter((s) => s.reason === 'empty_row').length,
    },
  }
}

/** Tolerates a title/blank row above the real header. */
function findHeaderRow(rows: string[][]): number {
  const limit = Math.min(rows.length, 5)
  for (let i = 0; i < limit; i++) {
    const headers = (rows[i] ?? []).map((h) => (h ?? '').toString())
    const columns = resolveColumns(headers)
    if (REQUIRED_FIELDS.every((f) => columns[f] !== undefined)) return i
  }
  return -1
}

function isRepeatedHeader(values: string[], headers: string[]): boolean {
  const a = values.map(normalizeHeader).filter(Boolean).join('|')
  const b = headers.map(normalizeHeader).filter(Boolean).join('|')
  return a.length > 0 && a === b
}

// ---------------------------------------------------------------------------
// CSV — lets the parser run against a local export with no credentials
// ---------------------------------------------------------------------------

/** Minimal RFC 4180 reader: quoted fields, embedded commas, doubled quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  const input = text.replace(/^﻿/, '')

  for (let i = 0; i < input.length; i++) {
    const ch = input[i]

    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          field += '"'
          i++
        } else {
          quoted = false
        }
      } else {
        field += ch
      }
      continue
    }

    if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && input[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }

  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }

  return rows
}

export function toCsv(rows: Array<Array<string | number | null | undefined>>): string {
  return rows
    .map((row) =>
      row
        .map((value) => {
          const s = value === null || value === undefined ? '' : String(value)
          return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
        })
        .join(','),
    )
    .join('\n')
}

// ---------------------------------------------------------------------------
// Google Sheets client — read-only, always
// ---------------------------------------------------------------------------

type ServiceAccount = { client_email: string; private_key: string }

const CREDENTIAL_HELP = [
  'GOOGLE_SERVICE_ACCOUNT_JSON_B64 is not set.',
  '',
  'To enable the live sheet read:',
  '  1. Create a Google Cloud service account and enable the Sheets API.',
  '  2. Download its JSON key.',
  `  3. Share the sheet with the service account's email as *Viewer*.`,
  '  4. base64 -i key.json | tr -d "\\n"  →  GOOGLE_SERVICE_ACCOUNT_JSON_B64',
  '',
  'Until then, run the importer against a local CSV export:',
  '  npx tsx scripts/import-sheet.ts --csv path/to/export.csv',
].join('\n')

export function hasSheetsCredentials(): boolean {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64)
}

function serviceAccount(): ServiceAccount {
  const encoded = process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64
  if (!encoded) throw new SheetsCredentialError(CREDENTIAL_HELP)

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
  } catch {
    throw new SheetsCredentialError(
      'GOOGLE_SERVICE_ACCOUNT_JSON_B64 is not valid base64-encoded JSON. ' +
        'Re-encode the key file with: base64 -i key.json | tr -d "\\n"',
    )
  }

  const account = parsed as Partial<ServiceAccount>
  if (!account.client_email || !account.private_key) {
    throw new SheetsCredentialError(
      'Service account JSON is missing client_email or private_key.',
    )
  }

  return {
    client_email: account.client_email,
    // Some secret stores round-trip the key with literal \n sequences.
    private_key: account.private_key.replace(/\\n/g, '\n'),
  }
}

/** A1 notation needs single quotes around tab names containing spaces. */
function quoteTab(tab: string): string {
  return `'${tab.replace(/'/g, "''")}'`
}

export function sheetConfig(overrides: { sheetId?: string; tab?: string } = {}) {
  const sheetId = overrides.sheetId ?? process.env.GOOGLE_SHEET_ID
  const tab = overrides.tab ?? process.env.GOOGLE_SHEET_TAB ?? 'Form Responses 1'
  if (!sheetId) throw new SheetsCredentialError('GOOGLE_SHEET_ID is not set.')
  return { sheetId, tab }
}

/**
 * Read the ledger tab. Read-only scope, GET only — this function is incapable
 * of modifying the organizers' spreadsheet.
 *
 * FORMATTED_VALUE is used so cells arrive as the strings a human sees, which
 * is also exactly what a CSV export gives us. That keeps the parser's input
 * identical across both paths.
 */
export async function fetchSheetValues(
  overrides: { sheetId?: string; tab?: string } = {},
): Promise<string[][]> {
  const { sheetId, tab } = sheetConfig(overrides)
  const credentials = serviceAccount()

  // Imported lazily: googleapis is large, and the pure parser above must stay
  // loadable (in tests, in the CSV path) without pulling it in.
  const { google } = await import('googleapis')

  const auth = new google.auth.JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: [SHEETS_READONLY_SCOPE],
  })

  const sheets = google.sheets({ version: 'v4', auth })

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: sheetId,
      range: quoteTab(tab),
      majorDimension: 'ROWS',
      valueRenderOption: 'FORMATTED_VALUE',
    })
    const values = response.data.values ?? []
    return values.map((row) => (row ?? []).map((v) => (v === null || v === undefined ? '' : String(v))))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/not found|does not exist|Unable to parse range/i.test(message)) {
      throw new SheetsCredentialError(
        `Could not read tab "${tab}" of sheet ${sheetId}: ${message}\n` +
          `Confirm the tab name and that the sheet is shared with ${credentials.client_email} as Viewer.`,
      )
    }
    if (/permission|forbidden|403/i.test(message)) {
      throw new SheetsCredentialError(
        `Access denied reading sheet ${sheetId}.\n` +
          `Share it with ${credentials.client_email} as Viewer (read-only is sufficient).`,
      )
    }
    throw err
  }
}
