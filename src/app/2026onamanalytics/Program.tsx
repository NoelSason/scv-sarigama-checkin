'use client'

import { useState } from 'react'
import type { ProgramState } from '@/lib/analytics/types'
import { driftWords } from '@/lib/analytics/program'

/*
 * The run sheet against the clock.
 *
 * Built to be used while the show is still running, not read afterwards: the
 * one number an organiser standing at the side of the stage wants is "how far
 * behind are we, and when does this finish", and everything else on this panel
 * is in service of that.
 *
 * Marking an item as started is the whole interaction. It writes a shared
 * timestamp, so the emcee, the stage manager and whoever is watching the clock
 * all see the same answer instead of three private guesses.
 *
 * Two items cannot be marked and are shown as measurements instead: the Sadya
 * opened when the first guest was checked in and closed when the last one was,
 * and the scanner is a better witness than anyone's memory.
 */

const PHASE_LABEL: Record<string, string> = {
  setup: 'Setting up',
  sadya: 'Sadya',
  program: 'On stage',
}

export function Program({ state, onChanged }: { state: ProgramState; onChanged: () => void }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showSetup, setShowSetup] = useState(false)

  async function mark(itemKey: string, clear = false) {
    setBusy(itemKey)
    setError(null)
    try {
      const res = await fetch('/api/analytics/program', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemKey, clear }),
      })
      if (!res.ok) throw new Error('failed')
      onChanged()
    } catch {
      setError('That did not save. Check the connection and try again.')
    } finally {
      setBusy(null)
    }
  }

  const behind = state.driftMinutes > 0
  const startDrift = state.startDriftMinutes
  const done = state.finished

  const visible = state.items.filter((i) => showSetup || i.phase !== 'setup')

  return (
    <div>
      {/* Once the show is over the forecast columns are meaningless — what is
          wanted then is the result, not a prediction of it. */}
      {done ? (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Big
            label="Started"
            value={state.items.find((i) => i.key === 'p01')?.actualAt ?? '—'}
            hint={
              startDrift !== null ? `${driftWords(startDrift)} · planned ${state.programPlannedAt}` : undefined
            }
            tone={startDrift !== null && startDrift > 20 ? 'warn' : undefined}
          />
          <Big
            label="Ended"
            value={state.actualEnd ?? '—'}
            hint={`${driftWords(state.driftMinutes)} · planned ${state.plannedEnd}`}
            tone={behind ? (state.driftMinutes > 45 ? 'bad' : 'warn') : 'ok'}
          />
          <Big
            label="Ran for"
            value={
              state.ranMinutes === null
                ? '—'
                : `${Math.floor(state.ranMinutes / 60)}h ${state.ranMinutes % 60}m`
            }
            hint="call to order to the last word"
          />
          <Big
            label="Time pulled back"
            value={
              startDrift === null ? '—' : `${Math.max(0, startDrift - state.driftMinutes)} min`
            }
            hint="over the course of the show"
            tone="ok"
          />
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Big
            label="Running"
            value={driftWords(state.driftMinutes)}
            tone={behind ? (state.driftMinutes > 45 ? 'bad' : 'warn') : 'ok'}
          />
          <Big label="Now on stage" value={state.currentTitle ?? 'Not started'} small />
          <Big
            label="Finishes at this pace"
            value={state.projectedEndAtPlannedPace ?? '—'}
            hint={`run sheet said ${state.plannedEnd}`}
            tone={behind ? 'warn' : 'ok'}
          />
          <Big
            label="Still to run"
            value={`${state.minutesRemainingPlanned} min`}
            hint="at the planned lengths"
          />
        </div>
      )}

      {/* The recovery story: how much was lost at the start, how much is left. */}
      {typeof startDrift === 'number' && startDrift > 0 && (
        <p className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--cream)] p-3 text-[15px] leading-relaxed text-black/75">
          The programme was called to order at <strong>{state.items[state.items.findIndex((i) => i.key === 'p01')]?.actualAt}</strong>{' '}
          instead of {state.programPlannedAt} — <strong>{driftWords(startDrift)}</strong> before a
          word was said.
          {state.driftMinutes < startDrift ? (
            <>
              {' '}
              {done ? ' Over the afternoon it pulled back ' : ' Since then the show has pulled back '}
              <strong>{Math.round(startDrift - state.driftMinutes)} minutes</strong>
              {done ? ', finishing ' : ', and is now '}
              {driftWords(state.driftMinutes)}.
              {state.paceRatio !== null && state.paceRatio < 1 && (
                <>
                  {' '}
                  Items have been running at about{' '}
                  <strong>{Math.round(100 / state.paceRatio) / 100}× the run sheet&rsquo;s pace</strong>.
                </>
              )}
            </>
          ) : (
            <> The gap has not closed since.</>
          )}
        </p>
      )}

      {/* The cumulative number can look healthy while the show is quietly
          slipping again. This is the pace right now — only useful mid-show. */}
      {!done && state.recentDriftChange !== null && state.recentSincePrevious && (
        <p className="mt-3 text-[15px] leading-relaxed text-black/75">
          Since <strong>{state.recentSincePrevious}</strong>,{' '}
          {state.recentDriftChange > 1 ? (
            <>
              the show has slipped a further{' '}
              <strong className="text-[var(--warn)]">{state.recentDriftChange} minutes</strong>. The
              gap is opening again.
            </>
          ) : state.recentDriftChange < -1 ? (
            <>
              it has pulled back another{' '}
              <strong className="text-[var(--ok)]">{Math.abs(state.recentDriftChange)} minutes</strong>
              . Still closing.
            </>
          ) : (
            <>
              it has held steady — neither gaining nor losing. At this pace the gap stays where it
              is, so the finish moves with it.
            </>
          )}
        </p>
      )}

      {!done && state.compressionToFinishOnTime !== null && state.compressionToFinishOnTime > 1.02 && (
        <p className="mt-2 text-[15px] leading-relaxed text-black/75">
          To still finish at {state.plannedEnd}, the remaining{' '}
          {state.minutesRemainingPlanned} minutes of run sheet would have to fit into the time left
          — about{' '}
          <strong>{Math.round(state.compressionToFinishOnTime * 10) / 10}× faster</strong> than the
          planned lengths.
        </p>
      )}

      {!done && state.projectedEndAtObservedPace && state.projectedEndAtPlannedPace && (
        <p className="mt-2 text-sm leading-relaxed text-black/60">
          Two ways to read the finish: <strong>{state.projectedEndAtPlannedPace}</strong> if every
          remaining item takes exactly its planned length, or{' '}
          <strong>{state.projectedEndAtObservedPace}</strong> if the rest keeps moving at the pace
          the show has averaged. The truth is usually between them.
        </p>
      )}

      {error && (
        <p className="mt-3 rounded-xl border-2 border-[var(--danger)] bg-[var(--danger-bg)] p-3 font-semibold text-[var(--danger)]">
          {error}
        </p>
      )}

      <div className="mt-4 flex items-center justify-between gap-3">
        <p className="text-sm text-black/55">
          {done
            ? 'Every item, planned against what actually happened.'
            : 'Tap an item when it starts. Everything after it re-times itself.'}
        </p>
        <button
          type="button"
          onClick={() => setShowSetup((v) => !v)}
          className="shrink-0 rounded-lg px-2 py-1 text-sm font-semibold underline decoration-dotted"
        >
          {showSetup ? 'Hide set-up' : 'Show set-up'}
        </button>
      </div>

      <ol className="mt-3 space-y-1.5">
        {visible.map((item) => {
          const isCurrent = item.status === 'current'
          const late = (item.driftMinutes ?? 0) > 0

          return (
            <li
              key={item.key}
              className="rounded-xl border-2 p-2.5"
              style={{
                borderColor: isCurrent
                  ? 'var(--green)'
                  : item.status === 'done'
                    ? 'var(--line)'
                    : 'var(--line)',
                background: isCurrent
                  ? 'var(--ok-bg)'
                  : item.status === 'done'
                    ? 'transparent'
                    : 'var(--card)',
                opacity: item.status === 'done' && !item.actualAt ? 0.65 : 1,
              }}
            >
              <div className="flex items-baseline gap-2.5">
                <span className="w-16 shrink-0 text-right text-sm font-bold tabular-nums text-black/45">
                  {item.plannedAt}
                </span>

                <span className="min-w-0 flex-1">
                  <span className="font-bold leading-snug">
                    {item.number ? `${item.number}. ` : ''}
                    {item.title}
                  </span>
                  {item.who && (
                    <span className="block text-xs leading-snug text-black/50">{item.who}</span>
                  )}
                  <span className="mt-0.5 block text-xs">
                    {item.source === 'scanner' || item.source === 'marked' ? (
                      <span
                        className="font-semibold"
                        style={{ color: late ? 'var(--warn)' : 'var(--ok)' }}
                      >
                        {item.source === 'scanner' ? 'Measured' : 'Started'} {item.actualAt}
                        {item.driftMinutes !== null && item.driftMinutes !== 0 && (
                          <> · {driftWords(item.driftMinutes)}</>
                        )}
                        {item.source === 'scanner' && (
                          <span className="text-black/45"> · from the scanner</span>
                        )}
                      </span>
                    ) : item.source === 'estimated' ? (
                      <span className="text-black/55">
                        <span className="italic">About {item.actualAt}</span>
                        {item.driftMinutes !== null && item.driftMinutes !== 0 && (
                          <> · {driftWords(item.driftMinutes)}</>
                        )}
                      </span>
                    ) : item.source === 'projected' ? (
                      <span className="text-black/50">On track for {item.actualAt}</span>
                    ) : (
                      <span className="text-black/35">Time not recorded</span>
                    )}
                  </span>
                </span>

                {/* Keyed on where the time came from, not on whether one is
                    shown: an upcoming item now carries a projected time too,
                    and treating that as "already marked" is what hid the
                    button. Only a real mark can be cleared. */}
                <span className="shrink-0 self-center">
                  {item.source === 'scanner' ? (
                    <span className="text-xs font-semibold text-black/35">auto</span>
                  ) : item.source === 'marked' ? (
                    <button
                      type="button"
                      disabled={busy === item.key}
                      onClick={() => mark(item.key, true)}
                      aria-label={`Clear the start time for ${item.title}`}
                      className="rounded-lg px-2 py-1 text-xs font-semibold underline decoration-dotted disabled:opacity-40"
                    >
                      Clear
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy === item.key}
                      onClick={() => mark(item.key)}
                      aria-label={`Mark ${item.title} as starting now`}
                      className="rounded-lg border-2 border-[var(--line-strong)] bg-white px-3 py-2 text-xs font-bold hover:bg-[var(--cream)] disabled:opacity-40"
                    >
                      {busy === item.key ? '…' : 'Started'}
                    </button>
                  )}
                </span>
              </div>
            </li>
          )
        })}
      </ol>

      <p className="mt-3 text-xs text-black/45">
        Phases: {Object.values(PHASE_LABEL).join(' · ')}. Planned times are from the printed run
        sheet.
      </p>
    </div>
  )
}

function Big({
  label,
  value,
  hint,
  tone,
  small,
}: {
  label: string
  value: string
  hint?: string
  tone?: 'ok' | 'warn' | 'bad'
  small?: boolean
}) {
  const color =
    tone === 'ok'
      ? 'var(--ok)'
      : tone === 'warn'
        ? 'var(--warn)'
        : tone === 'bad'
          ? 'var(--danger)'
          : 'var(--foreground)'
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--card)] p-3">
      <div
        className={`display leading-tight tabular-nums ${small ? 'text-base' : 'text-xl'}`}
        style={{ color }}
      >
        {value}
      </div>
      <div className="mt-1 text-xs font-semibold leading-tight text-black/55">{label}</div>
      {hint && <div className="mt-0.5 text-[11px] leading-tight text-black/40">{hint}</div>}
    </div>
  )
}
