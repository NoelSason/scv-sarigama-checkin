/**
 * Google Sheets importer CLI.
 *
 *   npm run import:sheet                              # dry run against the live sheet
 *   npm run import:sheet -- --commit                  # write
 *   npm run import:sheet -- --csv export.csv          # no Google credentials needed
 *
 * Or directly (the --tsconfig flag is required — see tsconfig.scripts.json):
 *   npx dotenv -e .env.local -- npx tsx --tsconfig tsconfig.scripts.json \
 *     scripts/import-sheet.ts
 *
 * Dry run is the default and there is no way to commit by accident: --commit
 * must be typed. Every run writes out-import/sheet-preview.csv, which is the
 * artifact an organizer actually reads before approving the import.
 *
 * Flags:
 *   --commit            write to the database (default: dry run)
 *   --dry-run           explicit no-op default
 *   --csv <path>        parse a local CSV export instead of calling Google
 *   --sheet-id <id>     override GOOGLE_SHEET_ID
 *   --tab <name>        override GOOGLE_SHEET_TAB
 *   --out <path>        override out-import/sheet-preview.csv
 *   --parse-only        never touch the database, even to plan
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  SheetSchemaError,
  SheetsCredentialError,
  fetchSheetValues,
  parseCsv,
  parseSheetRows,
  toCsv,
  type ParseResult,
} from '../src/lib/sheets'
import type { SyncItem, SyncSummary } from '../src/lib/sheet-sync'

type Args = {
  commit: boolean
  csv: string | null
  sheetId: string | undefined
  tab: string | undefined
  out: string
  parseOnly: boolean
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    commit: false,
    csv: null,
    sheetId: undefined,
    tab: undefined,
    out: join(process.cwd(), 'out-import', 'sheet-preview.csv'),
    parseOnly: false,
  }

  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]
    const next = () => {
      const value = argv[++i]
      if (!value) throw new Error(`${flag} requires a value`)
      return value
    }
    switch (flag) {
      case '--commit':
        args.commit = true
        break
      case '--dry-run':
        args.commit = false
        break
      case '--parse-only':
        args.parseOnly = true
        break
      case '--csv':
        args.csv = next()
        break
      case '--sheet-id':
        args.sheetId = next()
        break
      case '--tab':
        args.tab = next()
        break
      case '--out':
        args.out = next()
        break
      case '--help':
      case '-h':
        console.log(readFileSync(new URL(import.meta.url), 'utf8').split('*/')[0])
        process.exit(0)
        break
      default:
        throw new Error(`Unknown flag: ${flag}`)
    }
  }

  return args
}

const PREVIEW_HEADER = [
  'action',
  'sheet_row',
  'name',
  'people',
  'admissions',
  'amount',
  'expected_at_25',
  'expected_at_30',
  'payment_status',
  'pass_enabled',
  'diagnostics',
  'reason',
  'changes',
  'fingerprint',
  'household_id',
]

function previewFromSync(summary: SyncSummary): Array<Array<string | number | null>> {
  return summary.items.map((item: SyncItem) => [
    item.action,
    item.sheetRow,
    item.displayName,
    item.people,
    item.admissions,
    money(item.amountCents),
    item.people === null ? '' : money(item.people * 2500),
    item.people === null ? '' : money(item.people * 3000),
    item.paymentStatus,
    item.passEnabled === null ? '' : String(item.passEnabled),
    item.diagnostics.join(' '),
    item.reason,
    item.changes.join(' '),
    item.fingerprint,
    item.householdId,
  ])
}

/** Used when there is no database to plan against — parse results only. */
function previewFromParse(parsed: ParseResult): Array<Array<string | number | null>> {
  const rows = parsed.rows.map((row) => [
    'import',
    row.sheetRow,
    row.displayName,
    row.people,
    row.admissions,
    money(row.amountCents),
    row.people === null ? '' : money(row.people * 2500),
    row.people === null ? '' : money(row.people * 3000),
    row.paymentStatus,
    String(row.passEnabled),
    row.diagnostics.join(' '),
    '',
    '',
    row.fingerprint,
    '',
  ])

  const skipped = parsed.skipped
    .filter((s) => s.reason !== 'empty_row')
    .map((s) => [
      'skip',
      s.sheetRow,
      s.displayName,
      '',
      0,
      '',
      '',
      '',
      '',
      '',
      '',
      s.reason,
      '',
      s.fingerprint,
      '',
    ])

  return [...rows, ...skipped]
}

function money(cents: number | null): string {
  return cents === null ? '' : (cents / 100).toFixed(2)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  // ---- load values -------------------------------------------------------
  let values: string[][]
  if (args.csv) {
    values = parseCsv(readFileSync(args.csv, 'utf8'))
    console.log(`Read ${values.length} rows from ${args.csv}`)
  } else {
    values = await fetchSheetValues({ sheetId: args.sheetId, tab: args.tab })
    console.log(`Read ${values.length} rows from Google Sheets`)
  }

  const parsed = parseSheetRows(values)

  console.log('')
  console.log('Parse')
  console.log(`  data rows           ${parsed.stats.dataRows}`)
  console.log(`  zelle → import      ${parsed.stats.imported}`)
  console.log(`    clean             ${parsed.stats.clean}`)
  console.log(`    needs review      ${parsed.stats.needsReview}`)
  console.log(`  admissions          ${parsed.stats.admissions}`)
  console.log(`  skipped credit card ${parsed.stats.skippedCreditCard}`)
  console.log(`  skipped other mode  ${parsed.stats.skippedOther}`)
  console.log(`  skipped total row   ${parsed.stats.skippedTotal}`)

  // ---- plan / commit -----------------------------------------------------
  const canUseDb = Boolean(process.env.DATABASE_URL) && !args.parseOnly

  let preview: Array<Array<string | number | null>>

  if (!canUseDb) {
    if (args.commit) {
      console.error('\nRefusing to --commit: DATABASE_URL is not set.')
      process.exit(1)
    }
    console.log('\nNo DATABASE_URL — parse-only preview. Nothing was compared or written.')
    preview = previewFromParse(parsed)
  } else {
    // Imported lazily so the CSV/parse-only path never needs a database.
    const { syncSheet } = await import('../src/lib/sheet-sync')
    const summary = await syncSheet({
      commit: args.commit,
      values,
      note: args.csv ? `CLI import from ${args.csv}` : 'CLI import from Google Sheets',
    })

    console.log('')
    console.log(args.commit ? 'Committed' : 'Plan (dry run — nothing written)')
    console.log(`  create              ${summary.counts.create}`)
    console.log(`  update              ${summary.counts.update}`)
    console.log(`  unchanged           ${summary.counts.unchanged}`)
    console.log(`  needs human review  ${summary.counts.review}`)
    console.log(`  skipped             ${summary.counts.skip}`)
    console.log(`  review items        ${summary.reviewsOpened}`)

    preview = previewFromSync(summary)
  }

  mkdirSync(dirname(args.out), { recursive: true })
  writeFileSync(args.out, `${toCsv([PREVIEW_HEADER, ...preview])}\n`, 'utf8')
  console.log(`\nWrote ${args.out}`)

  if (!args.commit) {
    console.log('Dry run. Re-run with --commit to write.')
  }
}

main().catch((err) => {
  if (err instanceof SheetsCredentialError || err instanceof SheetSchemaError) {
    console.error(`\n${err.message}\n`)
    process.exit(1)
  }
  console.error(err)
  process.exit(1)
})
