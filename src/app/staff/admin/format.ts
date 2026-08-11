/** Shared display helpers. Client-safe — no database imports. */

/** Local clock time, e.g. "2:47 PM". Rendered with suppressHydrationWarning. */
export function clock(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

export function dateTime(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

export function ago(iso: string | null): string {
  if (!iso) return 'never'
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 48) return `${hours} hr ago`
  return `${Math.round(hours / 24)} days ago`
}

/** Enum values reach the screen as words a volunteer reads, not as identifiers. */
export function humanize(value: string | null | undefined): string {
  if (!value) return 'Unrecorded'
  return value.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

export function money(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  return `$${(cents / 100).toFixed(2)}`
}

/** Turns an RPC/API failure into something a volunteer can act on. */
export function describeError(data: Record<string, unknown>): string {
  switch (data.error) {
    case 'REASON_REQUIRED':
      return 'Type a reason first — it is stored with the change.'
    case 'BELOW_REDEEMED':
      return `Cannot set the total below ${data.tickets_redeemed}. That many admissions have already been used; reverse a scan first.`
    case 'ALREADY_REVERSED':
      return `That scan has already been reversed. Only ${data.max_reversible} left to give back.`
    case 'INVALID_QUANTITY':
      return data.max_reversible !== undefined
        ? `Enter a number between 1 and ${data.max_reversible}.`
        : 'That number is not valid. Nothing was changed.'
    case 'WOULD_GO_NEGATIVE':
      return 'That would push the household below zero used. Nothing was changed.'
    case 'REDEMPTION_NOT_FOUND':
      return 'That check-in no longer exists. Reload the page.'
    case 'PASS_NOT_FOUND':
      return 'This household no longer exists. Reload the page.'
    case 'UNAUTHORIZED':
      return 'You have been signed out. Sign in again.'
    case 'INVALID':
      return 'Check the values — the reason must be at least 3 characters.'
    default:
      return 'Something went wrong. Nothing was changed — try again.'
  }
}
