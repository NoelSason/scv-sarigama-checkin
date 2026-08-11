'use client'

import { useEffect, useRef, useState } from 'react'
import Link from 'next/link'
import type { Household } from '@/lib/households'
import type { AdminStats, OpsItem, OpsState } from './stats'
import { StatusPill } from '@/components/StatusPill'
import { HouseholdPanel } from './HouseholdPanel'
import { ago, clock, humanize } from './format'

const POLL_MS = 20_000

export function AdminDashboard({ initial }: { initial: AdminStats }) {
  const [stats, setStats] = useState(initial)
  const [stale, setStale] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const refresh = useRef<() => void>(() => {})

  useEffect(() => {
    let alive = true

    async function pull() {
      try {
        const res = await fetch('/api/staff/admin/stats', { cache: 'no-store' })
        if (!res.ok) throw new Error('stats failed')
        const data = (await res.json()) as AdminStats
        if (!alive) return
        setStats(data)
        setStale(false)
      } catch {
        // Keep the last good numbers on screen and say plainly that they are
        // old. Blanking the dashboard mid-event would be worse than stale data.
        if (alive) setStale(true)
      }
    }

    refresh.current = pull
    const id = setInterval(pull, POLL_MS)
    return () => {
      alive = false
      clearInterval(id)
    }
  }, [])

  const t = stats.totals

  return (
    <div className="space-y-6">
      {/* ---------------- emergency lookup: first thing on the page ---------------- */}
      <EmergencyLookup
        selected={selected}
        onSelect={setSelected}
        onChanged={() => refresh.current()}
      />

      {/* One panel, always in the same place, whether the household was found by
          search or tapped in a list below. */}
      {selected && (
        <HouseholdPanel
          key={selected}
          householdId={selected}
          onClose={() => setSelected(null)}
          onChanged={() => refresh.current()}
        />
      )}

      {/* ---------------- operational status ---------------- */}
      <section>
        <div className="flex flex-wrap items-baseline gap-x-3">
          <h2 className="text-lg font-black">System status</h2>
          <span className="text-sm text-black/55" suppressHydrationWarning>
            checked {clock(stats.generatedAt)}
          </span>
        </div>
        {stale && (
          <p className="mt-2 rounded-xl border-2 border-[var(--warn)] bg-[var(--warn-bg)] p-3 font-semibold text-[var(--warn)]">
            ⚠ These numbers are out of date — the page cannot reach the server. Check the
            connection, then reload.
          </p>
        )}
        <ul className="mt-2 grid gap-2 sm:grid-cols-2">
          {stats.ops.map((item) => (
            <OpsRow key={item.key} item={item} />
          ))}
        </ul>
      </section>

      {/* ---------------- totals ---------------- */}
      <section>
        <h2 className="text-lg font-black">Sadhya numbers</h2>
        <div className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="Households" value={t.households} />
          <Stat label="Admissions sold" value={t.ticketsSold} />
          <Stat label="Checked in" value={t.ticketsRedeemed} tone="ok" />
          <Stat label="Still to come" value={t.ticketsRemaining} tone="gold" />
        </div>
        <p className="mt-2 text-sm text-black/65">
          {t.redeemableRemaining} of those {t.ticketsRemaining} are on passes that will actually
          open the door (paid or comped). Plus {t.childrenUnder6} children under 6, who eat free
          and are never ticketed.
          {t.testHouseholds > 0 && (
            <>
              {' '}
              <span className="font-bold text-[var(--warn)]">
                ⚠ {t.testHouseholds} test household{t.testHouseholds === 1 ? '' : 's'} exist and are
                excluded from every number above.
              </span>
            </>
          )}
        </p>
      </section>

      {/* ---------------- breakdowns ---------------- */}
      <section className="grid gap-4 lg:grid-cols-2">
        <BreakdownCard title="How they paid" rows={stats.byMethod} />
        <BreakdownCard title="Payment status" rows={stats.byStatus} />
      </section>

      {/* ---------------- attention ---------------- */}
      <section className="grid gap-3 sm:grid-cols-2">
        <Link
          href="/staff/admin/review"
          className={`card flex items-center gap-4 ${
            stats.openReviews > 0 ? 'border-2 border-[var(--warn)] bg-[var(--warn-bg)]' : ''
          }`}
        >
          <span className="text-3xl font-black tabular-nums">{stats.openReviews}</span>
          <span>
            <span className="block font-bold">
              {stats.openReviews > 0 ? 'Things need a decision' : 'Nothing needs a decision'}
            </span>
            <span className="block text-sm text-black/65">Open review queue →</span>
          </span>
        </Link>

        <div
          className={`card flex items-center gap-4 ${
            stats.emailFailures > 0 ? 'border-2 border-[var(--danger)]' : ''
          }`}
        >
          <span className="text-3xl font-black tabular-nums">{stats.emailFailures}</span>
          <span>
            <span className="block font-bold">
              {stats.emailFailures > 0 ? 'Passes never arrived' : 'All pass emails delivered'}
            </span>
            <span className="block text-sm text-black/65">
              {stats.emailFailures > 0
                ? 'Look these families up by name at the door.'
                : 'No failed sends.'}
            </span>
          </span>
        </div>
      </section>

      {/* ---------------- recent activity ---------------- */}
      <section className="grid gap-4 lg:grid-cols-2">
        <div className="card">
          <h2 className="text-lg font-black">Latest check-ins</h2>
          {stats.recentRedemptions.length === 0 ? (
            <p className="mt-2 text-sm text-black/60">Nobody has been checked in yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {stats.recentRedemptions.map((r) => (
                <li key={r.id} className="border-b border-black/5 pb-2 last:border-0">
                  <button
                    type="button"
                    onClick={() => setSelected(r.householdId)}
                    className="w-full text-left"
                  >
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <strong className="tabular-nums">{r.quantity}</strong>
                      <span className="font-semibold break-words">{r.name}</span>
                      {r.isTest && (
                        <span className="pill bg-[var(--warn-bg)] text-[var(--warn)]">⚠ TEST</span>
                      )}
                      {r.reversed && (
                        <span className="pill bg-[var(--warn-bg)] text-[var(--warn)]">
                          ↩ REVERSED
                        </span>
                      )}
                    </span>
                    <span className="block text-sm text-black/55" suppressHydrationWarning>
                      {clock(r.at)} · {r.staff ?? 'unknown staff'}
                      {r.device ? ` · ${r.device}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="card">
          <h2 className="text-lg font-black">Newest registrations</h2>
          {stats.recentRegistrations.length === 0 ? (
            <p className="mt-2 text-sm text-black/60">No households yet.</p>
          ) : (
            <ul className="mt-3 space-y-2">
              {stats.recentRegistrations.map((r) => (
                <li key={r.id} className="border-b border-black/5 pb-2 last:border-0">
                  <button
                    type="button"
                    onClick={() => setSelected(r.id)}
                    className="w-full text-left"
                  >
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold break-words">{r.name}</span>
                      {r.isTest && (
                        <span className="pill bg-[var(--warn-bg)] text-[var(--warn)]">⚠ TEST</span>
                      )}
                    </span>
                    <span className="block text-sm text-black/55" suppressHydrationWarning>
                      {r.ticketsPurchased} admission{r.ticketsPurchased === 1 ? '' : 's'} ·{' '}
                      {humanize(r.paymentStatus)} · {humanize(r.paymentMethod)} · {ago(r.at)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {/* ---------------- contingency ---------------- */}
      <section className="card">
        <h2 className="text-lg font-black">Before the event</h2>
        <p className="mt-1 text-sm text-black/70">
          Print the paper roster the night before. If the venue loses signal entirely, that sheet is
          the only way to check people in.
        </p>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Link href="/staff/admin/roster" className="btn-gold">
            🖨 Paper roster
          </Link>
          <a href="/api/staff/admin/export" className="btn-neutral">
            ⬇ Download spreadsheet
          </a>
        </div>
      </section>

    </div>
  )
}

/* ------------------------------------------------------------------ */

/**
 * Name search, permanently open, at the top of the page.
 *
 * This is what gets used when a QR will not scan and there is a queue of
 * hungry people behind the person at the door. It must never be behind a tab,
 * an accordion, or a second click.
 */
function EmergencyLookup({
  selected,
  onSelect,
  onChanged,
}: {
  selected: string | null
  onSelect: (id: string | null) => void
  onChanged: () => void
}) {
  const [term, setTerm] = useState('')
  const [results, setResults] = useState<Household[]>([])
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (term.trim().length < 2) {
      setResults([])
      setFailed(false)
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
        setFailed(false)
      } catch {
        setResults([])
        setFailed(true)
      } finally {
        setBusy(false)
      }
    }, 250)
    return () => clearTimeout(id)
  }, [term])

  return (
    <section className="rounded-2xl border-4 border-[var(--green)] bg-white p-4 shadow-sm">
      <h1 className="text-xl font-black">Find someone fast</h1>
      <p className="mt-1 text-sm text-black/70">
        QR not working? Type any part of their name, email or phone.
      </p>
      <input
        value={term}
        onChange={(e) => setTerm(e.target.value)}
        placeholder="Name, email, or phone"
        className="field mt-3 text-lg"
        autoComplete="off"
        aria-label="Search households"
      />

      {busy && <p className="mt-2 text-sm text-black/55">Searching…</p>}
      {failed && (
        <p className="mt-2 font-semibold text-[var(--danger)]">
          ✕ Search could not reach the server. Do not admit anyone on guesswork — use the paper
          roster.
        </p>
      )}

      {results.length > 0 && (
        <ul className="mt-3 space-y-2">
          {results.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                onClick={() => onSelect(selected === h.id ? null : h.id)}
                className="w-full rounded-xl border-2 border-black/10 bg-white p-4 text-left active:scale-[0.99]"
              >
                <span className="block text-lg font-bold break-words">{h.display_name}</span>
                <span className="mt-1 flex flex-wrap items-center gap-2">
                  <StatusPill status={h.payment_status} />
                  {h.is_test && (
                    <span className="pill bg-[var(--warn-bg)] text-[var(--warn)]">⚠ TEST ROW</span>
                  )}
                  {!h.pass_enabled && (
                    <span className="pill bg-[var(--danger-bg)] text-[var(--danger)]">
                      ✕ DISABLED
                    </span>
                  )}
                  <span className="text-sm tabular-nums text-black/60">
                    {h.tickets_remaining} of {h.tickets_purchased} left
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {!busy && !failed && term.trim().length >= 2 && results.length === 0 && (
        <p className="mt-2 text-sm text-black/65">
          No match. Try a shorter part of the name, or the phone number.
        </p>
      )}

      {/* The detail panel is rendered once, by the parent, directly beneath
          this section. Rendering it here as well drew the same household
          twice on one screen. */}
    </section>
  )
}

/* ------------------------------------------------------------------ */

const OPS_STYLE: Record<OpsState, { icon: string; word: string; className: string }> = {
  ok: { icon: '✓', word: 'OK', className: 'border-[var(--ok)] bg-[var(--ok-bg)]' },
  warn: { icon: '!', word: 'CHECK THIS', className: 'border-[var(--warn)] bg-[var(--warn-bg)]' },
  bad: { icon: '✕', word: 'BROKEN', className: 'border-[var(--danger)] bg-[var(--danger-bg)]' },
  idle: { icon: '·', word: 'NOT STARTED', className: 'border-black/15 bg-white' },
}

function OpsRow({ item }: { item: OpsItem }) {
  const s = OPS_STYLE[item.state]
  return (
    <li className={`rounded-xl border-2 p-3 ${s.className}`}>
      <div className="flex items-baseline gap-2">
        <span aria-hidden className="font-black">
          {s.icon}
        </span>
        <span className="font-bold">{item.label}</span>
        <span className="ml-auto text-xs font-black tracking-wide">{s.word}</span>
      </div>
      <p className="mt-1 text-sm">{item.detail}</p>
    </li>
  )
}

function Stat({
  label,
  value,
  tone = 'plain',
}: {
  label: string
  value: number
  tone?: 'plain' | 'ok' | 'gold'
}) {
  const bg =
    tone === 'ok'
      ? 'bg-[var(--ok-bg)] text-[var(--ok)]'
      : tone === 'gold'
        ? 'bg-[var(--cream)] text-[var(--gold-deep)]'
        : 'bg-white'
  return (
    <div className={`rounded-2xl border border-black/10 p-4 shadow-sm ${bg}`}>
      <div className="text-3xl font-black tabular-nums">{value}</div>
      <div className="text-sm font-semibold text-black/65">{label}</div>
    </div>
  )
}

function BreakdownCard({
  title,
  rows,
}: {
  title: string
  rows: { key: string; households: number; tickets: number }[]
}) {
  return (
    <div className="card">
      <h2 className="text-lg font-black">{title}</h2>
      {rows.length === 0 ? (
        <p className="mt-2 text-sm text-black/60">Nothing recorded yet.</p>
      ) : (
        <table className="mt-2 w-full text-sm">
          <thead>
            <tr className="text-left text-black/55">
              <th className="py-1 font-semibold">&nbsp;</th>
              <th className="py-1 text-right font-semibold">Households</th>
              <th className="py-1 text-right font-semibold">Admissions</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-black/5">
                <td className="py-1.5 font-semibold">{humanize(r.key)}</td>
                <td className="py-1.5 text-right tabular-nums">{r.households}</td>
                <td className="py-1.5 text-right tabular-nums">{r.tickets}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
