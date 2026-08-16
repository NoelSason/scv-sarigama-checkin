import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { AWAITING_THANKYOU, dispatchThankYouEmails } from '@/lib/email/dispatch'

export const dynamic = 'force-dynamic'

/**
 * Send the after-the-event thank-you, a batch at a time.
 *
 * Batched rather than one big blast: the sender is rate-limited to stay under
 * Resend's ceiling, and a serverless function has a deadline. Each call takes
 * the next few households and stops; calling it repeatedly — by hand or on a
 * schedule — works through the list, and a call that dies halfway loses nothing
 * because the ledger decides who is still owed one.
 *
 * GET reports who is left without sending anything, so the size of the mailing
 * can be checked before any of it goes out.
 */

function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const offered = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const a = Buffer.from(offered)
  const b = Buffer.from(secret)
  return a.length === b.length && timingSafeEqual(a, b)
}

export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  const [{ count }] = await query<{ count: string }>(
    `select count(*)::text as count ${AWAITING_THANKYOU}`,
  )

  return NextResponse.json(
    { awaiting: Number(count), videoConfigured: Boolean(process.env.THANKYOU_VIDEO_URL?.trim()) },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'UNAUTHORIZED' }, { status: 401 })

  const result = await dispatchThankYouEmails('thankyou endpoint')

  const [{ count }] = await query<{ count: string }>(
    `select count(*)::text as count ${AWAITING_THANKYOU}`,
  )

  return NextResponse.json(
    { ...result, remaining: Number(count) },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
