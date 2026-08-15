import { NextResponse } from 'next/server'
import { z } from 'zod'
import { currentStaff, signInShared } from '@/lib/auth'

export const dynamic = 'force-dynamic'

const Body = z.object({ password: z.string().min(1).max(200) })

/**
 * JSON sign-in, for clients that cannot post to a server action.
 *
 * The browser scanner signs in through the /staff/login form; the iPad app has
 * no form to post, so it needs one endpoint that takes a password and comes
 * back with the same session cookie. Everything else — the shared identity, the
 * constant-time compare, the audit row, the 14-day cookie — is signInShared,
 * unchanged. This is a second door onto the same lock, not a second lock.
 */
export async function POST(req: Request) {
  let parsed: z.infer<typeof Body>
  try {
    parsed = Body.parse(await req.json())
  } catch {
    return NextResponse.json({ ok: false, error: 'Enter the volunteer password.' }, { status: 400 })
  }

  const result = await signInShared(parsed.password)
  if (!result.ok) {
    return NextResponse.json({ ok: false, error: result.error }, { status: 401 })
  }

  return NextResponse.json(
    { ok: true, staff: { name: result.staff.name, role: result.staff.role } },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}

/**
 * Is this device still signed in?
 *
 * Called on launch so the app can go straight to the camera instead of asking
 * for a password it already has a valid session for.
 */
export async function GET() {
  const staff = await currentStaff()
  if (!staff) return NextResponse.json({ ok: false }, { status: 401 })
  return NextResponse.json(
    { ok: true, staff: { name: staff.name, role: staff.role } },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
