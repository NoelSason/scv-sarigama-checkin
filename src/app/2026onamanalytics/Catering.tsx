'use client'

import type { OnamAnalytics } from '@/lib/analytics/types'
import { SERIES } from './charts'

/*
 * The catering order against what actually turned up.
 *
 * Drawn as a demand curve with the order laid across it, because the shape is
 * the point: the order was not a bad guess, it was a good guess about a number
 * that had not finished moving. A table of totals hides that; a line crossing a
 * threshold does not.
 */

export function Catering({ data }: { data: OnamAnalytics }) {
  const c = data.catering
  const max = Math.max(c.sold, c.ordered) * 1.06

  return (
    <div>
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Meals ordered" value={c.ordered} hint="about a week out" />
        <Tile label="Admissions sold" value={c.sold} tone="gold" />
        <Tile label="Guests accounted for" value={c.ate} tone="green" />
        <Tile
          label="Short by"
          value={c.shortAgainstAte}
          hint="against the people who ate"
          tone="danger"
        />
      </div>

      <p className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--cream)] p-4 text-[15px] leading-relaxed text-black/75">
        The order was <strong>a reasonable read of what was known</strong> — a headcount in that
        region, a week out, and {c.ordered} meals against it. What nobody could see was that{' '}
        <strong>{c.lateDemand} more admissions would arrive</strong> after the books were
        consolidated — {c.latePercent}% on top of the whole headcount — with{' '}
        <strong>{c.lateOnTheDay} of them landing on the day itself</strong>.{' '}
        {c.knownAtOrder > c.ordered ? (
          <>
            By the time every existing sale was in one place the count already stood at{' '}
            {c.knownAtOrder}, {c.knownAtOrder - c.ordered} above the order, and it finished{' '}
            {c.shortAgainstSold} above.
          </>
        ) : (
          <>
            The count passed the order on {c.crossedOn} and finished {c.shortAgainstSold} above it.
          </>
        )}
      </p>

      {/* Demand curve. The order is a line across the chart, not another bar,
          because it is a threshold rather than a quantity to compare heights
          against. */}
      <div className="card mt-4">
        <h3 className="display text-lg leading-6">How the headcount moved</h3>
        <p className="mt-1 text-sm leading-snug text-black/60">
          Running total of admissions, by the day each record entered the system. The first bar is
          the bulk import — every Square and spreadsheet sale that already existed.
        </p>

        <div className="relative mt-4">
          {/* The order threshold, drawn once, spanning every row. */}
          <div
            className="pointer-events-none absolute bottom-5 top-0 z-10 border-l-2 border-dashed"
            style={{ left: `calc(3.5rem + (100% - 3.5rem) * ${c.ordered / max})`, borderColor: SERIES[2] }}
            aria-hidden
          />
          <span
            className="pointer-events-none absolute bottom-0 z-10 -translate-x-1/2 whitespace-nowrap text-[11px] font-bold"
            style={{ left: `calc(3.5rem + (100% - 3.5rem) * ${c.ordered / max})`, color: SERIES[2] }}
          >
            {c.ordered} ordered
          </span>

          <ul className="space-y-2 pb-5">
            {c.buildup.map((b) => {
              const over = b.running > c.ordered
              return (
                <li key={b.day} className="flex items-center gap-2">
                  <span className="w-14 shrink-0 text-right text-sm font-semibold text-black/55">
                    {b.label}
                  </span>
                  <span className="flex h-7 flex-1 items-center">
                    <span
                      className="h-full rounded-r-[4px] rounded-l-[2px]"
                      style={{
                        width: `${(b.running / max) * 100}%`,
                        background: over ? SERIES[2] : SERIES[0],
                        opacity: b.baseline ? 1 : over ? 1 : 0.75,
                      }}
                    />
                    <span className="ml-2 shrink-0 text-sm font-bold tabular-nums">{b.running}</span>
                    {b.added > 0 && !b.baseline && (
                      <span className="ml-1.5 shrink-0 whitespace-nowrap text-xs text-black/50">
                        +{b.added}
                      </span>
                    )}
                    {b.baseline && (
                      <span className="ml-1.5 shrink-0 whitespace-nowrap text-xs text-black/50">
                        already sold
                      </span>
                    )}
                  </span>
                </li>
              )
            })}
          </ul>
        </div>

        <p className="mt-2 text-sm leading-relaxed text-black/60">
          Nothing was wrong with the forecast. The demand simply had not finished arriving when the
          caterer needed a final number — which is an argument for a later deadline, not a better
          guess.
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
  tone?: 'green' | 'gold' | 'danger'
}) {
  const color =
    tone === 'green'
      ? 'var(--green-deep)'
      : tone === 'gold'
        ? 'var(--gold-deep)'
        : tone === 'danger'
          ? 'var(--danger)'
          : 'var(--foreground)'
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
