'use client'

import { useState } from 'react'
import Link from 'next/link'
import { StatusPill, TicketCounts } from '@/components/StatusPill'
import type { PaymentStatus } from '@/lib/households'
import { dateTime, humanize } from '../format'

export type ReviewItem = {
  id: string
  kind: string
  summary: string
  payload: Record<string, unknown>
  status: string
  created_at: string
  household_id: string | null
  display_name: string | null
  tickets_purchased: number | null
  tickets_redeemed: number | null
  tickets_remaining: number | null
  payment_status: PaymentStatus | null
}

/** Plain-language explanation of what each flag means and what to do about it. */
const GUIDANCE: Record<string, string> = {
  possible_duplicate:
    'Two records may be the same family. Check both ticket counts before merging — fix the one they are actually using, then disable the other. Never delete.',
  sheet_row_changed:
    'A spreadsheet row no longer matches what was imported — usually a typo fix or an amount edit. Decide whether it updates an existing household or is a genuinely new one.',
  unmapped_square_item:
    'A Square order contained a line item we do not recognise, so no admissions were granted. Read the raw order below and set the count by hand. Do not infer it from the dollar amount.',
  amount_mismatch:
    'The amount paid does not match the number of people at either $25 or $30. Often a donation bundled with tickets. Confirm the admission count with the organiser.',
  refund_after_redemption:
    'A refund arrived after this family had already eaten. Nothing was changed automatically. Decide by hand and leave a note.',
  webhook_error:
    'A Square webhook was received but could not be processed. Square will not retry it. Check the raw payload and reconcile manually.',
  missing_data: 'A record was missing something required, so no admissions were granted.',
}

export function ReviewQueue({ items }: { items: ReviewItem[] }) {
  const [open, setOpen] = useState<ReviewItem[]>(items)

  async function act(item: ReviewItem, action: 'resolve' | 'dismiss', note: string) {
    const res = await fetch(`/api/staff/admin/review/${item.id}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, note: note.trim() || undefined }),
    })
    if (res.ok) setOpen((prev) => prev.filter((i) => i.id !== item.id))
    return res.ok
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-black/60">
        {open.length} item{open.length === 1 ? '' : 's'} waiting. Closing an item records that a
        human looked at it — it does not change any ticket counts on its own.
      </p>

      {open.map((item) => (
        <ReviewCard key={item.id} item={item} onAct={act} />
      ))}
    </div>
  )
}

function ReviewCard({
  item,
  onAct,
}: {
  item: ReviewItem
  onAct: (item: ReviewItem, action: 'resolve' | 'dismiss', note: string) => Promise<boolean>
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  const [showRaw, setShowRaw] = useState(false)

  async function run(action: 'resolve' | 'dismiss') {
    setBusy(true)
    setFailed(false)
    const ok = await onAct(item, action, note)
    if (!ok) {
      setFailed(true)
      setBusy(false)
    }
  }

  return (
    <div className="card border-2 border-[var(--warn)]">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="pill bg-[var(--warn-bg)] text-[var(--warn)]">
          <span aria-hidden>!</span>
          {humanize(item.kind)}
        </span>
        <span className="text-sm text-black/50">{dateTime(item.created_at)}</span>
      </div>

      <p className="mt-3 text-lg font-bold">{item.summary}</p>

      {GUIDANCE[item.kind] && (
        <p className="mt-2 rounded-xl bg-[var(--cream)] px-4 py-3 text-[15px] leading-relaxed">
          {GUIDANCE[item.kind]}
        </p>
      )}

      {item.household_id && item.display_name && (
        <div className="mt-4 rounded-xl border border-black/10 p-3">
          <p className="font-bold">{item.display_name}</p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            {item.payment_status && <StatusPill status={item.payment_status} />}
            <TicketCounts
              purchased={item.tickets_purchased ?? 0}
              redeemed={item.tickets_redeemed ?? 0}
              remaining={item.tickets_remaining ?? 0}
            />
          </div>
          <Link
            href={`/staff/admin?household=${item.household_id}`}
            className="mt-2 inline-block text-sm font-semibold underline"
          >
            Open in admin to fix
          </Link>
        </div>
      )}

      <button
        type="button"
        onClick={() => setShowRaw((v) => !v)}
        className="mt-3 text-sm font-semibold underline"
      >
        {showRaw ? 'Hide' : 'Show'} raw data
      </button>
      {showRaw && (
        <pre className="mt-2 max-h-72 overflow-auto rounded-xl bg-black/5 p-3 text-xs">
          {JSON.stringify(item.payload, null, 2)}
        </pre>
      )}

      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder="What did you do? (optional, but kind to whoever reads this later)"
        className="field mt-4"
      />

      {failed && (
        <p className="mt-2 font-semibold text-[var(--danger)]">
          ✕ Could not save. Nothing changed — try again.
        </p>
      )}

      <div className="mt-3 grid grid-cols-2 gap-3">
        <button
          type="button"
          disabled={busy}
          onClick={() => run('resolve')}
          className="btn-primary"
        >
          ✓ Handled
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => run('dismiss')}
          className="btn-neutral"
        >
          Not an issue
        </button>
      </div>
    </div>
  )
}
