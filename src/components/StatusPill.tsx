import type { PaymentStatus } from '@/lib/households'

/**
 * Status is always rendered as icon + word + colour. Colour alone is never the
 * signal — volunteers work in bright sun, on cheap screens, and some are
 * colour-blind.
 */
const STYLES: Record<PaymentStatus, { label: string; icon: string; className: string }> = {
  paid: { label: 'PAID', icon: '✓', className: 'bg-[var(--ok-bg)] text-[var(--ok)]' },
  comped: { label: 'COMPED', icon: '✓', className: 'bg-[var(--ok-bg)] text-[var(--ok)]' },
  unpaid: { label: 'UNPAID', icon: '✕', className: 'bg-[var(--danger-bg)] text-[var(--danger)]' },
  pending: { label: 'PENDING', icon: '…', className: 'bg-[var(--warn-bg)] text-[var(--warn)]' },
  needs_review: {
    label: 'NEEDS REVIEW',
    icon: '!',
    className: 'bg-[var(--warn-bg)] text-[var(--warn)]',
  },
  refunded: {
    label: 'REFUNDED',
    icon: '↩',
    className: 'bg-[var(--danger-bg)] text-[var(--danger)]',
  },
  partially_refunded: {
    label: 'PART. REFUNDED',
    icon: '↩',
    className: 'bg-[var(--warn-bg)] text-[var(--warn)]',
  },
}

export function StatusPill({ status }: { status: PaymentStatus }) {
  const s = STYLES[status] ?? STYLES.needs_review
  return (
    <span className={`pill ${s.className}`}>
      <span aria-hidden>{s.icon}</span>
      {s.label}
    </span>
  )
}

export function TicketCounts({
  purchased,
  redeemed,
  remaining,
  under6 = 0,
}: {
  purchased: number
  redeemed: number
  remaining: number
  under6?: number
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1 tabular-nums">
      <span>
        <strong className="text-lg">{purchased}</strong>{' '}
        <span className="text-sm text-black/60">bought</span>
      </span>
      <span>
        <strong className="text-lg">{redeemed}</strong>{' '}
        <span className="text-sm text-black/60">used</span>
      </span>
      <span
        className={`rounded-lg px-2 py-0.5 ${
          remaining > 0 ? 'bg-[var(--ok-bg)] text-[var(--ok)]' : 'bg-black/10 text-black/50'
        }`}
      >
        <strong className="text-lg">{remaining}</strong>{' '}
        <span className="text-sm font-semibold">left</span>
      </span>
      {under6 > 0 && (
        <span className="text-sm text-black/60">+{under6} under 6 (free)</span>
      )}
    </div>
  )
}
