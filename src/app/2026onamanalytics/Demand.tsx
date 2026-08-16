'use client'

import type { OnamAnalytics } from '@/lib/analytics/types'
import { SERIES } from './charts'

/*
 * How the headcount moved in the last week.
 *
 * Drawn as a running total rather than a per-day count, because the shape is
 * the point: the number people planned against was not the number that turned
 * up, and it kept climbing right through to the morning of the event.
 */

export function Demand({ data }: { data: OnamAnalytics }) {
  const d = data.demand
  const max = d.sold * 1.06

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Admissions sold" value={d.sold} tone="gold" />
        <Tile label="Guests accounted for" value={d.ate} tone="green" />
        <Tile
          label="Arrived late"
          value={d.lateDemand}
          hint={`${d.latePercent}% on top of the headcount`}
        />
        <Tile label="Added on the day" value={d.lateOnTheDay} hint="deciding that morning" />
      </div>

      <p className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--cream)] p-4 text-[15px] leading-relaxed text-black/75">
        Once every existing sale was in one place the count stood at{' '}
        <strong>{d.knownAtBaseline} admissions</strong>. What nobody could see was that{' '}
        <strong>{d.lateDemand} more would arrive</strong> after that — {d.latePercent}% on top of
        the whole headcount — with <strong>{d.lateOnTheDay} of them landing on the day itself</strong>.
        Anything planned against the number that week was planning against a figure that had not
        finished moving.
      </p>

      <div className="card mt-4">
        <h3 className="display text-lg leading-6">How the headcount moved</h3>
        <p className="mt-1 text-sm leading-snug text-black/60">
          Running total of admissions, by the day each record entered the system. The first bar is
          the bulk import — every Square and spreadsheet sale that already existed.
        </p>

        <ul className="mt-4 space-y-2">
          {d.buildup.map((b) => (
            <li key={b.day} className="flex items-center gap-2">
              <span className="w-14 shrink-0 text-right text-sm font-semibold text-black/55">
                {b.label}
              </span>
              <span className="flex h-7 min-w-0 flex-1 items-center">
                <span
                  className="h-full shrink rounded-r-[4px] rounded-l-[2px]"
                  style={{
                    width: `${(b.running / max) * 100}%`,
                    background: SERIES[0],
                    opacity: b.baseline ? 0.55 : 1,
                  }}
                />
                <span className="ml-2 shrink-0 text-sm font-bold tabular-nums">{b.running}</span>
                <span className="ml-1.5 shrink-0 whitespace-nowrap text-xs text-black/50">
                  {b.baseline ? 'already sold' : `+${b.added}`}
                </span>
              </span>
            </li>
          ))}
        </ul>

        <p className="mt-3 text-sm leading-relaxed text-black/60">
          The demand simply had not finished arriving when decisions had to be made — which is an
          argument for later deadlines, not for better guessing.
        </p>
      </div>
    </div>
  )
}

function Tile({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: number
  hint?: string
  tone?: 'green' | 'gold'
}) {
  const color =
    tone === 'green' ? 'var(--green-deep)' : tone === 'gold' ? 'var(--gold-deep)' : 'var(--foreground)'
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--card)] p-3">
      <div className="display text-2xl leading-7 tabular-nums" style={{ color }}>
        {value}
      </div>
      <div className="mt-0.5 text-xs font-semibold leading-tight text-black/55">{label}</div>
      {hint && <div className="mt-0.5 text-[11px] leading-tight text-black/40">{hint}</div>}
    </div>
  )
}
