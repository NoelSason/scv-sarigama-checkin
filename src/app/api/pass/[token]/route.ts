import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { query } from '@/lib/db'
import { findByToken } from '@/lib/households'
import { sha256 } from '@/lib/tokens'

export const dynamic = 'force-dynamic'

const WINDOW_SECONDS = 60
const MAX_PER_WINDOW = 60

/**
 * Public pass lookup.
 *
 * Returns only what the guest's own screen needs. Never notes, internal ids,
 * payment metadata, or anything about another household.
 *
 * Enumeration isn't the threat here — a pass token is 256 random bits. The
 * rate limit exists to stop a single client hammering the database.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params

  const hdrs = await headers()
  const forwarded = hdrs.get('x-forwarded-for') ?? 'unknown'
  const ipHash = sha256(forwarded.split(',')[0].trim())

  const [{ count }] = await query<{ count: string }>(
    `select count(*)::text as count from pass_lookups
      where ip_hash = $1 and created_at > now() - ($2 || ' seconds')::interval`,
    [ipHash, WINDOW_SECONDS],
  )

  if (Number(count) > MAX_PER_WINDOW) {
    return NextResponse.json(
      { error: 'Too many requests' },
      { status: 429, headers: { 'Retry-After': String(WINDOW_SECONDS) } },
    )
  }

  await query('insert into pass_lookups (ip_hash) values ($1)', [ipHash])

  const household = await findByToken(token)
  if (!household) {
    return NextResponse.json({ error: 'Pass not found' }, { status: 404 })
  }

  return NextResponse.json(
    {
      display_name: household.display_name,
      tickets_purchased: household.tickets_purchased,
      tickets_redeemed: household.tickets_redeemed,
      tickets_remaining: household.tickets_remaining,
      children_under_6: household.children_under_6,
      pass_enabled: household.pass_enabled,
      payment_status: household.payment_status,
    },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
