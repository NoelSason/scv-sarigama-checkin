'use client'

import { useId, useState } from 'react'
import type { Bucket, Tier } from '@/lib/analytics/types'

/*
 * Chart primitives for the Onam analytics page.
 *
 * Built from divs and one small SVG rather than a charting library:
 *
 *   * The page must be legible on a phone held at arm's length. A scaled
 *     viewBox shrinks its own type; flex columns keep labels at real size and
 *     reflow instead.
 *   * Nothing here needs a dependency. The whole app ships four runtime
 *     packages and this page is not a reason to add a fifth.
 *
 * Colour rules, applied throughout:
 *   * Magnitude (how busy a slot was) is ONE hue, light → dark. Never a rainbow.
 *   * Identity (payment channel) uses the fixed categorical order below, never
 *     cycled, and always paired with a written label — colour is never the only
 *     signal.
 *   * Numbers and labels wear text colours, never the series colour.
 *
 * The categorical set was checked with a CVD validator against this page's
 * cream surface: lightness band, chroma floor, protan/deutan/tritan separation,
 * normal-vision separation and 3:1 contrast all pass.
 */

/** Fixed categorical order. A fifth series folds into "Other" rather than inventing a hue. */
export const SERIES = ['#15704a', '#c2820e', '#a32d18', '#3b4d8f'] as const

/** Single-hue magnitude ramp, light → dark. Used for "how busy". */
const RAMP: Record<Tier, string> = {
  quiet: '#c3d3c8',
  trickle: '#a8cdb8',
  steady: '#5da88a',
  busy: '#2b8560',
  rush: '#15704a',
}

const TIER_WORD: Record<Tier, string> = {
  quiet: 'nobody arriving',
  trickle: 'trickle',
  steady: 'steady',
  busy: 'busy',
  rush: 'the rush',
}

export const TIER_LEGEND: { tier: Tier; label: string }[] = [
  { tier: 'rush', label: 'The rush' },
  { tier: 'busy', label: 'Busy' },
  { tier: 'steady', label: 'Steady' },
  { tier: 'trickle', label: 'Trickle' },
  { tier: 'quiet', label: 'Nobody arriving' },
]

export function tierColor(tier: Tier): string {
  return RAMP[tier]
}

/* ------------------------------------------------------------------ chrome */

export function ChartFrame({
  title,
  subtitle,
  children,
  footer,
}: {
  title: string
  subtitle?: string
  children: React.ReactNode
  footer?: React.ReactNode
}) {
  return (
    <figure className="card m-0">
      <figcaption>
        <h3 className="display text-lg leading-6">{title}</h3>
        {subtitle && <p className="mt-1 text-sm leading-snug text-black/60">{subtitle}</p>}
      </figcaption>
      <div className="mt-4">{children}</div>
      {footer && <figcaption className="mt-3 text-sm text-black/60">{footer}</figcaption>}
    </figure>
  )
}

/** Hover/focus readout. One per chart, in a fixed slot, so nothing jumps. */
function Readout({ children }: { children: React.ReactNode }) {
  return (
    <p
      aria-live="polite"
      className="min-h-[1.5rem] text-sm font-semibold text-[var(--green-deep)]"
    >
      {children}
    </p>
  )
}

/* ----------------------------------------------------- arrivals over the day */

/**
 * The shape of the afternoon: one column per five minutes, shaded by how busy
 * that slot was, with the rush and the longest lull called out in words.
 *
 * Zero columns are drawn as a hairline at the baseline rather than skipped —
 * the empty stretches are half the story.
 */
export function ArrivalChart({
  buckets,
  peakLabel,
  lull,
}: {
  buckets: Bucket[]
  peakLabel: string | null
  lull: { from: string; to: string; minutes: number } | null
}) {
  const [active, setActive] = useState<number | null>(null)
  const max = Math.max(1, ...buckets.map((b) => b.guests))
  const shown = active === null ? null : buckets[active]

  return (
    <div>
      <Readout>
        {shown ? (
          <>
            {shown.label} — {shown.guests} {shown.guests === 1 ? 'guest' : 'guests'} in{' '}
            {shown.scans} {shown.scans === 1 ? 'scan' : 'scans'} · {TIER_WORD[shown.tier]}
          </>
        ) : (
          <span className="font-normal text-black/55">
            Tap or hover a column for that five minutes.
          </span>
        )}
      </Readout>

      <div
        className="mt-2 flex h-44 items-end gap-[2px] border-b-2 border-[var(--line-strong)] sm:h-56"
        onMouseLeave={() => setActive(null)}
      >
        {buckets.map((b, i) => (
          <button
            key={b.at}
            type="button"
            aria-label={`${b.label}: ${b.guests} guests, ${TIER_WORD[b.tier]}`}
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onClick={() => setActive(i)}
            className="group relative flex h-full flex-1 cursor-pointer items-end rounded-t-[3px] outline-none"
          >
            {/* Hit target is the full column height; the mark is only the bar.
                An empty slot keeps a visible stub rather than vanishing — the
                stretches where nobody arrived are half of what this chart is
                for, and a gap reads as missing data instead of as quiet. */}
            <span
              className="w-full rounded-t-[3px] transition-[filter]"
              style={{
                height: b.guests === 0 ? '5px' : `${Math.max(6, (b.guests / max) * 100)}%`,
                background: tierColor(b.tier),
                filter: active === i ? 'brightness(1.25)' : undefined,
                outline: active === i ? '2px solid var(--foreground)' : undefined,
                outlineOffset: '1px',
              }}
            />
          </button>
        ))}
      </div>

      {/* Time axis: every fourth label (20 minutes) so nothing collides. */}
      <div className="mt-1 flex gap-[2px] text-[10px] font-semibold text-black/50">
        {buckets.map((b, i) => (
          <span key={b.at} className="flex-1 text-center">
            {i % 4 === 0 ? b.label.replace(':00', '').replace(' AM', '').replace(' PM', '') : ''}
          </span>
        ))}
      </div>

      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold text-black/60">
        {TIER_LEGEND.map((t) => (
          <li key={t.tier} className="flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-3 w-3 rounded-[2px] ring-1 ring-black/10"
              style={{ background: tierColor(t.tier) }}
            />
            {t.label}
          </li>
        ))}
      </ul>

      <p className="mt-3 text-sm leading-relaxed text-black/70">
        {peakLabel && (
          <>
            Busiest five minutes: <strong>{peakLabel}</strong>.{' '}
          </>
        )}
        {lull && (
          <>
            Longest gap with nobody arriving: <strong>{lull.minutes} minutes</strong>, {lull.from} to{' '}
            {lull.to}.
          </>
        )}
      </p>
    </div>
  )
}

/* ------------------------------------------------------------- hour columns */

export function HourBars({ buckets }: { buckets: Bucket[] }) {
  const max = Math.max(1, ...buckets.map((b) => b.guests))
  return (
    <ul className="space-y-2">
      {buckets.map((b) => (
        <li key={b.at} className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-right text-sm font-bold tabular-nums">{b.label}</span>
          <span className="flex h-7 min-w-0 flex-1 items-center">
            <span
              className="h-full shrink rounded-r-[4px] rounded-l-[2px]"
              style={{ width: `${(b.guests / max) * 100}%`, background: tierColor(b.tier) }}
            />
            <span className="ml-2 shrink-0 text-sm font-bold tabular-nums">{b.guests}</span>
            <span className="ml-1.5 shrink-0 whitespace-nowrap text-xs text-black/50">
              in {b.scans} scans
            </span>
          </span>
        </li>
      ))}
    </ul>
  )
}

/* ---------------------------------------------------------- seating fill */

/**
 * Cumulative arrivals against the hall's seating.
 *
 * The reference lines are the real constraint the day ran under: four lanes of
 * roughly twenty, so every eighty guests is one full turn of the room.
 */
export function SeatingCurve({
  buckets,
  capacity,
  lanes,
  seatsPerLane,
}: {
  buckets: Bucket[]
  capacity: number
  lanes: number
  seatsPerLane: number
}) {
  const clipId = useId()
  const total = buckets.length ? buckets[buckets.length - 1].cumulative : 0
  const seatings = Math.max(1, Math.ceil(total / capacity))
  const top = seatings * capacity
  const W = 600
  const H = 220

  const x = (i: number) => (buckets.length < 2 ? 0 : (i / (buckets.length - 1)) * W)
  const y = (v: number) => H - (v / top) * H

  const line = buckets.map((b, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(b.cumulative).toFixed(1)}`).join(' ')
  const area = `${line} L${W},${H} L0,${H} Z`

  return (
    <div>
      <div className="relative">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={`Cumulative arrivals reaching ${total} guests, against seatings of ${capacity}`}
          className="h-52 w-full sm:h-64"
        >
          <defs>
            <linearGradient id={`${clipId}-fill`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={SERIES[0]} stopOpacity="0.28" />
              <stop offset="100%" stopColor={SERIES[0]} stopOpacity="0.04" />
            </linearGradient>
          </defs>

          {/* Seating boundaries — the recessive layer, behind the data. */}
          {Array.from({ length: seatings }, (_, i) => (i + 1) * capacity).map((v) => (
            <line
              key={v}
              x1="0"
              x2={W}
              y1={y(v)}
              y2={y(v)}
              stroke="var(--line-strong)"
              strokeWidth="1"
              strokeDasharray="5 5"
              vectorEffect="non-scaling-stroke"
            />
          ))}

          <path d={area} fill={`url(#${clipId}-fill)`} />
          <path
            d={line}
            fill="none"
            stroke={SERIES[0]}
            strokeWidth="2"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        {/* Labels live in HTML so the non-uniform viewBox scale cannot stretch
            the type. */}
        <div className="pointer-events-none absolute inset-0">
          {Array.from({ length: seatings }, (_, i) => (i + 1) * capacity).map((v) => (
            <span
              key={v}
              className="absolute left-0 -translate-y-1/2 rounded bg-[var(--card)]/85 px-1 text-[10px] font-bold tabular-nums text-black/55"
              style={{ top: `${(1 - v / top) * 100}%` }}
            >
              {v} seated
            </span>
          ))}
        </div>
      </div>

      <div className="mt-1 flex justify-between text-[10px] font-semibold text-black/50">
        <span>{buckets[0]?.label}</span>
        <span>{buckets[buckets.length - 1]?.label}</span>
      </div>

      <p className="mt-3 text-sm leading-relaxed text-black/70">
        Each dashed line is one full turn of the hall — {lanes} lanes of about {seatsPerLane}.
      </p>
    </div>
  )
}

/* ------------------------------------------------------------- share bar */

export function ShareBar({
  rows,
  unit,
  format,
}: {
  rows: { key: string; label: string; value: number; detail?: string }[]
  unit: string
  format?: (v: number) => string
}) {
  const total = rows.reduce((s, r) => s + r.value, 0) || 1
  const fmt = format ?? ((v: number) => String(v))

  return (
    <div>
      {/* 2px surface gaps between segments, so adjacent fills never touch. */}
      <div className="flex h-9 gap-[2px] overflow-hidden rounded-lg">
        {rows.map((r, i) => (
          <span
            key={r.key}
            className="min-w-[3px] first:rounded-l-lg last:rounded-r-lg"
            style={{ width: `${(r.value / total) * 100}%`, background: SERIES[i % SERIES.length] }}
          />
        ))}
      </div>

      <ul className="mt-3 space-y-1.5">
        {rows.map((r, i) => (
          <li key={r.key} className="flex items-baseline gap-2 text-sm">
            <span
              aria-hidden
              className="mt-[3px] inline-block h-3 w-3 shrink-0 self-start rounded-[2px] ring-1 ring-black/10"
              style={{ background: SERIES[i % SERIES.length] }}
            />
            <span className="flex-1 leading-snug">{r.label}</span>
            <span className="shrink-0 font-bold tabular-nums">{fmt(r.value)}</span>
            <span className="shrink-0 text-xs text-black/50">
              {Math.round((r.value / total) * 100)}% of {unit}
            </span>
          </li>
        ))}
      </ul>
      {rows.some((r) => r.detail) && (
        <ul className="mt-2 space-y-0.5 text-xs text-black/55">
          {rows.map((r) => (r.detail ? <li key={r.key}>{r.label}: {r.detail}</li> : null))}
        </ul>
      )}
    </div>
  )
}

/* -------------------------------------------------------------- histogram */

export function Columns({
  rows,
  caption,
}: {
  rows: { key: string; label: string; value: number; sub?: string }[]
  caption?: string
}) {
  const [active, setActive] = useState<number | null>(null)
  const max = Math.max(1, ...rows.map((r) => r.value))
  const shown = active === null ? null : rows[active]

  return (
    <div>
      <Readout>
        {shown ? (
          <>
            {shown.label}: {shown.value}
            {shown.sub ? ` — ${shown.sub}` : ''}
          </>
        ) : (
          <span className="font-normal text-black/55">{caption ?? ' '}</span>
        )}
      </Readout>
      <div
        className="mt-2 flex h-32 items-end gap-1.5 border-b-2 border-[var(--line-strong)]"
        onMouseLeave={() => setActive(null)}
      >
        {rows.map((r, i) => (
          <button
            key={r.key}
            type="button"
            aria-label={`${r.label}: ${r.value}`}
            onMouseEnter={() => setActive(i)}
            onFocus={() => setActive(i)}
            onClick={() => setActive(i)}
            className="flex h-full flex-1 cursor-pointer items-end outline-none"
          >
            <span
              className="w-full rounded-t-[4px]"
              style={{
                height: `${Math.max(3, (r.value / max) * 100)}%`,
                background: SERIES[0],
                opacity: active === null || active === i ? 1 : 0.45,
              }}
            />
          </button>
        ))}
      </div>
      <div className="mt-1 flex gap-1.5 text-[11px] font-semibold text-black/55">
        {rows.map((r) => (
          <span key={r.key} className="flex-1 text-center">
            {r.label}
          </span>
        ))}
      </div>
    </div>
  )
}

/* ------------------------------------------------------- paired comparison */

/** Two measures of the same thing — bought against turned up. One scale, always. */
export function PairedBars({
  rows,
}: {
  rows: { key: string; label: string; sold: number; came: number }[]
}) {
  const max = Math.max(1, ...rows.map((r) => r.sold))
  return (
    <div>
      <ul className="space-y-3">
        {rows.map((r) => (
          <li key={r.key}>
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="font-semibold leading-snug">{r.label}</span>
              <span className="shrink-0 tabular-nums text-black/60">
                <strong className="text-[var(--foreground)]">{r.came}</strong> of {r.sold} came
              </span>
            </div>
            <div className="mt-1 space-y-[2px]">
              <div
                className="h-3 rounded-[3px]"
                style={{ width: `${(r.sold / max) * 100}%`, background: SERIES[1], opacity: 0.45 }}
              />
              <div
                className="h-3 rounded-[3px]"
                style={{ width: `${(r.came / max) * 100}%`, background: SERIES[0] }}
              />
            </div>
          </li>
        ))}
      </ul>
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold text-black/60">
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-3 w-3 rounded-[2px]"
            style={{ background: SERIES[1], opacity: 0.45 }}
          />
          Admissions bought
        </li>
        <li className="flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-3 w-3 rounded-[2px]"
            style={{ background: SERIES[0] }}
          />
          Scanned in
        </li>
      </ul>
    </div>
  )
}

/* ------------------------------------------------------------- sparkline */

export function DayBars({ rows }: { rows: { key: string; label: string; value: number; sub?: string }[] }) {
  const max = Math.max(1, ...rows.map((r) => r.value))
  return (
    <ul className="space-y-1.5">
      {rows.map((r) => (
        <li key={r.key} className="flex items-center gap-3">
          <span className="w-14 shrink-0 text-right text-sm font-semibold text-black/60">
            {r.label}
          </span>
          <span className="flex flex-1 items-center gap-2">
            <span
              className="h-4 rounded-[3px]"
              style={{ width: `${(r.value / max) * 100}%`, background: SERIES[0], minWidth: '2px' }}
            />
            <span className="text-sm font-bold tabular-nums">{r.value}</span>
            {r.sub && <span className="text-xs text-black/50">{r.sub}</span>}
          </span>
        </li>
      ))}
    </ul>
  )
}
