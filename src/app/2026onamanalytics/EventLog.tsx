'use client'

import { useRef, useState } from 'react'
import type { NamedCount } from '@/lib/analytics/types'
import { LOG_PAGE, type AdminLogRow, type LogRow } from '@/lib/analytics/log-shape'

/*
 * Every recorded event, one row each.
 *
 * The rows come from the `event_stream` view, which unions every table that
 * records something happening — actions, scans, adjustments, payments, emails,
 * logins, syncs, reviews. It is a view rather than a copy so it cannot drift
 * from its sources and nothing has to remember to write twice.
 *
 * The first page is rendered on the server and handed in as a prop, so the list
 * is populated on arrival and this component fetches only in response to
 * something the reader did — a filter, a search, "load more". There is no
 * fetch-on-mount effect to race with, and no empty flash before the first page
 * lands.
 *
 * Paged because two thirds of the log is the five-minute spreadsheet sync, and
 * a phone should not download three thousand of those to read the top.
 */

const CATEGORY_WORD: Record<string, string> = {
  action: 'Actions',
  redemption: 'Check-ins',
  adjustment: 'Corrections',
  payment: 'Payments',
  email: 'Emails',
  login: 'Sign-ins',
  sync: 'Spreadsheet syncs',
  review: 'Review queue',
}

/** snake_case machine names read badly in a list a human is scanning. */
function humanAction(action: string): string {
  return action.replace(/[._]/g, ' ').replace(/^\w/, (c) => c.toUpperCase())
}

function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
    timeZone: 'America/Los_Angeles',
  })
}

/** Present only on the staff view; absent from the public payload entirely. */
function admin(row: LogRow): Partial<AdminLogRow> {
  return row as AdminLogRow
}

export function EventLog({
  categories,
  total,
  firstPage,
  full = false,
}: {
  categories: NamedCount[]
  total: number
  firstPage: LogRow[]
  /** Ask the server for the identifying columns too. Staff view only. */
  full?: boolean
}) {
  const [category, setCategory] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [applied, setApplied] = useState('')
  const [rows, setRows] = useState<LogRow[]>(firstPage)
  const [count, setCount] = useState(total)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)
  const request = useRef(0)

  /**
   * Filters are passed in rather than read from state: this is called from the
   * same handler that sets them, and reading the not-yet-committed state would
   * fetch the previous filter's page.
   */
  async function load(
    offset: number,
    replace: boolean,
    forCategory: string | null,
    forSearch: string,
  ) {
    const ticket = ++request.current
    setLoading(true)
    setFailed(false)
    try {
      const params = new URLSearchParams({ limit: String(LOG_PAGE), offset: String(offset) })
      if (full) params.set('full', '1')
      if (forCategory) params.set('category', forCategory)
      if (forSearch) params.set('q', forSearch)

      const res = await fetch(`/api/analytics/log?${params}`, { cache: 'no-store' })
      if (!res.ok) throw new Error('log failed')
      const data = (await res.json()) as { rows: LogRow[]; total: number }

      // A slow request must not overwrite a newer filter's results.
      if (ticket !== request.current) return
      setRows((prev) => (replace ? data.rows : [...prev, ...data.rows]))
      setCount(data.total)
    } catch {
      if (ticket === request.current) setFailed(true)
    } finally {
      if (ticket === request.current) setLoading(false)
    }
  }

  function filterBy(nextCategory: string | null, nextSearch: string) {
    setCategory(nextCategory)
    setApplied(nextSearch)
    setExpanded(null)
    void load(0, true, nextCategory, nextSearch)
  }

  return (
    <div>
      {/* Filters in one row above the list. */}
      <div className="flex flex-wrap gap-1.5">
        <Chip active={category === null} onClick={() => filterBy(null, applied)}>
          Everything <span className="tabular-nums opacity-60">{total}</span>
        </Chip>
        {categories.map((c) => (
          <Chip
            key={c.key}
            active={category === c.key}
            onClick={() => filterBy(c.key, applied)}
          >
            {CATEGORY_WORD[c.key] ?? c.label}{' '}
            <span className="tabular-nums opacity-60">{c.count}</span>
          </Chip>
        ))}
      </div>

      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          filterBy(category, search.trim())
        }}
      >
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={full ? 'Search a name, action, place or address…' : 'Search a name or an action…'}
          aria-label="Search the log"
          className="field flex-1"
        />
        <button type="submit" className="btn-neutral px-4 py-2">
          Search
        </button>
      </form>

      <p className="mt-3 text-sm text-black/60" aria-live="polite">
        {count.toLocaleString()} {count === 1 ? 'entry' : 'entries'}
        {applied && <> matching “{applied}”</>}
        {rows.length < count && <> · showing the most recent {rows.length}</>}
        {loading && <> · loading…</>}
      </p>

      {failed && (
        <p className="mt-3 rounded-xl border-2 border-[var(--danger)] bg-[var(--danger-bg)] p-3 font-semibold text-[var(--danger)]">
          The log could not be loaded. Check the connection and try again.
        </p>
      )}

      <ul className="mt-3 divide-y divide-[var(--line)] border-y border-[var(--line)]">
        {rows.map((r) => {
          const open = expanded === r.event_id
          return (
            <li key={r.event_id} className="py-2.5">
              <button
                type="button"
                onClick={() => setExpanded(open ? null : r.event_id)}
                className="flex w-full items-baseline gap-2 text-left"
              >
                <time
                  dateTime={r.occurred_at}
                  className="w-28 shrink-0 text-xs leading-tight tabular-nums text-black/50 sm:w-[8.5rem]"
                >
                  {when(r.occurred_at)}
                </time>
                <span className="min-w-0 flex-1">
                  <span className="font-semibold">{humanAction(r.action)}</span>
                  {r.household && <span className="text-black/70"> — {r.household}</span>}
                  <span className="block text-xs text-black/50">
                    {r.actor ?? 'system'}
                    {r.actor_role && ` (${r.actor_role})`}
                    {full && admin(r).location && ` · ${admin(r).location}`}
                    {full && admin(r).ip && ` · ${admin(r).ip}`}
                  </span>
                </span>
                <span aria-hidden className="shrink-0 text-black/35">
                  {open ? '▴' : '▾'}
                </span>
              </button>
              {open && (
                <dl className="mt-2 space-y-1 text-xs text-black/65 sm:ml-[9rem]">
                  <Detail label="Category" value={CATEGORY_WORD[r.category] ?? r.category} />
                  <Detail label="Raw action" value={r.action} />
                  <Detail label="Route" value={r.request_path} />
                  {full && <Detail label="Address" value={admin(r).ip ?? null} mono />}
                  {full && <Detail label="Place" value={admin(r).location ?? null} />}
                  {full && <Detail label="Device" value={admin(r).user_agent ?? null} mono />}
                  {full && <Detail label="Staff email" value={admin(r).actor_email ?? null} />}
                  <Detail label="Detail" value={r.detail} mono />
                </dl>
              )}
            </li>
          )
        })}
      </ul>

      {rows.length < count && (
        <div className="mt-4">
          <button
            type="button"
            disabled={loading}
            onClick={() => void load(rows.length, false, category, applied)}
            className="btn-neutral px-4 py-2"
          >
            {loading ? 'Loading…' : `Load ${Math.min(LOG_PAGE, count - rows.length)} more`}
          </button>
        </div>
      )}
    </div>
  )
}

function Detail({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  if (!value) return null
  return (
    <div className="flex gap-2">
      <dt className="w-20 shrink-0 font-semibold text-black/45">{label}</dt>
      <dd className={`min-w-0 flex-1 break-all ${mono ? 'font-mono' : ''}`}>{value}</dd>
    </div>
  )
}

function Chip({
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
      aria-pressed={active}
      className={`rounded-full border-2 px-3 py-1.5 text-sm font-semibold transition ${
        active
          ? 'border-[var(--green)] bg-[var(--green)] text-white'
          : 'border-[var(--line-strong)] bg-white hover:bg-[var(--cream)]'
      }`}
    >
      {children}
    </button>
  )
}
