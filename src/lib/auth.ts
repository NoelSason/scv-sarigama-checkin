import 'server-only'
import { timingSafeEqual } from 'node:crypto'
import { cookies, headers } from 'next/headers'
import { redirect } from 'next/navigation'
import { query, queryOne } from './db'
import { generateSessionToken, sha256, verifyPassword } from './tokens'

export const SESSION_COOKIE = 'onam_staff'
const SESSION_DAYS = 14

/** The single identity every shared-password session runs as. */
const SHARED_STAFF_EMAIL = 'volunteer@scvsarigama.local'

export type StaffRole = 'admin' | 'registration' | 'scanner'

export type Staff = {
  id: string
  email: string
  name: string
  role: StaffRole
  active: boolean
}

/**
 * Session model: a random 256-bit cookie value; only its SHA-256 lands in the
 * database. A leaked database dump therefore yields no usable sessions, and an
 * admin can revoke a device without touching the password.
 */
export async function createSession(staffId: string, userAgent?: string): Promise<string> {
  const token = generateSessionToken()
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000)
  await query(
    `insert into staff_sessions (token_hash, staff_id, user_agent, expires_at)
     values ($1, $2, $3, $4)`,
    [sha256(token), staffId, userAgent ?? null, expires],
  )
  return token
}

/**
 * Shared-password sign-in.
 *
 * Volunteers do not get individual accounts: on event day, handing out and
 * resetting a dozen logins costs more than it buys. One password, typed once,
 * and the phone stays signed in for two weeks.
 *
 * The trade-off is deliberate and worth knowing: the audit trail attributes
 * every action to "Volunteer" rather than to a person, and anyone who learns
 * the password can redeem. Set STAFF_PASSWORD to something less guessable than
 * the default if that matters to you.
 */
export async function signInShared(
  password: string,
): Promise<{ ok: true; staff: Staff } | { ok: false; error: string }> {
  const expected = process.env.STAFF_PASSWORD || 'admin123'

  // Constant-time compare so the form can't be used to probe the password
  // character by character.
  const a = Buffer.from(password.trim())
  const b = Buffer.from(expected)
  const matches = a.length === b.length && timingSafeEqual(a, b)

  if (!matches) return { ok: false, error: 'Incorrect password.' }

  // One shared identity backs every session, so existing role checks, audit
  // rows, and foreign keys all keep working unchanged.
  let staff = await queryOne<Staff>(
    `select id, email, name, role, active from staff_users where email = $1`,
    [SHARED_STAFF_EMAIL],
  )

  if (!staff) {
    staff = await queryOne<Staff>(
      `insert into staff_users (email, name, role, password_hash)
       values ($1, 'Volunteer', 'admin', 'shared-password-login')
       on conflict (email) do update set active = true
       returning id, email, name, role, active`,
      [SHARED_STAFF_EMAIL],
    )
  }
  if (!staff) return { ok: false, error: 'Could not start a session. Try again.' }

  const hdrs = await headers()
  const token = await createSession(staff.id, hdrs.get('user-agent') ?? undefined)

  const jar = await cookies()
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  })

  await query(
    `insert into audit_logs (actor_type, actor_id, action, metadata)
     values ('staff', $1, 'staff_signed_in', '{"via":"shared password"}'::jsonb)`,
    [staff.id],
  )

  return { ok: true, staff }
}

export async function signIn(
  email: string,
  password: string,
): Promise<{ ok: true; staff: Staff } | { ok: false; error: string }> {
  const normalized = email.trim().toLowerCase()

  const row = await queryOne<Staff & { password_hash: string }>(
    'select * from staff_users where email = $1',
    [normalized],
  )

  // Same message and comparable work whether or not the account exists, so the
  // login form can't be used to enumerate volunteer emails.
  const stored = row?.password_hash ?? 'ffff:ffff'
  const valid = await verifyPassword(password, stored)

  if (!row || !valid) return { ok: false, error: 'Incorrect email or password.' }
  if (!row.active) return { ok: false, error: 'This account has been deactivated.' }

  const hdrs = await headers()
  const token = await createSession(row.id, hdrs.get('user-agent') ?? undefined)

  const jar = await cookies()
  jar.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_DAYS * 86_400,
  })

  await query('update staff_users set last_login_at = now() where id = $1', [row.id])
  await query(
    `insert into audit_logs (actor_type, actor_id, action, metadata)
     values ('staff', $1, 'staff_signed_in', $2)`,
    [row.id, JSON.stringify({ email: normalized })],
  )

  const { password_hash: _drop, ...staff } = row
  void _drop
  return { ok: true, staff }
}

export async function signOut(): Promise<void> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (token) {
    await query('update staff_sessions set revoked_at = now() where token_hash = $1', [
      sha256(token),
    ])
  }
  jar.delete(SESSION_COOKIE)
}

/** Current staff member, or null. Never throws — safe in layouts. */
export async function currentStaff(): Promise<Staff | null> {
  const jar = await cookies()
  const token = jar.get(SESSION_COOKIE)?.value
  if (!token) return null

  return queryOne<Staff>(
    `select u.id, u.email, u.name, u.role, u.active
       from staff_sessions s
       join staff_users u on u.id = s.staff_id
      where s.token_hash = $1
        and s.revoked_at is null
        and s.expires_at > now()
        and u.active`,
    [sha256(token)],
  )
}

const ROLE_RANK: Record<StaffRole, number> = { scanner: 1, registration: 2, admin: 3 }

/**
 * Gate a page or action. Redirects to sign-in when logged out, and to the
 * staff home when logged in without sufficient role — never a bare 403 that
 * would leave a volunteer stuck mid-event.
 */
export async function requireStaff(minimum: StaffRole = 'scanner'): Promise<Staff> {
  const staff = await currentStaff()
  if (!staff) redirect('/staff/login')
  if (ROLE_RANK[staff.role] < ROLE_RANK[minimum]) redirect('/staff')
  return staff
}

/** Same check for route handlers, which must return a response, not redirect. */
export async function requireStaffApi(minimum: StaffRole = 'scanner'): Promise<Staff | null> {
  const staff = await currentStaff()
  if (!staff) return null
  if (ROLE_RANK[staff.role] < ROLE_RANK[minimum]) return null
  return staff
}

export function canRedeem(role: StaffRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.scanner
}
export function canEditTickets(role: StaffRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK.registration
}
export function isAdmin(role: StaffRole): boolean {
  return role === 'admin'
}
