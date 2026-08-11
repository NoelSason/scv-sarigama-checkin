import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { SheetSchemaError, SheetsCredentialError } from '@/lib/sheets'
import { syncSheet } from '@/lib/sheet-sync'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

/**
 * Scheduled sheet sync.
 *
 * Committing on a schedule is safe here only because the sync itself refuses
 * to guess: a row whose fingerprint no longer matches never auto-creates a
 * second household, it opens a review item. Without that guardrail this
 * endpoint would be a duplicate-pass generator.
 *
 * Pass ?dryRun=1 to plan without writing.
 */
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  // Fail closed: an unset secret means the endpoint is simply unavailable,
  // never open.
  if (!secret) return false

  const header = req.headers.get('authorization') ?? ''
  const prefix = 'Bearer '
  if (!header.startsWith(prefix)) return false

  const provided = Buffer.from(header.slice(prefix.length))
  const expected = Buffer.from(secret)
  // Length is compared separately because timingSafeEqual throws on a mismatch.
  return provided.length === expected.length && timingSafeEqual(provided, expected)
}

async function handle(req: Request) {
  if (!authorized(req)) {
    return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })
  }

  const dryRun = new URL(req.url).searchParams.get('dryRun') === '1'

  try {
    const summary = await syncSheet({ commit: !dryRun, note: 'Scheduled sheet sync' })
    return NextResponse.json(
      {
        ok: true,
        dryRun: summary.dryRun,
        counts: summary.counts,
        reviewsOpened: summary.reviewsOpened,
        parse: summary.parse,
      },
      { headers: { 'Cache-Control': 'no-store' } },
    )
  } catch (err) {
    if (err instanceof SheetsCredentialError || err instanceof SheetSchemaError) {
      return NextResponse.json({ ok: false, error: err.message }, { status: 503 })
    }
    throw err
  }
}

// Vercel Cron issues GET; POST is here so the job can also be triggered by hand.
export const GET = handle
export const POST = handle
