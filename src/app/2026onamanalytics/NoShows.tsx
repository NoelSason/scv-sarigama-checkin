'use client'

import { useMemo, useState, useTransition } from 'react'
import type { NoShow } from '@/lib/analytics/types'

/*
 * Who bought a seat that no scan ever accounted for — and the correction for
 * the ones who ate anyway.
 *
 * Near the end of service the line moved faster than the scanner and families
 * were waved through un-checked-in. That is a gap in the record, not a gap in
 * the room, and only a human who was there can say which name is which.
 *
 * Marking somebody present adds them to the headcount and to nothing else. It
 * never becomes a scan, never touches the redemption ledger, and never appears
 * on any chart with a clock on it, because nobody observed when they walked in.
 * Inventing an arrival time would corrupt the one set of numbers the day can
 * still be measured by.
 */

/** Placeholder names from an order that arrived without one. */
function readableName(name: string): { label: string; muted: boolean } {
  if (/^Square order /i.test(name)) return { label: 'Square order, no name given', muted: true }
  if (/^[^@\s]+@[^@\s]+$/.test(name)) return { label: name, muted: true }
  return { label: name, muted: false }
}

const SOURCE_WORD: Record<string, string> = {
  square: 'Square',
  google_sheets: 'Zelle',
  walk_in: 'Walk-up',
  stripe: 'Storefront',
}

export function NoShows({
  rows,
  onChanged,
}: {
  rows: NoShow[]
  onChanged: () => void
}) {
  const [marks, setMarks] = useState<Record<string, number>>(() =>
    Object.fromEntries(rows.map((r) => [r.id, r.markedPresent])),
  )
  const [drafts, setDrafts] = useState<Record<string, number>>(() =>
    Object.fromEntries(rows.map((r) => [r.id, r.markedPresent || r.missing])),
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmAll, setConfirmAll] = useState(false)
  const [, startTransition] = useTransition()

  const totals = useMemo(() => {
    const missing = rows.reduce((s, r) => s + r.missing, 0)
    const marked = rows.reduce((s, r) => s + (marks[r.id] ?? 0), 0)
    const households = rows.filter((r) => (marks[r.id] ?? 0) > 0).length
    return { missing, marked, households, stillMissing: missing - marked }
  }, [rows, marks])

  async function save(id: string, quantity: number) {
    setBusy(id)
    setError(null)
    try {
      const res = await fetch('/api/analytics/attendance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ householdId: id, quantity }),
      })
      if (!res.ok) throw new Error('save failed')
      setMarks((m) => ({ ...m, [id]: quantity }))
      startTransition(onChanged)
    } catch {
      setError('That did not save. Check the connection and try again.')
    } finally {
      setBusy(null)
    }
  }

  async function markEveryone() {
    setConfirmAll(false)
    for (const row of rows) {
      if ((marks[row.id] ?? 0) === row.missing) continue
      await save(row.id, row.missing)
    }
  }

  if (!rows.length) {
    return (
      <p className="text-[15px] text-black/70">
        Every admission sold was scanned in. Nothing unaccounted for.
      </p>
    )
  }

  return (
    <div>
      <div className="grid grid-cols-3 gap-3">
        <Tile label="Not scanned in" value={totals.missing} />
        <Tile label="Marked present" value={totals.marked} tone="ok" />
        <Tile label="Still missing" value={totals.stillMissing} tone="warn" />
      </div>

      <p className="mt-3 text-[15px] leading-relaxed text-black/70">
        {totals.missing} admissions across {rows.length} families were paid for but never scanned.
        Some of those people ate — the line outran the scanner near the end — and some genuinely did
        not come. Marking a family present adds them to the headcount and to the money-per-guest
        figures. It is deliberately kept out of every chart with a clock on it, because there is no
        record of when they walked in.
      </p>

      {error && (
        <p className="mt-3 rounded-xl border-2 border-[var(--danger)] bg-[var(--danger-bg)] p-3 font-semibold text-[var(--danger)]">
          {error}
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {confirmAll ? (
          <>
            <button type="button" onClick={markEveryone} className="btn-primary">
              Yes — mark all {totals.missing} present
            </button>
            <button type="button" onClick={() => setConfirmAll(false)} className="btn-neutral">
              Cancel
            </button>
          </>
        ) : (
          <button type="button" onClick={() => setConfirmAll(true)} className="btn-neutral">
            Mark everyone on this list present
          </button>
        )}
      </div>

      <ul className="mt-4 space-y-2">
        {rows.map((row) => {
          const marked = marks[row.id] ?? 0
          const draft = Math.min(row.missing, Math.max(0, drafts[row.id] ?? row.missing))
          const name = readableName(row.name)
          const isBusy = busy === row.id

          return (
            <li
              key={row.id}
              className="rounded-xl border-2 p-3"
              style={{
                borderColor: marked > 0 ? 'var(--ok)' : 'var(--line)',
                background: marked > 0 ? 'var(--ok-bg)' : 'var(--card)',
              }}
            >
              <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span
                  className={`font-bold ${name.muted ? 'italic text-black/55' : ''}`}
                >
                  {name.label}
                </span>
                <span className="text-sm text-black/55">
                  {row.missing} of {row.purchased} not scanned
                  {row.scannedIn > 0 && ` · ${row.scannedIn} were`}
                </span>
                {row.source && (
                  <span className="pill bg-[var(--cream)] text-xs text-[var(--gold-deep)]">
                    {SOURCE_WORD[row.source] ?? row.source}
                  </span>
                )}
              </div>

              {row.source === 'walk_in' && (
                <p className="mt-1 text-sm text-black/55">
                  Bought a seat at the desk during the Sadhya — they were in the room.
                </p>
              )}

              {marked > 0 ? (
                <div className="mt-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-bold text-[var(--ok)]">
                      ✓ {marked} marked present — counted in the headcount
                    </span>
                    <button
                      type="button"
                      disabled={isBusy}
                      onClick={() => save(row.id, 0)}
                      className="rounded-lg px-2 py-1 text-sm font-semibold underline decoration-dotted disabled:opacity-40"
                    >
                      Undo
                    </button>
                  </div>
                  {row.markedNote && (
                    <p className="mt-1 text-sm italic text-black/55">{row.markedNote}</p>
                  )}
                </div>
              ) : (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  {row.missing > 1 && (
                    <span className="inline-flex items-center gap-1 rounded-lg border-2 border-[var(--line-strong)] bg-white">
                      <Step
                        label="one fewer"
                        symbol="−"
                        disabled={draft <= 1}
                        onClick={() => setDrafts((d) => ({ ...d, [row.id]: draft - 1 }))}
                      />
                      <span className="min-w-8 text-center text-lg font-bold tabular-nums">
                        {draft}
                      </span>
                      <Step
                        label="one more"
                        symbol="+"
                        disabled={draft >= row.missing}
                        onClick={() => setDrafts((d) => ({ ...d, [row.id]: draft + 1 }))}
                      />
                    </span>
                  )}
                  <button
                    type="button"
                    disabled={isBusy || draft < 1}
                    onClick={() => save(row.id, draft)}
                    className="btn-primary min-h-11 px-4 py-2 text-sm"
                  >
                    {isBusy
                      ? 'Saving…'
                      : row.missing === 1
                        ? 'Mark present'
                        : `Mark ${draft} present`}
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Step({
  label,
  symbol,
  disabled,
  onClick,
}: {
  label: string
  symbol: string
  disabled: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
      className="min-h-11 px-3 text-xl font-bold disabled:opacity-30"
    >
      {symbol}
    </button>
  )
}

function Tile({
  label,
  value,
  tone,
}: {
  label: string
  value: number
  tone?: 'ok' | 'warn'
}) {
  const color =
    tone === 'ok' ? 'var(--ok)' : tone === 'warn' ? 'var(--warn)' : 'var(--foreground)'
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--cream)] p-3">
      <div className="display text-2xl leading-7 tabular-nums" style={{ color }}>
        {value}
      </div>
      <div className="text-xs font-semibold uppercase tracking-wide text-black/55">{label}</div>
    </div>
  )
}
