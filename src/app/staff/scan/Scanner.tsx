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
  | { kind: 'success'; name: string; redeemed: number; remaining: number }
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

  // Auto-dismiss result screens back to scanning.
  useEffect(() => {
    if (phase.kind !== 'success' && phase.kind !== 'failure') return
    timerRef.current = setTimeout(
      () => setPhase({ kind: 'scanning' }),
      phase.kind === 'success' ? SUCCESS_MS : FAILURE_MS,
    )
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [phase])

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

function RedeemPanel({
  household,
  onChoose,
  onCancel,
}: {
  household: Household
  onChoose: (quantity: number) => void
  onCancel: () => void
}) {
  const [custom, setCustom] = useState('')
  const remaining = household.tickets_remaining
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
        <button type="button" onClick={onCancel} className="btn-neutral mt-5 w-full">
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

      <button type="button" onClick={onCancel} className="btn-neutral mt-4 w-full">
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
