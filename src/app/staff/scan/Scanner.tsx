'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import { useQrScanner } from '@/hooks/useQrScanner'
import type { Household } from '@/lib/households'
import { StatusPill } from '@/components/StatusPill'

type Phase =
  | { kind: 'scanning' }
  | { kind: 'looking-up' }
  | { kind: 'found'; household: Household }
  | { kind: 'redeeming'; household: Household; quantity: number }
  | {
      kind: 'success'
      name: string
      redeemed: number
      remaining: number
      redemptionId?: string
    }
  | { kind: 'returned'; name: string; restored: number; remaining: number }
  | { kind: 'failure'; title: string; detail?: string }

const SUCCESS_MS = 2600
const FAILURE_MS = 5000

export function Scanner({ staffName }: { staffName: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'scanning' })
  const [manualOpen, setManualOpen] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The camera keeps running underneath, but reporting is suspended whenever a
  // panel is up — so a QR left in frame can't re-trigger anything.
  const paused = phase.kind !== 'scanning'

  const lookup = useCallback(async (scanned: string) => {
    setPhase({ kind: 'looking-up' })
    try {
      const res = await fetch(`/api/staff/lookup?token=${encodeURIComponent(scanned)}`, {
        cache: 'no-store',
      })
      if (res.status === 404) {
        setPhase({
          kind: 'failure',
          title: 'PASS NOT VALID',
          detail: 'This code is not a Sadhya pass. Send them to the registration desk.',
        })
        return
      }
      if (!res.ok) throw new Error('lookup failed')
      const { household } = (await res.json()) as { household: Household }
      setPhase({ kind: 'found', household })
    } catch {
      setPhase({
        kind: 'failure',
        title: 'CONNECTION PROBLEM',
        detail: 'Could not reach the server. Do not admit anyone yet — try again.',
      })
    }
  }, [])

  const { videoRef, state, message, start, stop } = useQrScanner({ onScan: lookup, paused })

  // Auto-dismiss result screens back to scanning. The success screen waits
  // longer than it needs to read, because that pause is the only window the
  // volunteer has to notice a wrong number and tap Give back.
  useEffect(() => {
    if (phase.kind !== 'success' && phase.kind !== 'failure' && phase.kind !== 'returned') return
    timerRef.current = setTimeout(
      () => setPhase({ kind: 'scanning' }),
      phase.kind === 'failure' ? FAILURE_MS : SUCCESS_MS,
    )
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [phase])

  /** Give back admissions used earlier — the family is known, the scan isn't. */
  async function giveBackForHousehold(household: Household, quantity: number) {
    await postGiveBack({ householdId: household.id, quantity }, household.display_name)
  }

  async function giveBack(redemptionId: string, quantity: number, name: string) {
    await postGiveBack({ redemptionId, quantity }, name)
  }

  async function postGiveBack(body: Record<string, unknown>, name: string) {
    if (timerRef.current) clearTimeout(timerRef.current)
    try {
      const res = await fetch('/api/staff/reverse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (data.success) {
        buzz([40, 60, 40])
        setPhase({
          kind: 'returned',
          name: data.display_name ?? name,
          restored: data.restored,
          remaining: data.tickets_remaining,
        })
        return
      }
      setPhase({
        kind: 'failure',
        title: 'COULD NOT GIVE BACK',
        detail:
          (data.detail as string) ??
          'The admissions were NOT returned. Send them to registration.',
      })
    } catch {
      setPhase({
        kind: 'failure',
        title: 'CONNECTION PROBLEM',
        detail: 'The admissions were NOT returned. Check signal and try again.',
      })
    }
  }

  async function redeem(household: Household, quantity: number) {
    setPhase({ kind: 'redeeming', household, quantity })
    try {
      const res = await fetch('/api/staff/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ householdId: household.id, quantity, device: staffName }),
      })
      const data = await res.json()

      if (data.success) {
        buzz([40, 60, 40])
        setPhase({
          kind: 'success',
          name: data.display_name ?? household.display_name,
          redeemed: data.redeemed_now,
          remaining: data.tickets_remaining,
          redemptionId: data.redemption_id,
        })
        return
      }

      buzz([200])
      setPhase({ kind: 'failure', ...describeFailure(data) })
    } catch {
      buzz([200])
      setPhase({
        kind: 'failure',
        title: 'CONNECTION PROBLEM',
        detail: 'Nothing was redeemed. Check signal and scan again.',
      })
    }
  }

  return (
    <div className="space-y-4">
      {/* ---------------- camera ---------------- */}
      <div className="relative overflow-hidden rounded-2xl bg-black">
        <video
          ref={videoRef}
          muted
          playsInline
          className="aspect-[3/4] w-full object-cover sm:aspect-video"
        />
        <div id="qr-fallback-region" className="absolute inset-0" />

        {state === 'running' && phase.kind === 'scanning' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-56 w-56 rounded-2xl border-4 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
        )}

        {state !== 'running' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 p-6 text-center text-white">
            {state === 'denied' ? (
              <>
                <p className="text-xl font-black">Camera blocked</p>
                <p className="text-sm text-white/80">
                  Allow camera access in your browser settings, then reload. You can still use
                  manual search below.
                </p>
              </>
            ) : state === 'error' ? (
              <>
                <p className="text-xl font-black">Camera unavailable</p>
                <p className="text-sm text-white/80">{message}</p>
                <p className="text-sm text-white/80">Use manual search below.</p>
              </>
            ) : (
              <button type="button" onClick={start} className="btn-gold px-8 py-6 text-xl">
                📷 Open camera
              </button>
            )}
          </div>
        )}
      </div>

      {/* ---------------- panels ---------------- */}
      {phase.kind === 'looking-up' && (
        <div className="card text-center text-lg font-bold">Looking up pass…</div>
      )}

      {phase.kind === 'found' && (
        <RedeemPanel
          household={phase.household}
          onCancel={() => setPhase({ kind: 'scanning' })}
          onChoose={(q) => redeem(phase.household, q)}
          onGiveBack={(q) => giveBackForHousehold(phase.household, q)}
        />
      )}

      {phase.kind === 'redeeming' && (
        <div className="card text-center">
          <p className="text-lg font-bold">
            Redeeming {phase.quantity}
            {'…'}
          </p>
          <p className="text-sm text-black/60">Wait for the green screen.</p>
        </div>
      )}

      {phase.kind === 'success' && (
        <div className="rounded-2xl bg-[var(--ok)] p-7 text-center text-white">
          <p className="text-5xl font-black">✓</p>
          <p className="mt-2 text-3xl font-black">
            {phase.redeemed} ADMITTED
          </p>
          <p className="mt-1 text-lg font-semibold">{phase.name}</p>
          <p className="mt-4 text-2xl font-black tabular-nums">
            {phase.remaining} REMAINING
          </p>

          <button
            type="button"
            onClick={() => setPhase({ kind: 'scanning' })}
            className="btn mt-5 w-full bg-white/20 text-white"
          >
            Scan next
          </button>

          {/* Tapped the wrong number? Fix it here rather than sending the
              family to registration with a queue behind them. */}
          {phase.redemptionId && (
            <GiveBack
              max={phase.redeemed}
              onGiveBack={(n) => giveBack(phase.redemptionId!, n, phase.name)}
            />
          )}
        </div>
      )}

      {phase.kind === 'returned' && (
        <div className="rounded-2xl bg-[var(--gold-deep)] p-7 text-center text-white">
          <p className="text-5xl font-black">↩</p>
          <p className="mt-2 text-3xl font-black">{phase.restored} GIVEN BACK</p>
          <p className="mt-1 text-lg font-semibold">{phase.name}</p>
          <p className="mt-4 text-2xl font-black tabular-nums">{phase.remaining} REMAINING</p>
          <button
            type="button"
            onClick={() => setPhase({ kind: 'scanning' })}
            className="btn mt-5 w-full bg-white/20 text-white"
          >
            Scan next
          </button>
        </div>
      )}

      {phase.kind === 'failure' && (
        <div className="rounded-2xl border-4 border-[var(--danger)] bg-[var(--danger-bg)] p-7 text-center">
          <p className="text-5xl font-black text-[var(--danger)]">✕</p>
          <p className="mt-2 text-2xl font-black text-[var(--danger)]">{phase.title}</p>
          {phase.detail && <p className="mt-2 font-semibold">{phase.detail}</p>}
          <button
            type="button"
            onClick={() => setPhase({ kind: 'scanning' })}
            className="btn-neutral mt-5 w-full"
          >
            Back to scanner
          </button>
        </div>
      )}

      {/* ---------------- manual fallback ---------------- */}
      {phase.kind === 'scanning' && (
        <div>
          <button
            type="button"
            onClick={() => setManualOpen((v) => !v)}
            className="btn-neutral w-full"
          >
            🔎 {manualOpen ? 'Hide manual search' : 'Search manually'}
          </button>
          {manualOpen && <ManualSearch onPick={(h) => setPhase({ kind: 'found', household: h })} />}
          {state === 'running' && (
            <button type="button" onClick={stop} className="mt-3 w-full text-sm text-black/50">
              Turn camera off
            </button>
          )}
          <p className="mt-4 text-center text-xs text-black/45">
            <Link href="/staff" className="underline">
              Back to menu
            </Link>
          </p>
        </div>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * Undo control on the success screen.
 *
 * Collapsed by default: the overwhelmingly common case is that the number was
 * right, and an always-open row of buttons next to "2 ADMITTED" invites a
 * mis-tap that would put tickets back by accident.
 */
function GiveBack({ max, onGiveBack }: { max: number; onGiveBack: (n: number) => void }) {
  const [open, setOpen] = useState(false)

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="mt-3 w-full py-3 text-sm font-semibold text-white/80 underline"
      >
        ↩ Wrong number? Give tickets back
      </button>
    )
  }

  return (
    <div className="mt-4 rounded-xl bg-white/15 p-4">
      <p className="font-bold">How many to give back?</p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {Array.from({ length: max }, (_, i) => i + 1).map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onGiveBack(n)}
            className="btn bg-white py-5 text-2xl text-[var(--foreground)]"
          >
            {n}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="mt-3 w-full py-2 text-sm font-semibold text-white/80 underline"
      >
        Cancel
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function RedeemPanel({
  household,
  onChoose,
  onGiveBack,
  onCancel,
}: {
  household: Household
  onChoose: (quantity: number) => void
  onGiveBack: (quantity: number) => void
  onCancel: () => void
}) {
  const [custom, setCustom] = useState('')
  const remaining = household.tickets_remaining
  const used = household.tickets_redeemed
  const usable =
    household.pass_enabled &&
    (household.payment_status === 'paid' || household.payment_status === 'comped')

  if (!usable || remaining <= 0) {
    return (
      <div className="rounded-2xl border-4 border-[var(--danger)] bg-[var(--danger-bg)] p-6 text-center">
        <p className="text-xl font-black">{household.display_name}</p>
        <div className="mt-2 flex justify-center">
          <StatusPill status={household.payment_status} />
        </div>
        <p className="mt-4 text-2xl font-black text-[var(--danger)]">
          {remaining <= 0 ? 'NO TICKETS REMAINING' : 'PASS NOT VALID'}
        </p>
        <p className="mt-2 font-semibold">
          {remaining <= 0
            ? `All ${household.tickets_purchased} admissions have already been used.`
            : 'Send them to the registration desk.'}
        </p>

        {/* A fully-used pass is exactly when an over-count shows up — someone
            arrives, finds nothing left, and says they only ate twice. Fixing it
            here beats sending them to find an admin. */}
        {used > 0 && (
          <GiveBackSection
            max={used}
            tone="light"
            label="Counted wrong earlier? Give tickets back"
            onGiveBack={onGiveBack}
          />
        )}

        <button type="button" onClick={onCancel} className="btn-neutral mt-4 w-full">
          Back to scanner
        </button>
      </div>
    )
  }

  // Never offer a button that would fail. Buttons are capped at remaining.
  const quickMax = Math.min(remaining, 6)
  const quick = Array.from({ length: quickMax }, (_, i) => i + 1)

  return (
    <div className="card border-2 border-[var(--green)]">
      <p className="text-2xl font-black break-words">{household.display_name}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <StatusPill status={household.payment_status} />
        <span className="text-sm text-black/60">
          {household.tickets_purchased} bought · {household.tickets_redeemed} used
        </span>
      </div>

      <p className="mt-4 text-center text-5xl font-black tabular-nums text-[var(--green-deep)]">
        {remaining}
      </p>
      <p className="text-center font-bold">REMAINING</p>

      <p className="mt-6 text-center text-lg font-black">HOW MANY ARE ENTERING?</p>

      <div className="mt-3 grid grid-cols-3 gap-3">
        {quick.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => onChoose(n)}
            className="btn-primary py-7 text-3xl"
          >
            {n}
          </button>
        ))}
      </div>

      {remaining > quickMax && (
        <div className="mt-4 flex gap-2">
          <input
            inputMode="numeric"
            pattern="[0-9]*"
            value={custom}
            onChange={(e) => setCustom(e.target.value.replace(/\D/g, ''))}
            placeholder={`Other (up to ${remaining})`}
            className="field"
          />
          <button
            type="button"
            disabled={!custom || Number(custom) < 1 || Number(custom) > remaining}
            onClick={() => onChoose(Number(custom))}
            className="btn-primary px-6"
          >
            Go
          </button>
        </div>
      )}

      {/* Only offered once something has actually been used, so the normal
          scan-and-go path stays a single row of numbers. */}
      {used > 0 && (
        <GiveBackSection
          max={used}
          tone="dark"
          label={`Counted wrong earlier? Give back (${used} used)`}
          onGiveBack={onGiveBack}
        />
      )}

      <button type="button" onClick={onCancel} className="btn-neutral mt-4 w-full">
        Cancel
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * Collapsed give-back control.
 *
 * Kept behind a tap on purpose: putting "give back" buttons next to "how many
 * are entering" would put two opposite actions a thumb's width apart, and the
 * wrong one hands out free meals.
 */
function GiveBackSection({
  max,
  label,
  tone,
  onGiveBack,
}: {
  max: number
  label: string
  tone: 'light' | 'dark'
  onGiveBack: (quantity: number) => void
}) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState<number | null>(null)

  const linkClass =
    tone === 'dark'
      ? 'text-[var(--gold-deep)]'
      : 'text-[var(--danger)]'

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`mt-4 w-full py-3 text-sm font-bold underline ${linkClass}`}
      >
        ↩ {label}
      </button>
    )
  }

  if (confirm !== null) {
    return (
      <div className="mt-4 rounded-xl border-2 border-[var(--gold)] bg-[var(--cream)] p-4 text-center">
        <p className="text-lg font-black">
          Give back {confirm} admission{confirm === 1 ? '' : 's'}?
        </p>
        <p className="mt-1 text-sm text-black/70">
          They&apos;ll be able to eat {confirm} more time{confirm === 1 ? '' : 's'}.
        </p>
        <div className="mt-4 grid grid-cols-2 gap-3">
          <button type="button" onClick={() => onGiveBack(confirm)} className="btn-gold">
            Yes, give back
          </button>
          <button type="button" onClick={() => setConfirm(null)} className="btn-neutral">
            No
          </button>
        </div>
      </div>
    )
  }

  const quick = Array.from({ length: Math.min(max, 6) }, (_, i) => i + 1)

  return (
    <div className="mt-4 rounded-xl border-2 border-[var(--gold)] bg-[var(--cream)] p-4">
      <p className="text-center font-black">How many to give back?</p>
      <p className="mt-1 text-center text-sm text-black/60">{max} used so far</p>
      <div className="mt-3 grid grid-cols-3 gap-2">
        {quick.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setConfirm(n)}
            className="btn border-2 border-[var(--gold)] bg-white py-5 text-2xl"
          >
            {n}
          </button>
        ))}
      </div>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="mt-3 w-full py-2 text-sm font-semibold underline"
      >
        Cancel
      </button>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function ManualSearch({ onPick }: { onPick: (h: Household) => void }) {
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<Household[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (term.trim().length < 2) {
      setResults([])
      return
    }
    const id = setTimeout(async () => {
      setBusy(true)
      try {
        const res = await fetch(`/api/staff/lookup?q=${encodeURIComponent(term)}`, {
          cache: 'no-store',
        })
        const data = await res.json()
        setResults(data.results ?? [])
      } catch {
        setResults([])
      } finally {
        setBusy(false)
      }
    }, 250)
    return () => clearTimeout(id)
  }, [term])

  return (
    <div className="mt-3 space-y-3">
      <input
        autoFocus
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Name, email, or phone"
        className="field text-lg"
      />
      {busy && <p className="text-sm text-black/50">Searching…</p>}
      {results.map((h) => (
        <button
          key={h.id}
          type="button"
          onClick={() => onPick(h)}
          className="w-full rounded-xl border-2 border-black/10 bg-white p-4 text-left active:scale-[0.99]"
        >
          <span className="block text-lg font-bold">{h.display_name}</span>
          <span className="mt-1 flex flex-wrap items-center gap-2">
            <StatusPill status={h.payment_status} />
            <span className="text-sm text-black/60 tabular-nums">
              {h.tickets_remaining} of {h.tickets_purchased} left
            </span>
          </span>
        </button>
      ))}
      {!busy && term.trim().length >= 2 && results.length === 0 && (
        <p className="text-sm text-black/60">No match. Try a shorter part of the name.</p>
      )}
    </div>
  )
}

/* ------------------------------------------------------------------ */

function describeFailure(data: Record<string, unknown>): { title: string; detail?: string } {
  switch (data.error) {
    case 'INSUFFICIENT_TICKETS':
      return {
        title: `ONLY ${data.tickets_remaining} REMAINING`,
        detail: `You asked for ${data.requested}. Nothing was redeemed — scan again and choose ${data.tickets_remaining} or fewer.`,
      }
    case 'NOT_PAID':
      return { title: 'NOT PAID', detail: 'Send them to the registration desk to pay.' }
    case 'PASS_DISABLED':
      return { title: 'PASS DISABLED', detail: 'Send them to the registration desk.' }
    case 'PASS_NOT_FOUND':
      return { title: 'PASS NOT VALID', detail: 'Send them to the registration desk.' }
    case 'INVALID_QUANTITY':
      return { title: 'INVALID NUMBER', detail: 'Nothing was redeemed. Try again.' }
    case 'UNAUTHORIZED':
      return { title: 'SIGNED OUT', detail: 'Sign in again to keep scanning.' }
    default:
      return { title: 'SOMETHING WENT WRONG', detail: 'Nothing was redeemed. Try again.' }
  }
}

function buzz(pattern: number[]) {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    /* unsupported — visual feedback is the primary channel anyway */
  }
}
