'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { Household, PaymentMethod, PaymentStatus } from '@/lib/households'
import { StatusPill, TicketCounts } from '@/components/StatusPill'

/**
 * Registration desk.
 *
 * Search is the whole interface. A volunteer types part of a name and gets the
 * family; everything else hangs off that one result. Every action that changes
 * money or admissions is two taps with the old and new value shown in between —
 * a single mis-tap must never be able to alter a count.
 */

/* Mirrors the shape built by /api/staff/household/[id]. Duplicated rather than
   imported so this client bundle never reaches into a server route module. */
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
  | { kind: 'adjustment'; id: string; at: string; staff: string | null; delta: number; reason: string }
  | {
      kind: 'audit'
      id: string
      at: string
      staff: string | null
      action: string
      metadata: Record<string, unknown>
    }

type Tab = 'pass' | 'edit' | 'payment' | 'tickets' | 'history'

const METHODS: { value: PaymentMethod; label: string }[] = [
  { value: 'cash', label: 'Cash' },
  { value: 'zelle', label: 'Zelle' },
  { value: 'square', label: 'Square / card' },
  { value: 'complimentary', label: 'Complimentary' },
  { value: 'other', label: 'Other' },
]

export function RegistrationDesk({ staffName }: { staffName: string }) {
  const [term, setTerm] = useState('')
  // Results carry the term they answer, so a stale response can never be shown
  // against a newer query — the desk must not act on the wrong family.
  const [results, setResults] = useState<{ term: string; rows: Household[] } | null>(null)
  const [selected, setSelected] = useState<Household | null>(null)
  const [walkIn, setWalkIn] = useState(false)
  const [created, setCreated] = useState<Household | null>(null)

  // Searching is suspended while a panel is open, so results can't shuffle
  // under a volunteer mid-edit. Closing a panel re-runs it and picks up any
  // change that was just made.
  const panelOpen = selected !== null || walkIn
  const active = term.trim()

  useEffect(() => {
    if (panelOpen || active.length < 2) return
    const timer = setTimeout(async () => {
      try {
        const res = await fetch(`/api/staff/lookup?q=${encodeURIComponent(active)}`, {
          cache: 'no-store',
        })
        const data = await res.json()
        setResults({ term: active, rows: data.results ?? [] })
      } catch {
        setResults({ term: active, rows: [] })
      }
    }, 250)
    return () => clearTimeout(timer)
  }, [active, panelOpen])

  const rows = results && results.term === active ? results.rows : null

  function closeWalkIn() {
    setWalkIn(false)
    setCreated(null)
  }

  if (created) {
    return <CreatedPanel household={created} onDone={closeWalkIn} />
  }

  if (walkIn) {
    return <WalkInForm staffName={staffName} onCreated={setCreated} onCancel={closeWalkIn} />
  }

  if (selected) {
    return (
      <HouseholdPanel
        initial={selected}
        onClose={() => setSelected(null)}
        onUpdated={(h) => {
          setSelected(h)
          setResults((prev) =>
            prev ? { ...prev, rows: prev.rows.map((r) => (r.id === h.id ? h : r)) } : prev,
          )
        }}
      />
    )
  }

  return (
    <div className="space-y-4">
      <label htmlFor="desk-search" className="block text-lg font-black">
        Find a family
      </label>
      {/* min-height rather than extra padding: padding would collide with
          .field's own py-3 at equal specificity and win only by stylesheet order. */}
      <input
        id="desk-search"
        autoFocus
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Name, email, phone, or order #"
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        className="field min-h-[4.5rem] text-2xl font-semibold"
      />

      <button type="button" onClick={() => setWalkIn(true)} className="btn-gold w-full py-6 text-xl">
        + NEW WALK-IN
      </button>

      {active.length >= 2 && rows === null && (
        <p className="text-sm font-semibold text-black/50">Searching…</p>
      )}

      <div className="space-y-3">
        {rows?.map((h) => (
          <ResultRow key={h.id} household={h} onOpen={() => setSelected(h)} />
        ))}
      </div>

      {rows !== null && rows.length === 0 && (
        <div className="card text-center">
          <p className="text-lg font-bold">No match</p>
          <p className="mt-1 text-black/60">
            Try a shorter part of the name, or the last 4 digits of their phone. If they truly
            aren&apos;t here, use <strong>+ NEW WALK-IN</strong>.
          </p>
        </div>
      )}

      {active.length < 2 && (
        <p className="text-center text-sm text-black/50">
          Type at least 2 characters ·{' '}
          <Link href="/staff" className="underline">
            Back to menu
          </Link>
        </p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function ResultRow({ household, onOpen }: { household: Household; onOpen: () => void }) {
  const contact = [maskEmail(household.email), maskPhone(household.phone)].filter(Boolean)

  return (
    <button
      type="button"
      onClick={onOpen}
      className="w-full rounded-2xl border-2 border-black/10 bg-white p-4 text-left active:scale-[0.99]"
    >
      <span className="block text-xl font-bold break-words">{household.display_name}</span>
      {contact.length > 0 && (
        <span className="mt-1 block text-sm text-black/55">{contact.join(' · ')}</span>
      )}
      <span className="mt-2 block">
        <StatusPill status={household.payment_status} />
      </span>
      <span className="mt-2 block">
        <TicketCounts
          purchased={household.tickets_purchased}
          redeemed={household.tickets_redeemed}
          remaining={household.tickets_remaining}
          under6={household.children_under_6}
        />
      </span>
    </button>
  )
}

/* ------------------------------------------------------------------ */

function HouseholdPanel({
  initial,
  onClose,
  onUpdated,
}: {
  initial: Household
  onClose: () => void
  onUpdated: (h: Household) => void
}) {
  const id = initial.id
  const [household, setHousehold] = useState(initial)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const [tab, setTab] = useState<Tab | null>(null)
  const [reveal, setReveal] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const [done, setDone] = useState<string | null>(null)

  // The parent rebuilds onUpdated every render; holding it in a ref keeps it
  // out of the effect's dependencies without going stale.
  const notify = useRef(onUpdated)
  useEffect(() => {
    notify.current = onUpdated
  }, [onUpdated])

  // Search results are a snapshot. Re-reading on open (and after every change)
  // means the desk always acts on the live balance, not on what the list said
  // thirty seconds ago.
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const res = await fetch(`/api/staff/household/${id}`, { cache: 'no-store' })
        if (!res.ok) throw new Error('load failed')
        const data = (await res.json()) as { household: Household; history: HistoryItem[] }
        if (!live) return
        setHousehold(data.household)
        setHistory(data.history)
        setLoadError(false)
        notify.current(data.household)
      } catch {
        if (live) setLoadError(true)
      }
    })()
    return () => {
      live = false
    }
  }, [id, reloadKey])

  // Closing the sub-panel on success is not enough feedback on its own — the
  // banner says in words what just changed, and stays until the next action.
  function applyChange(h: Household, message: string) {
    setHousehold(h)
    onUpdated(h)
    setTab(null)
    setDone(message)
    setReloadKey((k) => k + 1)
  }

  function openTab(next: Tab) {
    setDone(null)
    setTab(toggle(tab, next))
  }

  return (
    <div className="space-y-4">
      <button type="button" onClick={onClose} className="btn-neutral w-full">
        ← Back to search
      </button>

      <div className="card border-2 border-[var(--green)]">
        <p className="text-2xl font-black break-words">{household.display_name}</p>

        <div className="mt-2">
          <StatusPill status={household.payment_status} />
        </div>

        <div className="mt-3">
          <TicketCounts
            purchased={household.tickets_purchased}
            redeemed={household.tickets_redeemed}
            remaining={household.tickets_remaining}
            under6={household.children_under_6}
          />
        </div>

        <div className="mt-3 text-sm text-black/60">
          {reveal ? (
            <p className="break-words">
              {household.email ?? 'No email'} · {household.phone ?? 'No phone'}
            </p>
          ) : (
            <p>
              {maskEmail(household.email) ?? 'No email'} ·{' '}
              {maskPhone(household.phone) ?? 'No phone'}
            </p>
          )}
          <button
            type="button"
            onClick={() => setReveal((v) => !v)}
            className="mt-1 underline"
          >
            {reveal ? 'Hide contact details' : 'Show full contact details'}
          </button>
        </div>

        {household.amount_paid_cents !== null && (
          <p className="mt-2 text-sm text-black/60">
            Paid {money(household.amount_paid_cents)}
            {household.payment_method ? ` by ${methodLabel(household.payment_method)}` : ''}
          </p>
        )}

        {!household.pass_enabled && (
          <p className="mt-3 rounded-xl bg-[var(--warn-bg)] px-3 py-2 text-sm font-bold text-[var(--warn)]">
            ! This pass is disabled and cannot be scanned.
          </p>
        )}

        {household.notes && (
          <p className="mt-3 rounded-xl bg-[var(--cream)] px-3 py-2 text-sm break-words">
            {household.notes}
          </p>
        )}
      </div>

      {loadError && (
        <p className="rounded-xl bg-[var(--danger-bg)] px-4 py-3 font-bold text-[var(--danger)]">
          ✕ Could not load the latest details. The numbers above may be out of date.
        </p>
      )}

      <div className="grid grid-cols-2 gap-3">
        <TabButton active={tab === 'pass'} onClick={() => setTab(toggle(tab, 'pass'))}>
          ▣ View pass
        </TabButton>
        <TabButton active={tab === 'payment'} onClick={() => setTab(toggle(tab, 'payment'))}>
          ＄ Payment
        </TabButton>
        <TabButton active={tab === 'tickets'} onClick={() => setTab(toggle(tab, 'tickets'))}>
          # Adjust tickets
        </TabButton>
        <TabButton active={tab === 'edit'} onClick={() => setTab(toggle(tab, 'edit'))}>
          ✎ Edit details
        </TabButton>
        <TabButton active={tab === 'history'} onClick={() => setTab(toggle(tab, 'history'))}>
          ⏱ History
        </TabButton>
      </div>

      {tab === 'pass' && <PassPanel householdId={household.id} />}
      {tab === 'payment' && <PaymentPanel household={household} onSaved={applyChange} />}
      {tab === 'tickets' && <TicketsPanel household={household} onSaved={applyChange} />}
      {tab === 'edit' && <EditPanel household={household} onSaved={applyChange} />}
      {tab === 'history' && <HistoryPanel items={history} />}
    </div>
  )
}

function toggle(current: Tab | null, next: Tab): Tab | null {
  return current === next ? null : next
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={active ? 'btn-primary text-base' : 'btn-neutral text-base'}
    >
      {children}
    </button>
  )
}

/* ------------------------------------------------------------------ */

function PassPanel({ householdId }: { householdId: string }) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ready'; dataUrl: string; url: string } | { kind: 'error' }
  >({ kind: 'loading' })

  useEffect(() => {
    let live = true
    ;(async () => {
      try {
        const res = await fetch(`/api/staff/household/${householdId}/pass`, { cache: 'no-store' })
        if (!res.ok) throw new Error('pass failed')
        const data = (await res.json()) as { dataUrl: string; url: string }
        if (live) setState({ kind: 'ready', ...data })
      } catch {
        if (live) setState({ kind: 'error' })
      }
    })()
    return () => {
      live = false
    }
  }, [householdId])

  if (state.kind === 'loading') return <div className="card text-center font-bold">Loading pass…</div>
  if (state.kind === 'error') {
    return (
      <div className="card text-center font-bold text-[var(--danger)]">
        ✕ Could not load this pass. Check the connection and try again.
      </div>
    )
  }

  return (
    <div className="card text-center">
      {/* Data URL from our own server; next/image would only add indirection. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={state.dataUrl}
        alt="Sadhya pass QR code"
        className="mx-auto w-full max-w-sm rounded-xl border border-black/10"
      />
      <p className="mt-3 font-bold">Hold this up for the scanner at the door.</p>
      <p className="mt-2 text-sm break-all text-black/50">{state.url}</p>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function EditPanel({
  household,
  onSaved,
}: {
  household: Household
  onSaved: (h: Household, message: string) => void
}) {
  const [name, setName] = useState(household.display_name)
  const [email, setEmail] = useState(household.email ?? '')
  const [phone, setPhone] = useState(household.phone ?? '')
  const [notes, setNotes] = useState(household.notes ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function save() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/staff/household/${household.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: name, email, phone, notes }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(
          data.error === 'INVALID'
            ? 'Check the name and email — the name needs at least 2 letters and the email must look like an address.'
            : 'Could not save. Try again.',
        )
        return
      }
      onSaved(data.household, 'Contact details updated.')
    } catch {
      setError('Could not reach the server. Nothing was saved.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="card space-y-3">
      <p className="text-lg font-black">Edit contact details</p>

      <Field label="Name">
        <input value={name} onChange={(e) => setName(e.target.value)} className="field" />
      </Field>
      <Field label="Email">
        <input
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          inputMode="email"
          autoCapitalize="none"
          autoCorrect="off"
          className="field"
        />
      </Field>
      <Field label="Phone">
        <input
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          inputMode="tel"
          className="field"
        />
      </Field>
      <Field label="Notes (staff only)">
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={2}
          className="field"
        />
      </Field>

      {error && <p className="font-bold text-[var(--danger)]">✕ {error}</p>}

      <button type="button" onClick={save} disabled={saving} className="btn-primary w-full">
        {saving ? 'Saving…' : 'Save details'}
      </button>
      <p className="text-center text-sm text-black/50">
        This does not change tickets or payment.
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function PaymentPanel({
  household,
  onSaved,
}: {
  household: Household
  onSaved: (h: Household, message: string) => void
}) {
  const [choice, setChoice] = useState<{ status: PaymentStatus; method?: PaymentMethod } | null>(
    null,
  )
  const [method, setMethod] = useState<PaymentMethod>(household.payment_method ?? 'cash')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function commit() {
    if (!choice) return
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/staff/household/${household.id}/payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status: choice.status,
          method: choice.method,
          // Clearing the amount alongside the status keeps the money column
          // honest when a payment is taken back.
          amountPaidCents: choice.status === 'unpaid' ? 0 : undefined,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError('Could not save. Nothing was changed.')
        return
      }
      onSaved(data.household, `Payment marked ${choice.status.replace('_', ' ')}.`)
    } catch {
      setError('Could not reach the server. Nothing was changed.')
    } finally {
      setSaving(false)
    }
  }

  if (choice) {
    return (
      <ConfirmChange
        title="Confirm payment change"
        from={statusWord(household.payment_status)}
        to={statusWord(choice.status)}
        note={
          choice.status === 'unpaid'
            ? `${household.display_name} will NOT be able to enter until this is marked paid again.`
            : `${household.display_name} will be able to use their ${household.tickets_remaining} remaining admission${household.tickets_remaining === 1 ? '' : 's'}.`
        }
        warn={choice.status === 'unpaid' && household.tickets_redeemed > 0}
        warnText={`This family has already used ${household.tickets_redeemed} admission${household.tickets_redeemed === 1 ? '' : 's'}.`}
        error={error}
        busy={saving}
        confirmLabel={saving ? 'Saving…' : 'YES, CHANGE IT'}
        onConfirm={commit}
        onCancel={() => setChoice(null)}
      />
    )
  }

  return (
    <div className="card space-y-3">
      <p className="text-lg font-black">Payment</p>
      <p className="text-black/60">
        Currently <strong>{statusWord(household.payment_status)}</strong>. Choose the new status —
        you&apos;ll confirm on the next screen.
      </p>

      <Field label="Payment method">
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value as PaymentMethod)}
          className="field"
        >
          {METHODS.map((m) => (
            <option key={m.value} value={m.value}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>

      <button
        type="button"
        onClick={() => setChoice({ status: 'paid', method })}
        className="btn-primary w-full py-5 text-lg"
      >
        ✓ MARK PAID
      </button>
      <button
        type="button"
        onClick={() => setChoice({ status: 'comped', method: 'complimentary' })}
        className="btn-gold w-full py-5 text-lg"
      >
        ★ MARK COMPED (free)
      </button>
      <button
        type="button"
        onClick={() => setChoice({ status: 'unpaid' })}
        className="btn-danger w-full py-5 text-lg"
      >
        ✕ MARK UNPAID
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function TicketsPanel({
  household,
  onSaved,
}: {
  household: Household
  onSaved: (h: Household, message: string) => void
}) {
  const [value, setValue] = useState(String(household.tickets_purchased))
  const [reason, setReason] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const next = Number(value)
  const valid =
    value !== '' &&
    Number.isInteger(next) &&
    next >= 0 &&
    next <= 50 &&
    next !== household.tickets_purchased &&
    reason.trim().length >= 3

  async function commit() {
    setSaving(true)
    setError(null)
    try {
      const res = await fetch(`/api/staff/household/${household.id}/tickets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newTotal: next, reason: reason.trim() }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(ticketError(data))
        setConfirming(false)
        return
      }
      onSaved(
        data.household,
        `Admissions changed from ${household.tickets_purchased} to ${next}.`,
      )
    } catch {
      setError('Could not reach the server. Nothing was changed.')
      setConfirming(false)
    } finally {
      setSaving(false)
    }
  }

  if (confirming) {
    return (
      <ConfirmChange
        title="Confirm ticket change"
        from={`${household.tickets_purchased} admission${household.tickets_purchased === 1 ? '' : 's'}`}
        to={`${next} admission${next === 1 ? '' : 's'}`}
        note={`Reason: ${reason.trim()}`}
        warn={next < household.tickets_purchased}
        warnText="You are REDUCING how many people this family can bring in."
        error={error}
        busy={saving}
        confirmLabel={saving ? 'Saving…' : 'YES, CHANGE IT'}
        onConfirm={commit}
        onCancel={() => setConfirming(false)}
      />
    )
  }

  return (
    <div className="card space-y-3">
      <p className="text-lg font-black">Adjust admissions</p>
      <p className="text-black/60">
        Currently <strong>{household.tickets_purchased}</strong> bought,{' '}
        <strong>{household.tickets_redeemed}</strong> already used. You cannot go below what has
        been used.
      </p>

      <Field label="New total admissions">
        <input
          inputMode="numeric"
          pattern="[0-9]*"
          value={value}
          onChange={(e) => setValue(e.target.value.replace(/\D/g, ''))}
          className="field text-2xl font-black"
        />
      </Field>

      <Field label="Reason (required)">
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="e.g. paid for 2 more at the desk"
          className="field"
        />
      </Field>

      {error && <p className="font-bold text-[var(--danger)]">✕ {error}</p>}

      <button
        type="button"
        disabled={!valid}
        onClick={() => {
          setError(null)
          setConfirming(true)
        }}
        className="btn-primary w-full"
      >
        Review change
      </button>
      <p className="text-center text-sm text-black/50">
        Nothing changes until you confirm on the next screen.
      </p>
    </div>
  )
}

function ticketError(data: Record<string, unknown>): string {
  switch (data.error) {
    case 'BELOW_REDEEMED':
      return `This family has already used ${data.tickets_redeemed} admissions. The new total cannot be lower than that.`
    case 'REASON_REQUIRED':
      return 'Type a short reason for the change.'
    case 'INVALID_QUANTITY':
      return 'Enter a whole number from 0 to 50.'
    case 'PASS_NOT_FOUND':
      return 'This family is no longer in the system. Go back and search again.'
    default:
      return 'Could not save. Nothing was changed.'
  }
}

/* ------------------------------------------------------------------ */

function ConfirmChange({
  title,
  from,
  to,
  note,
  warn,
  warnText,
  error,
  busy,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  title: string
  from: string
  to: string
  note?: string
  warn?: boolean
  warnText?: string
  error?: string | null
  busy: boolean
  confirmLabel: string
  onConfirm: () => void
  onCancel: () => void
}) {
  return (
    <div className="card border-4 border-[var(--gold)]">
      <p className="text-center text-lg font-black">{title}</p>

      <div className="mt-4 flex items-center justify-center gap-3 text-center">
        <span className="rounded-xl bg-black/5 px-4 py-3 text-xl font-black text-black/50 line-through">
          {from}
        </span>
        <span aria-hidden className="text-2xl font-black">
          →
        </span>
        <span className="rounded-xl bg-[var(--ok-bg)] px-4 py-3 text-xl font-black text-[var(--ok)]">
          {to}
        </span>
      </div>

      {note && <p className="mt-4 text-center font-semibold break-words">{note}</p>}

      {warn && (
        <p className="mt-4 rounded-xl bg-[var(--warn-bg)] px-4 py-3 text-center font-bold text-[var(--warn)]">
          ! {warnText}
        </p>
      )}

      {error && (
        <p className="mt-4 rounded-xl bg-[var(--danger-bg)] px-4 py-3 text-center font-bold text-[var(--danger)]">
          ✕ {error}
        </p>
      )}

      <button
        type="button"
        onClick={onConfirm}
        disabled={busy}
        className="btn-primary mt-5 w-full py-6 text-xl"
      >
        {confirmLabel}
      </button>
      <button type="button" onClick={onCancel} disabled={busy} className="btn-neutral mt-3 w-full">
        Cancel — change nothing
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function HistoryPanel({ items }: { items: HistoryItem[] }) {
  if (items.length === 0) {
    return <div className="card text-center text-black/60">Nothing has happened yet.</div>
  }

  return (
    <div className="card space-y-3">
      <p className="text-lg font-black">History</p>
      <ol className="space-y-3">
        {items.map((item) => (
          <li key={`${item.kind}-${item.id}`} className="border-b border-black/10 pb-3 last:border-0">
            <p className="font-bold break-words">{describe(item)}</p>
            <p className="mt-0.5 text-sm text-black/55">
              {when(item.at)}
              {item.staff ? ` · ${item.staff}` : ''}
            </p>
          </li>
        ))}
      </ol>
    </div>
  )
}

function describe(item: HistoryItem): string {
  switch (item.kind) {
    case 'redemption':
      return `${item.quantity} admitted${item.reversed ? ' (later reversed)' : ''}${
        item.device ? ` · ${item.device}` : ''
      }`
    case 'adjustment':
      return `${item.delta > 0 ? `${item.delta} admission${item.delta === 1 ? '' : 's'} put back` : `${-item.delta} removed`} — ${item.reason}`
    case 'audit':
      return auditText(item.action, item.metadata)
  }
}

function auditText(action: string, meta: Record<string, unknown>): string {
  switch (action) {
    case 'walk_in_created':
      return `Walk-in registered — ${meta.tickets} admission${meta.tickets === 1 ? '' : 's'}, ${String(meta.status ?? '').toUpperCase()}`
    case 'ticket_count_adjusted':
      return `Admissions changed from ${meta.from} to ${meta.to} — ${meta.reason}`
    case 'payment_status_changed':
      return `Payment changed from ${statusWord(meta.from as PaymentStatus)} to ${statusWord(meta.to as PaymentStatus)}`
    case 'contact_details_edited':
      return 'Contact details edited'
    default:
      // Unknown actions still have to read as something; the raw name beats a
      // blank line when a volunteer is trying to explain a discrepancy.
      return action.replace(/_/g, ' ')
  }
}

/* ------------------------------------------------------------------ */

function WalkInForm({
  staffName,
  onCreated,
  onCancel,
}: {
  staffName: string
  onCreated: (h: Household) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [method, setMethod] = useState<PaymentMethod>('cash')
  const [admissions, setAdmissions] = useState('')
  const [under6, setUnder6] = useState('')
  const [amount, setAmount] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const count = Number(admissions)
  const valid = name.trim().length >= 2 && admissions !== '' && count >= 1 && count <= 50

  async function submit(paid: boolean) {
    setSaving(true)
    setError(null)
    try {
      const dollars = Number(amount)
      const res = await fetch('/api/staff/household', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: name.trim(),
          email: email.trim(),
          phone: phone.trim(),
          ticketsPurchased: count,
          childrenUnder6: under6 === '' ? 0 : Number(under6),
          paymentMethod: method,
          amountPaidCents: amount === '' || !Number.isFinite(dollars) ? undefined : Math.round(dollars * 100),
          paid,
          notes: `Walk-in taken by ${staffName}`,
        }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(
          data.error === 'INVALID'
            ? 'Check the highlighted fields — a name and a number of admissions are required, and the email must look like an address.'
            : 'Could not save. Nothing was created.',
        )
        return
      }
      onCreated(data.household)
    } catch {
      setError('Could not reach the server. Nothing was created.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <button type="button" onClick={onCancel} className="btn-neutral w-full">
        ← Back to search
      </button>

      <div className="card space-y-3">
        <p className="text-xl font-black">New walk-in</p>

        <Field label="Name *">
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Family or guest name"
            className="field text-lg"
          />
        </Field>

        <Field label="Email">
          <input
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            inputMode="email"
            autoCapitalize="none"
            autoCorrect="off"
            placeholder="Optional"
            className="field"
          />
        </Field>

        <Field label="Phone">
          <input
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            inputMode="tel"
            placeholder="Optional"
            className="field"
          />
        </Field>

        <Field label="Payment method *">
          <select
            value={method}
            onChange={(e) => setMethod(e.target.value as PaymentMethod)}
            className="field"
          >
            {METHODS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </Field>

        <Field label="Number of admissions *">
          <input
            inputMode="numeric"
            pattern="[0-9]*"
            value={admissions}
            onChange={(e) => setAdmissions(e.target.value.replace(/\D/g, ''))}
            placeholder="How many people are eating"
            className="field text-2xl font-black"
          />
        </Field>

        <Field label="Children under 6">
          <input
            inputMode="numeric"
            pattern="[0-9]*"
            value={under6}
            onChange={(e) => setUnder6(e.target.value.replace(/\D/g, ''))}
            placeholder="0"
            className="field text-2xl font-black"
          />
          <p className="mt-1 rounded-xl bg-[var(--cream)] px-3 py-2 text-sm font-semibold">
            Children under 6 enter free — no ticket needed. Do not count them in the admissions
            above.
          </p>
        </Field>

        <Field label="Amount paid">
          <div className="flex items-center gap-2">
            <span className="text-xl font-black">$</span>
            <input
              inputMode="decimal"
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ''))}
              placeholder="0.00"
              className="field text-lg"
            />
          </div>
        </Field>

        {error && (
          <p className="rounded-xl bg-[var(--danger-bg)] px-4 py-3 font-bold text-[var(--danger)]">
            ✕ {error}
          </p>
        )}

        <button
          type="button"
          disabled={!valid || saving}
          onClick={() => submit(true)}
          className="btn-primary w-full py-6 text-lg"
        >
          {saving ? 'Saving…' : '✓ PAYMENT RECEIVED — CREATE PASS'}
        </button>

        <button
          type="button"
          disabled={!valid || saving}
          onClick={() => submit(false)}
          className="btn-neutral w-full"
        >
          Save without payment (they cannot enter yet)
        </button>

        <p className="text-center text-sm text-black/50">
          Only tap the green button once the cash, Zelle, or card payment is actually in hand.
        </p>
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function CreatedPanel({ household, onDone }: { household: Household; onDone: () => void }) {
  const paid = household.payment_status === 'paid' || household.payment_status === 'comped'

  return (
    <div className="space-y-4">
      <div
        className={`rounded-2xl p-7 text-center text-white ${
          paid ? 'bg-[var(--ok)]' : 'bg-[var(--warn)]'
        }`}
      >
        <p className="text-5xl font-black">{paid ? '✅' : '!'}</p>
        <p className="mt-2 text-3xl font-black">
          {paid ? 'PAYMENT CONFIRMED' : 'SAVED — NOT PAID'}
        </p>
        <p className="mt-2 text-lg font-semibold break-words">{household.display_name}</p>
        <p className="mt-3 text-2xl font-black tabular-nums">
          {household.tickets_purchased} ADMISSION{household.tickets_purchased === 1 ? '' : 'S'}
        </p>
        {household.children_under_6 > 0 && (
          <p className="mt-1 font-semibold">
            + {household.children_under_6} under 6, free — no ticket needed
          </p>
        )}
      </div>

      {paid ? (
        <PassPanel householdId={household.id} />
      ) : (
        <div className="card text-center font-semibold">
          No pass yet. Find this family in search and mark them paid once payment is in hand.
        </div>
      )}

      <button type="button" onClick={onDone} className="btn-primary w-full py-6 text-xl">
        Done — next guest
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block font-bold">{label}</span>
      {children}
    </label>
  )
}

function maskEmail(email: string | null): string | null {
  if (!email) return null
  const [user, domain] = email.split('@')
  if (!domain) return '•••'
  return `${user.slice(0, 1)}•••@${domain}`
}

function maskPhone(phone: string | null): string | null {
  if (!phone) return null
  const digits = phone.replace(/\D/g, '')
  if (digits.length < 4) return '•••'
  return `•••-•••-${digits.slice(-4)}`
}

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function methodLabel(method: PaymentMethod): string {
  return METHODS.find((m) => m.value === method)?.label ?? method
}

function statusWord(status: PaymentStatus): string {
  switch (status) {
    case 'paid':
      return 'PAID'
    case 'comped':
      return 'COMPED'
    case 'unpaid':
      return 'UNPAID'
    case 'pending':
      return 'PENDING'
    case 'refunded':
      return 'REFUNDED'
    case 'partially_refunded':
      return 'PARTLY REFUNDED'
    default:
      return 'NEEDS REVIEW'
  }
}

function when(at: string): string {
  const d = new Date(at)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}
