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

/**
 * Clock time of an earlier scan, on the reader's own device.
 *
 * A volunteer compares what they see against the clock in their hand and the
 * queue in front of them, so the device's timezone is the right one — not the
 * server's.
 */
export function scanTimeLabel(at: string): string {
  const date = new Date(at)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/**
 * "4 minutes ago" while that is the striking fact, nothing once it isn't.
 *
 * A pass scanned minutes ago is the phone being passed back down the queue; one
 * scanned two hours ago is a family coming back for a second sitting. Only the
 * first needs the elapsed time spelled out — past an hour the clock time says
 * it better.
 */
export function scanAgoLabel(at: string, now: number = Date.now()): string | null {
  const then = new Date(at).getTime()
  if (Number.isNaN(then)) return null
  const minutes = Math.floor((now - then) / 60000)
  if (minutes < 0 || minutes >= 60) return null
  if (minutes < 1) return 'just now'
  return `${minutes} minute${minutes === 1 ? '' : 's'} ago`
}
