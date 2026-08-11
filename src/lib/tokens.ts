import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptCb)

/**
 * Pass token: 32 random bytes → 256 bits of entropy, base64url encoded.
 *
 * Guessing one is not a threat model we need to defend against beyond this:
 * at 256 bits there is nothing to enumerate. Deliberately NOT derived from
 * name, email, or any sequential id.
 */
export function generatePassToken(): string {
  return randomBytes(32).toString('base64url')
}

/** Session cookie value. Same entropy budget as a pass token. */
export function generateSessionToken(): string {
  return randomBytes(32).toString('base64url')
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/**
 * Password hashing with scrypt from the Node standard library.
 *
 * No bcrypt/argon2 dependency: this guards perhaps five volunteer accounts
 * created by an admin, and scrypt with these parameters is entirely adequate.
 * Stored as `salt:derivedKey`, both hex.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16)
  const derived = (await scrypt(password.normalize('NFKC'), salt, 64)) as Buffer
  return `${salt.toString('hex')}:${derived.toString('hex')}`
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [saltHex, keyHex] = stored.split(':')
  if (!saltHex || !keyHex) return false
  const salt = Buffer.from(saltHex, 'hex')
  const expected = Buffer.from(keyHex, 'hex')
  const derived = (await scrypt(password.normalize('NFKC'), salt, expected.length)) as Buffer
  // Constant-time: never leak how much of the hash matched.
  return derived.length === expected.length && timingSafeEqual(derived, expected)
}

// ---------------------------------------------------------------------------
// Identity normalization
//
// Used for dedupe and for desk search. Kept deliberately simple: we
// never auto-merge on these alone (see the review queue), so an imperfect
// normalization surfaces a human decision rather than corrupting the ledger.
// ---------------------------------------------------------------------------

export function normalizeEmail(email: string | null | undefined): string | null {
  if (!email) return null
  const trimmed = email.trim().toLowerCase()
  return trimmed.length > 0 && trimmed.includes('@') ? trimmed : null
}

/** US numbers to E.164. Anything we can't confidently canonicalize → null. */
export function normalizePhone(phone: string | null | undefined): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length === 10) return `+1${digits}`
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`
  if (phone.trim().startsWith('+') && digits.length >= 8 && digits.length <= 15) {
    return `+${digits}`
  }
  return null
}

/** Loose key for duplicate detection: lowercase, collapse whitespace/punctuation. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
