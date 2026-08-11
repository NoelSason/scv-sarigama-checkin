'use client'

import { useCallback, useEffect, useState } from 'react'
import type { Household } from '@/lib/households'
import { StatusPill, TicketCounts } from '@/components/StatusPill'
import { dateTime, describeError, humanize, money } from './format'

/** Mirrors the shape returned by /api/staff/household/[id]. */
type HistoryItem =
  | {
      kind: 'redemption'
      id: string
      at: string
      staff: string | null
      quantity: number
      device: string | null
      reversed: boolean
    }
  | {
      kind: 'adjustment'
      id: string
      at: string
      staff: string | null
      delta: number
      reason: string
    }
  | {
      kind: 'audit'
      id: string
      at: string
      staff: string | null
      action: string
      metadata: Record<string, unknown>
    }

type Feedback = { tone: 'ok' | 'bad'; text: string } | null
type OpenForm = 'none' | 'tickets' | 'pass'

/**
 * One household, everything an admin can do to it.
 *
 * Every destructive action takes a typed reason in the same panel — no separate
 * confirm dialog. A dialog trains people to tap through it; a text field they
 * have to fill in does not.
 */
export function HouseholdPanel({
  householdId,
  onClose,
  onChanged,
}: {
  householdId: string
  onClose: () => void
  onChanged?: () => void
}) {
  const [household, setHousehold] = useState<Household | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [loading, setLoading] = useState(true)
  const [feedback, setFeedback] = useState<Feedback>(null)
  const [busy, setBusy] = useState(false)
  const [form, setForm] = useState<OpenForm>('none')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/staff/household/${householdId}`, { cache: 'no-store' })
      if (!res.ok) throw new Error('load failed')
      const data = (await res.json()) as { household: Household; history: HistoryItem[] }
      setHousehold(data.household)
      setHistory(data.history ?? [])
    } catch {
      setFeedback({ tone: 'bad', text: 'Could not load this household. Check the connection.' })
    } finally {
      setLoading(false)
    }
  }, [householdId])

  useEffect(() => {
    void load()
  }, [load])

  async function send(url: string, body: unknown, okText: string) {
    setBusy(true)
    setFeedback(null)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok || data.success === false) {
        setFeedback({ tone: 'bad', text: describeError(data) })
        return false
      }
      setFeedback({ tone: 'ok', text: okText })
      setForm('none')
      await load()
      onChanged?.()
      return true
    } catch {
      setFeedback({
        tone: 'bad',
        text: 'No response from the server. Nothing was changed — check the connection and try again.',
      })
      return false
    } finally {
      setBusy(false)
    }
  }

  if (loading && !household) {
    return <div className="card mt-4 text-center font-bold">Loading household…</div>
  }
  if (!household) {
    return (
      <div className="card mt-4">
        <p className="font-bold">Could not load this household.</p>
        <button type="button" onClick={onClose} className="btn-neutral mt-3 w-full">
          Close
        </button>
      </div>
    )
  }

  const redemptions = history.filter(
    (h): h is Extract<HistoryItem, { kind: 'redemption' }> => h.kind === 'redemption',
  )

  return (
    <div className="card mt-4 border-2 border-[var(--green)]">
      <div className="flex items-start gap-3">
        <div className="min-w-0">
          <h2 className="text-2xl font-black break-words">{household.display_name}</h2>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <StatusPill status={household.payment_status} />
            {household.is_test && (
              <span className="pill bg-[var(--warn-bg)] text-[var(--warn)]">⚠ TEST ROW</span>
            )}
            {!household.pass_enabled && (
              <span className="pill bg-[var(--danger-bg)] text-[var(--danger)]">
                ✕ PASS DISABLED
              </span>
            )}
          </div>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="btn-neutral ml-auto shrink-0 px-4 py-2"
          aria-label="Close household"
        >
          ✕
        </button>
      </div>

      <div className="mt-4">
        <TicketCounts
          purchased={household.tickets_purchased}
          redeemed={household.tickets_redeemed}
          remaining={household.tickets_remaining}
          under6={household.children_under_6}
        />
      </div>

      <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-sm">
        {household.email ? (
          <a href={`mailto:${household.email}`} className="underline">
            {household.email}
          </a>
        ) : (
          <span className="text-black/50">No email</span>
        )}
        {household.phone ? (
          <a href={`tel:${household.phone}`} className="underline">
            {household.phone}
          </a>
        ) : (
          <span className="text-black/50">No phone</span>
        )}
      </div>

      {feedback && (
        <p
          className={`mt-4 rounded-xl border-2 p-3 font-semibold ${
            feedback.tone === 'ok'
              ? 'border-[var(--ok)] bg-[var(--ok-bg)] text-[var(--ok)]'
              : 'border-[var(--danger)] bg-[var(--danger-bg)] text-[var(--danger)]'
          }`}
          role="status"
        >
          {feedback.tone === 'ok' ? '✓ ' : '✕ '}
          {feedback.text}
        </p>
      )}

      {/* ---------------- actions ---------------- */}
      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setForm(form === 'tickets' ? 'none' : 'tickets')}
          className="btn-neutral"
        >
          ✎ Change ticket count
        </button>
        <button
          type="button"
          onClick={() => setForm(form === 'pass' ? 'none' : 'pass')}
          className={household.pass_enabled ? 'btn-danger' : 'btn-primary'}
        >
          {household.pass_enabled ? '⊘ Disable pass' : '↻ Re-enable pass'}
        </button>
      </div>

      {form === 'tickets' && (
        <TicketForm
          household={household}
          busy={busy}
          onCancel={() => setForm('none')}
          onSubmit={(newTotal, reason) =>
            send(
              `/api/staff/household/${household.id}/tickets`,
              { newTotal, reason },
              `Ticket count is now ${newTotal}.`,
            )
          }
        />
      )}

      {form === 'pass' && (
        <PassForm
          enabled={household.pass_enabled}
          busy={busy}
          onCancel={() => setForm('none')}
          onSubmit={(reason) =>
            send(
              `/api/staff/admin/pass/${household.id}`,
              { enabled: !household.pass_enabled, reason },
              household.pass_enabled
                ? 'Pass disabled. It will be refused at the door.'
                : 'Pass re-enabled.',
            )
          }
        />
      )}

      {/* ---------------- reversals ---------------- */}
      <section className="mt-6">
        <h3 className="text-lg font-black">Check-ins</h3>
        {redemptions.length === 0 ? (
          <p className="mt-1 text-sm text-black/60">
            Nobody from this household has been checked in yet.
          </p>
        ) : (
          <ul className="mt-2 space-y-2">
            {redemptions.map((r) => (
              <RedemptionRow
                key={r.id}
                item={r}
                busy={busy}
                onReverse={(quantity, reason) =>
                  send(
                    '/api/staff/admin/reversal',
                    { redemptionId: r.id, quantity, reason },
                    `${quantity} admission${quantity === 1 ? '' : 's'} given back.`,
                  )
                }
              />
            ))}
          </ul>
        )}
      </section>

      {/* ---------------- raw record ---------------- */}
      <details className="mt-6 rounded-xl border-2 border-black/10 p-3">
        <summary className="cursor-pointer font-bold">Source &amp; payment record</summary>
        <dl className="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm break-all">
          <Field label="Payment status" value={humanize(household.payment_status)} />
          <Field label="Payment method" value={humanize(household.payment_method)} />
          <Field label="Amount paid" value={money(household.amount_paid_cents)} />
          <Field label="Came from" value={humanize(household.source)} />
          <Field label="Source record" value={household.source_record_id ?? '—'} />
          <Field label="Square order" value={household.square_order_id ?? '—'} />
          <Field label="Under 6 (free)" value={String(household.children_under_6)} />
          <Field label="Household id" value={household.id} />
          <Field label="Pass token" value={household.pass_token} />
          <Field label="Notes" value={household.notes ?? '—'} />
          <Field label="Created" value={dateTime(household.created_at)} />
          <Field label="Updated" value={dateTime(household.updated_at)} />
        </dl>
      </details>

      {/* ---------------- full history ---------------- */}
      <details className="mt-3 rounded-xl border-2 border-black/10 p-3">
        <summary className="cursor-pointer font-bold">
          Full history ({history.length} event{history.length === 1 ? '' : 's'})
        </summary>
        <ul className="mt-3 space-y-2 text-sm">
          {history.map((h) => (
            <li key={`${h.kind}-${h.id}`} className="border-b border-black/5 pb-2 last:border-0">
              <span className="font-semibold">{describeHistory(h)}</span>
              <span className="block text-black/55" suppressHydrationWarning>
                {dateTime(h.at)}
                {h.staff ? ` · ${h.staff}` : ''}
              </span>
            </li>
          ))}
          {history.length === 0 && <li className="text-black/60">Nothing recorded yet.</li>}
        </ul>
      </details>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function Field({ label, value }: { label: string; value: string }) {
  return (
    <>
      <dt className="font-semibold text-black/60">{label}</dt>
      <dd suppressHydrationWarning>{value}</dd>
    </>
  )
}

function TicketForm({
  household,
  busy,
  onSubmit,
  onCancel,
}: {
  household: Household
  busy: boolean
  onSubmit: (newTotal: number, reason: string) => void
  onCancel: () => void
}) {
  const [total, setTotal] = useState(String(household.tickets_purchased))
  const [reason, setReason] = useState('')
  const n = Number(total)
  const valid = total !== '' && Number.isInteger(n) && n >= 0 && n <= 50 && reason.trim().length >= 3

  return (
    <div className="mt-3 rounded-xl border-2 border-[var(--gold)] bg-[var(--cream)] p-4">
      <p className="font-bold">Change how many admissions this household bought</p>
      <p className="mt-1 text-sm text-black/70">
        Currently {household.tickets_purchased} bought, {household.tickets_redeemed} already used.
        Under-6 children are never counted here.
      </p>
      <label className="mt-3 block text-sm font-semibold" htmlFor="new-total">
        New total
      </label>
      <input
        id="new-total"
        inputMode="numeric"
        pattern="[0-9]*"
        value={total}
        onChange={(e) => setTotal(e.target.value.replace(/\D/g, ''))}
        className="field mt-1 text-lg"
      />
      <label className="mt-3 block text-sm font-semibold" htmlFor="ticket-reason">
        Reason (required — stored permanently)
      </label>
      <input
        id="ticket-reason"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="e.g. paid cash for 2 more at the door"
        className="field mt-1"
      />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          disabled={!valid || busy}
          onClick={() => onSubmit(n, reason.trim())}
          className="btn-gold"
        >
          {busy ? 'Saving…' : 'Save new total'}
        </button>
        <button type="button" onClick={onCancel} className="btn-neutral">
          Cancel
        </button>
      </div>
    </div>
  )
}

function PassForm({
  enabled,
  busy,
  onSubmit,
  onCancel,
}: {
  enabled: boolean
  busy: boolean
  onSubmit: (reason: string) => void
  onCancel: () => void
}) {
  const [reason, setReason] = useState('')

  return (
    <div className="mt-3 rounded-xl border-2 border-black/15 bg-white p-4">
      <p className="font-bold">
        {enabled ? 'Disable this pass?' : 'Re-enable this pass?'}
      </p>
      <p className="mt-1 text-sm text-black/70">
        {enabled
          ? 'The QR keeps working as a lookup but the door will refuse it. Nothing is deleted and the ticket count is untouched.'
          : 'The door will accept this pass again for any admissions still remaining.'}
      </p>
      <input
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (optional but recommended)"
        className="field mt-3"
        aria-label="Reason"
      />
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <button
          type="button"
          disabled={busy}
          onClick={() => onSubmit(reason.trim())}
          className={enabled ? 'btn-danger' : 'btn-primary'}
        >
          {busy ? 'Saving…' : enabled ? 'Yes, disable it' : 'Yes, re-enable it'}
        </button>
        <button type="button" onClick={onCancel} className="btn-neutral">
          Cancel
        </button>
      </div>
    </div>
  )
}

function RedemptionRow({
  item,
  busy,
  onReverse,
}: {
  item: Extract<HistoryItem, { kind: 'redemption' }>
  busy: boolean
  onReverse: (quantity: number, reason: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [qty, setQty] = useState(String(item.quantity))
  const [reason, setReason] = useState('')
  const n = Number(qty)
  const valid = n >= 1 && n <= item.quantity && reason.trim().length >= 3

  return (
    <li className="rounded-xl border-2 border-black/10 p-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <strong className="text-lg tabular-nums">
          {item.quantity} admitted
        </strong>
        <span className="text-sm text-black/60" suppressHydrationWarning>
          {dateTime(item.at)}
          {item.staff ? ` · ${item.staff}` : ''}
          {item.device ? ` · ${item.device}` : ''}
        </span>
        {item.reversed && (
          <span className="pill bg-[var(--warn-bg)] text-[var(--warn)]">↩ REVERSED</span>
        )}
        {!item.reversed && (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="ml-auto rounded-lg border-2 border-[var(--danger)] px-3 py-2 text-sm font-bold text-[var(--danger)]"
          >
            {open ? 'Cancel' : 'Reverse'}
          </button>
        )}
      </div>

      {open && (
        <div className="mt-3 border-t border-black/10 pt-3">
          <p className="text-sm text-black/70">
            This gives admissions back to the household. The original check-in is kept in the
            history — it is never deleted.
          </p>
          <div className="mt-2 flex gap-2">
            <input
              inputMode="numeric"
              pattern="[0-9]*"
              value={qty}
              onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))}
              className="field w-24 text-lg"
              aria-label="How many to give back"
            />
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Reason (required) e.g. scanned twice by mistake"
              className="field"
              aria-label="Reason"
            />
          </div>
          <button
            type="button"
            disabled={!valid || busy}
            onClick={() => onReverse(n, reason.trim())}
            className="btn-danger mt-3 w-full"
          >
            {busy ? 'Reversing…' : `Give back ${n || 0} admission${n === 1 ? '' : 's'}`}
          </button>
        </div>
      )}
    </li>
  )
}

function describeHistory(h: HistoryItem): string {
  if (h.kind === 'redemption') {
    return `${h.quantity} admitted${h.reversed ? ' (later reversed)' : ''}`
  }
  if (h.kind === 'adjustment') {
    return `${h.delta > 0 ? '+' : ''}${h.delta} admission${Math.abs(h.delta) === 1 ? '' : 's'} — ${h.reason}`
  }
  const reason = typeof h.metadata.reason === 'string' ? ` — ${h.metadata.reason}` : ''
  return `${humanize(h.action)}${reason}`
}
