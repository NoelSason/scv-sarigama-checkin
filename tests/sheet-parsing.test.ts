import { describe, expect, it } from 'vitest'
import {
  SheetSchemaError,
  parseCsv,
  parseSheetRows,
  rowFingerprint,
  type ParsedRow,
} from '@/lib/sheets'

/**
 * These tests are the safety net for the one thing this import can get
 * catastrophically wrong: handing a household the wrong number of meals.
 *
 * The fixtures below are the real shapes from the 2026 ledger — duplicated
 * timestamps, repeated purchaser names, donation-inclusive payments, and a
 * footer total row.
 */

const HEADERS = [
  'Timestamp',
  'Your Name',
  'Amount Paid',
  'No Of People',
  'Payment Mode',
  'Pre-pay',
  'Bands?',
  'Are you or your family performing?',
  'Individual or Group?',
  'Details of performance',
]

// Every row carries the same drag-filled timestamp on purpose: it is what the
// real sheet looks like, and nothing in the parser may depend on it.
const STALE_TS = '8/27/2024 21:07:32'

function row(
  name: string,
  amount: string,
  people: string,
  mode = 'Zelle',
  extras: string[] = [],
): string[] {
  return [STALE_TS, name, amount, people, mode, ...extras]
}

function sheet(...rows: string[][]): string[][] {
  return [HEADERS, ...rows]
}

function byName(rows: ParsedRow[], name: string): ParsedRow[] {
  return rows.filter((r) => r.displayName === name)
}

describe('admissions come only from No Of People', () => {
  it('imports 2 admissions for a donation-inclusive $500 / 2 row', () => {
    const result = parseSheetRows(sheet(row('Malabar Gold', '500', '2')))

    expect(result.rows).toHaveLength(1)
    const parsed = result.rows[0]

    // The whole point: never 20 ($500/$25), never 16 ($500/$30).
    expect(parsed.admissions).toBe(2)
    expect(parsed.people).toBe(2)
    expect(parsed.amountCents).toBe(50_000)

    expect(parsed.paymentStatus).toBe('needs_review')
    expect(parsed.diagnostics).toContain('amount_mismatch')
    // They paid — more than enough. The pass still works at the door.
    expect(parsed.passEnabled).toBe(true)
    expect(parsed.blocking).toBe(false)
  })

  it('accepts the other donation-inclusive shapes without inflating counts', () => {
    const result = parseSheetRows(
      sheet(
        row('Georgekutty Pullappilly', '500', '1'),
        row('Deepu Mathew', '600', '4'),
      ),
    )

    expect(result.rows.map((r) => r.admissions)).toEqual([1, 4])
    expect(result.rows.every((r) => r.paymentStatus === 'needs_review')).toBe(true)
    expect(result.rows.every((r) => r.passEnabled)).toBe(true)
  })

  it('leaves a row clean when the amount matches either ticket price', () => {
    const result = parseSheetRows(
      sheet(
        row('Before Aug 7', '50', '2'), // 2 x $25
        row('After Aug 7', '60', '2'), // 2 x $30
        row('Single at 30', '30', '1'),
      ),
    )

    expect(result.rows.map((r) => r.diagnostics)).toEqual([[], [], []])
    expect(result.rows.map((r) => r.paymentStatus)).toEqual(['paid', 'paid', 'paid'])
    expect(result.stats.admissions).toBe(5)
  })

  it('parses currency formatting', () => {
    const result = parseSheetRows(sheet(row('Formatted', '$1,000.00', '4')))
    expect(result.rows[0].amountCents).toBe(100_000)
    expect(result.rows[0].admissions).toBe(4)
  })
})

describe('rows that must never be imported', () => {
  it('excludes the footer total row', () => {
    const result = parseSheetRows(
      sheet(
        row('Riju Sam', '60', '2'),
        ['', 'Total', '8970', '282', '', '', '', '', '', ''],
      ),
    )

    expect(result.rows).toHaveLength(1)
    expect(result.rows[0].displayName).toBe('Riju Sam')
    expect(result.stats.skippedTotal).toBe(1)
    expect(result.stats.admissions).toBe(2)
    // 282 admissions must not exist anywhere in the output.
    expect(result.rows.some((r) => r.admissions === 282)).toBe(false)
  })

  it('excludes a total row typed into the first column', () => {
    const result = parseSheetRows(sheet(['Total', '', '8970', '282', '', '', '', '', '', '']))
    expect(result.rows).toHaveLength(0)
    expect(result.stats.skippedTotal).toBe(1)
  })

  it('excludes Credit Card rows — Square issues those passes', () => {
    const result = parseSheetRows(
      sheet(
        row('Zelle Person', '60', '2', 'Zelle'),
        row('Card Person', '60', '2', 'Credit Card'),
      ),
    )

    expect(result.rows.map((r) => r.displayName)).toEqual(['Zelle Person'])
    expect(result.stats.skippedCreditCard).toBe(1)

    // A Credit Card row is expected, not a problem — it must not raise a flag.
    const skipped = result.skipped.find((s) => s.reason === 'credit_card')
    expect(skipped?.needsReview).toBe(false)
  })

  it('skips blank rows silently', () => {
    const result = parseSheetRows(sheet(row('Real', '60', '2'), ['', '', '', '', '']))
    expect(result.rows).toHaveLength(1)
    expect(result.stats.skippedEmpty).toBe(1)
  })

  it('flags an unrecognised payment mode instead of silently dropping it', () => {
    const result = parseSheetRows(sheet(row('Cash Person', '60', '2', 'Cash')))
    expect(result.rows).toHaveLength(0)
    const skipped = result.skipped[0]
    expect(skipped.reason).toBe('other_payment_mode')
    expect(skipped.needsReview).toBe(true)
  })

  it('flags a blank payment mode', () => {
    const result = parseSheetRows(sheet(row('No Mode', '60', '2', '')))
    expect(result.rows).toHaveLength(0)
    expect(result.skipped[0].reason).toBe('missing_payment_mode')
    expect(result.skipped[0].needsReview).toBe(true)
  })
})

describe('identity: names are not keys', () => {
  it('gives duplicate purchaser names with different amounts distinct households', () => {
    const result = parseSheetRows(
      sheet(
        row('Santhosh Ramankutty', '60', '2'),
        row('Santhosh Ramankutty', '90', '3'),
        row('Santhosh Ramankutty', '30', '1'),
      ),
    )

    const fingerprints = result.rows.map((r) => r.fingerprint)
    expect(new Set(fingerprints).size).toBe(3)
    expect(result.rows.map((r) => r.admissions)).toEqual([2, 3, 1])
    // Same person, three purchases — occurrence index is not what separates
    // them here, the content is.
    expect(result.rows.map((r) => r.occurrenceIndex)).toEqual([0, 0, 0])
  })

  it('gives two byte-identical rows distinct households via occurrenceIndex', () => {
    const result = parseSheetRows(
      sheet(row('Rini Jose', '60', '2'), row('Rini Jose', '60', '2')),
    )

    expect(result.rows).toHaveLength(2)
    expect(result.rows[0].occurrenceIndex).toBe(0)
    expect(result.rows[1].occurrenceIndex).toBe(1)
    expect(result.rows[0].fingerprint).not.toBe(result.rows[1].fingerprint)
    // Both are real purchases: four meals total, not two.
    expect(result.stats.admissions).toBe(4)
  })

  it('does not let a Credit Card row shift a Zelle row’s occurrence index', () => {
    const withCard = parseSheetRows(
      sheet(
        row('Jubil Sason', '60', '2', 'Credit Card'),
        row('Jubil Sason', '60', '2', 'Zelle'),
      ),
    )
    const withoutCard = parseSheetRows(sheet(row('Jubil Sason', '60', '2', 'Zelle')))

    expect(withCard.rows[0].fingerprint).toBe(withoutCard.rows[0].fingerprint)
  })

  it('normalizes names so punctuation and case do not fork identity', () => {
    const a = parseSheetRows(sheet(row('Len Mathew P', '60', '2')))
    const b = parseSheetRows(sheet(row('  len   mathew  p. ', '60', '2')))
    expect(a.rows[0].fingerprint).toBe(b.rows[0].fingerprint)
  })
})

describe('fingerprint stability', () => {
  const LEDGER = sheet(
    row('Santhosh Ramankutty', '60', '2'),
    row('Riju Sam', '90', '3'),
    row('Divya Manayath', '30', '1'),
    row('Malabar Gold', '500', '2'),
    row('Georgekutty Pullappilly', '500', '1'),
    row('Rini Jose', '60', '2'),
    row('Rini Jose', '60', '2'),
    row('Card Person', '60', '2', 'Credit Card'),
    ['', 'Total', '8970', '282', '', '', '', '', '', ''],
  )

  it('is identical when the same input is parsed twice', () => {
    const a = parseSheetRows(LEDGER).rows.map((r) => r.fingerprint)
    const b = parseSheetRows(LEDGER).rows.map((r) => r.fingerprint)
    expect(a).toEqual(b)
  })

  it('is identical when the input rows are re-ordered', () => {
    const original = parseSheetRows(LEDGER).rows.map((r) => r.fingerprint).sort()

    const [header, ...data] = LEDGER
    // A deterministic non-trivial permutation: reverse, then rotate.
    const shuffled = [...data].reverse()
    shuffled.push(shuffled.shift() as string[])
    const reordered = parseSheetRows([header, ...shuffled]).rows
      .map((r) => r.fingerprint)
      .sort()

    expect(reordered).toEqual(original)
  })

  it('is unaffected by the unreliable timestamp column', () => {
    const withStale = parseSheetRows(sheet(row('Munnu Sudan', '60', '2')))
    const withDifferent = parseSheetRows(
      sheet(['1/1/2026 08:00:00', 'Munnu Sudan', '60', '2', 'Zelle']),
    )
    expect(withStale.rows[0].fingerprint).toBe(withDifferent.rows[0].fingerprint)
  })

  it('changes when an organizer edits the amount', () => {
    const before = parseSheetRows(sheet(row('Kavitha Raveendra Raja', '60', '2')))
    const after = parseSheetRows(sheet(row('Kavitha Raveendra Raja', '90', '2')))
    // This is exactly why a fingerprint miss must open a review item rather
    // than create a second household.
    expect(before.rows[0].fingerprint).not.toBe(after.rows[0].fingerprint)
  })

  it('matches the exported helper', () => {
    const result = parseSheetRows(sheet(row('Fingerprint Check', '60', '2')))
    expect(result.rows[0].fingerprint).toBe(
      rowFingerprint('fingerprint check', 6000, 2, 0),
    )
  })
})

describe('rows we refuse to guess about', () => {
  it('imports a blank-name row with zero admissions and no pass', () => {
    const result = parseSheetRows(sheet(row('', '60', '2')))

    const parsed = result.rows[0]
    expect(parsed.admissions).toBe(0)
    expect(parsed.paymentStatus).toBe('needs_review')
    expect(parsed.passEnabled).toBe(false)
    expect(parsed.blocking).toBe(true)
    expect(parsed.diagnostics).toContain('missing_name')
  })

  it('imports a blank head-count row with zero admissions and no pass', () => {
    const result = parseSheetRows(sheet(row('Anonymous Payer', '60', '')))

    const parsed = result.rows[0]
    expect(parsed.admissions).toBe(0)
    expect(parsed.people).toBeNull()
    expect(parsed.passEnabled).toBe(false)
    expect(parsed.diagnostics).toContain('missing_people')
  })

  it('treats a zero head count as unusable', () => {
    const result = parseSheetRows(sheet(row('Zero People', '60', '0')))
    expect(result.rows[0].admissions).toBe(0)
    expect(result.rows[0].passEnabled).toBe(false)
    expect(result.rows[0].diagnostics).toContain('zero_people')
  })

  it('refuses to read a head count out of prose', () => {
    const result = parseSheetRows(sheet(row('Wordy', '150', '4 adults 1 kid')))
    expect(result.rows[0].admissions).toBe(0)
    expect(result.rows[0].diagnostics).toContain('unparseable_people')
    expect(result.rows[0].passEnabled).toBe(false)
  })

  it('flags an unparseable amount but still issues the head count', () => {
    const result = parseSheetRows(sheet(row('Paid Somehow', 'paid in person', '2')))
    const parsed = result.rows[0]
    expect(parsed.admissions).toBe(2)
    expect(parsed.amountCents).toBeNull()
    expect(parsed.paymentStatus).toBe('needs_review')
    expect(parsed.passEnabled).toBe(true)
    expect(parsed.diagnostics).toContain('unparseable_amount')
  })

  it('keeps blank-name rows distinct from each other', () => {
    const result = parseSheetRows(sheet(row('', '60', '2'), row('', '60', '2')))
    expect(result.rows[0].fingerprint).not.toBe(result.rows[1].fingerprint)
  })
})

describe('sheet shape', () => {
  it('resolves columns regardless of header whitespace and casing', () => {
    const headers = ['timestamp ', ' your NAME', 'Amount  Paid', 'No. Of People', 'Payment Mode']
    const result = parseSheetRows([headers, ['x', 'Jane Doe', '60', '2', 'Zelle']])
    expect(result.rows[0].displayName).toBe('Jane Doe')
    expect(result.rows[0].admissions).toBe(2)
  })

  it('tolerates a title row above the header', () => {
    const result = parseSheetRows([['Onam 2026 Sadhya'], HEADERS, row('Jane Doe', '60', '2')])
    expect(result.rows).toHaveLength(1)
  })

  it('fails loudly when a required column disappears', () => {
    expect(() => parseSheetRows([['Timestamp', 'Your Name', 'Amount Paid']])).toThrow(
      SheetSchemaError,
    )
  })

  it('handles short rows where trailing cells were never filled in', () => {
    const result = parseSheetRows([HEADERS, [STALE_TS, 'Short Row', '60', '2', 'Zelle']])
    expect(result.rows[0].admissions).toBe(2)
    expect(result.rows[0].diagnostics).toEqual([])
  })

  it('carries the optional form answers through for the desk', () => {
    const result = parseSheetRows(
      sheet(row('Performer', '60', '2', 'Zelle', ['Yes', 'No', 'Yes', 'Group', 'Thiruvathira'])),
    )
    expect(result.rows[0].raw.prepay).toBe('Yes')
    expect(result.rows[0].raw.performerType).toBe('Group')
    expect(result.rows[0].raw.performanceDetails).toBe('Thiruvathira')
  })
})

describe('stats', () => {
  it('counts the ledger the way an organizer would', () => {
    const result = parseSheetRows(
      sheet(
        row('Clean A', '60', '2'),
        row('Clean B', '30', '1'),
        row('Donation', '500', '2'),
        row('No Name', '', ''),
        row('Card', '60', '2', 'Credit Card'),
        row('Cash', '60', '2', 'Cash'),
        ['', 'Total', '8970', '282', '', '', '', '', '', ''],
        ['', '', '', '', '', '', '', '', '', ''],
      ),
    )

    expect(result.stats.imported).toBe(4)
    expect(result.stats.clean).toBe(2)
    expect(result.stats.needsReview).toBe(2)
    expect(result.stats.admissions).toBe(5) // 2 + 1 + 2 + 0
    expect(result.stats.skippedCreditCard).toBe(1)
    expect(result.stats.skippedOther).toBe(1)
    expect(result.stats.skippedTotal).toBe(1)
    expect(result.stats.skippedEmpty).toBe(1)
  })
})

describe('csv path (no credentials required)', () => {
  it('parses a CSV export into the same shape as the API', () => {
    const csv = [
      HEADERS.join(','),
      `${STALE_TS},"Sason, Jubil",60,2,Zelle`,
      `${STALE_TS},Malabar Gold,500,2,Zelle`,
      `,Total,8970,282,`,
    ].join('\n')

    const result = parseSheetRows(parseCsv(csv))

    expect(result.rows).toHaveLength(2)
    expect(result.rows[0].displayName).toBe('Sason, Jubil')
    expect(result.rows.map((r) => r.admissions)).toEqual([2, 2])
    expect(result.stats.skippedTotal).toBe(1)
  })

  it('handles quoted fields containing newlines and doubled quotes', () => {
    const rows = parseCsv('a,"line1\nline2","say ""hi"""\nb,c,d')
    expect(rows).toEqual([
      ['a', 'line1\nline2', 'say "hi"'],
      ['b', 'c', 'd'],
    ])
  })
})
