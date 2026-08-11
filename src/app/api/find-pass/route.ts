import { headers } from 'next/headers'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { query, queryOne } from '@/lib/db'
import { sendPassEmail } from '@/lib/email'
import type { Household } from '@/lib/households'
import { normalizeEmail, normalizePhone, sha256 } from '@/lib/tokens'

export const dynamic = 'force-dynamic'

const WINDOW_SECONDS = 900
const MAX_PER_WINDOW = 8

/** Floor on response time, so a hit and a miss are indistinguishable. */
const MIN_RESPONSE_MS = 700

/**
 * The only answer this endpoint ever gives on a well-formed request. Saying
 * anything else — "no reservation found", a different status code, a visibly
 * faster reply — would turn this into a tool for testing whether a given
 * person is attending.
 */
const GENERIC = "If we found a matching reservation, we've sent your pass."

const Body = z.object({
  contact: z.string().trim().min(3).max(200),
})

export async function POST(req: Request) {
  const startedAt = Date.now()

  const hdrs = await headers()
  const forwarded = hdrs.get('x-forwarded-for') ?? 'unknown'
  // Namespaced hash: this shares the pass_lookups table with the public pass
  // endpoint, and a guest refreshing their own pass must not burn the much
  // smaller budget that guards outbound mail.
  const ipHash = sha256(`find-pass:${forwarded.split(',')[0].trim()}`)

  const [{ count }] = await query<{ count: string }>(
    `select count(*)::text as count from pass_lookups
      where ip_hash = $1 and created_at > now() - ($2 || ' seconds')::interval`,
    [ipHash, WINDOW_SECONDS],
  )

  if (Number(count) > MAX_PER_WINDOW) {
    return NextResponse.json(
      { ok: false, error: 'RATE_LIMITED', message: 'Too many tries. Please wait a few minutes.' },
      { status: 429, headers: { 'Retry-After': String(WINDOW_SECONDS) } },
    )
  }

  await query('insert into pass_lookups (ip_hash) values ($1)', [ipHash])

  let body: z.infer<typeof Body>
  try {
    body = Body.parse(await req.json())
  } catch {
    return NextResponse.json({ ok: false, error: 'FORMAT' }, { status: 400 })
  }

  const email = normalizeEmail(body.contact)
  const phone = normalizePhone(body.contact)

  // Rejecting an unparseable entry leaks nothing about who registered — it only
  // says the input was neither an email nor a phone number — and it saves a
  // guest who typed their name from waiting for an email that will never come.
  if (!email && !phone) {
    return NextResponse.json({ ok: false, error: 'FORMAT' }, { status: 400 })
  }

  // Name lookup is deliberately absent. Matching on a name would let anyone who
  // knows a guest's name have that household's admissions mailed to them.
  const household = await queryOne<Household>(
    `select * from households
      where ($1::text is not null and normalized_email = $1)
         or ($2::text is not null and normalized_phone = $2)
      order by created_at asc
      limit 1`,
    [email, phone],
  )

  if (household) {
    // Result intentionally discarded: a bounce, a missing address on a
    // phone-matched household, or a provider outage must all look identical
    // from out here. The failure is recorded in email_deliveries for staff.
    await sendPassEmail(household)
  }

  const elapsed = Date.now() - startedAt
  if (elapsed < MIN_RESPONSE_MS) {
    await new Promise((resolve) => setTimeout(resolve, MIN_RESPONSE_MS - elapsed))
  }

  return NextResponse.json(
    { ok: true, message: GENERIC },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
