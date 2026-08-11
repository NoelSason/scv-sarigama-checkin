/**
 * A scan yields the full pass URL (that is all the QR encodes). Accept a bare
 * token too, so a volunteer can type one off a printed roster if a camera
 * fails or a screen is cracked.
 */
export function extractToken(scanned: string): string {
  const value = scanned.trim()
  const match = value.match(/\/p\/([A-Za-z0-9_-]+)/)
  return match ? match[1] : value
}

/** A pass token is 32 random bytes in base64url — always 43 characters. */
export function looksLikeToken(value: string): boolean {
  return /^[A-Za-z0-9_-]{20,64}$/.test(value.trim())
}
