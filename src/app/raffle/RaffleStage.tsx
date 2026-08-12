'use client'

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { RafflePoolEntry, RaffleState } from '@/lib/raffle'
import { Confetti } from './Confetti'

/*
 * Reel geometry.
 *
 * The wheel is measured in CARDS, not pixels, so a phone and a projector see
 * the same number of names go past at the same rate — only the card width
 * changes (a CSS media query owns that).
 *
 * Deceleration is a cubic ease-out. Quintic was tried first and is wrong: it
 * dumps 99.99% of the distance in the first two thirds and then sits frozen
 * for two seconds. Cubic leaves ~11 cards to travel in the final two seconds,
 * which is what produces the tick… tick… tick everyone is waiting for.
 */
const STRIP_LEN = 440
const WINNER_INDEX = 420
const MAIN_MS = 6800
const SETTLE_MS = 480
/** Fraction of a card the reel runs past the winner before springing back. */
const OVERSHOOT = 0.34
/** Ambient drift while idle, px per ms. A dead-still reel looks like a crash. */
const DRIFT = 0.045

type Winner = {
  drawId: string
  name: string
  prize: string
  entries: number
  poolEntries: number
  poolHouseholds: number
}

/**
 * `nextState` rides along through the spin instead of being applied when the
 * draw returns. The database decides the winner the moment SPIN is pressed, so
 * the new pool — winners list one longer, counter one name shorter — is
 * available six seconds before the wheel stops. Showing it then announces the
 * result while the names are still moving. It lands with the reel.
 */
type Phase =
  | { kind: 'idle' }
  | { kind: 'spinning'; winner: Winner; nextState: RaffleState }
  | { kind: 'won'; winner: Winner }

const REDUCED_MOTION = '(prefers-reduced-motion: reduce)'

/**
 * Reduce motion is not "slightly calmer" here — it means no reel, no shake, no
 * confetti. The draw still happens and the winner still appears.
 *
 * Subscribed rather than read once, so someone who flips the OS setting to
 * calm the screen down mid-event gets it on the next draw without a reload.
 */
function usePrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mq = window.matchMedia(REDUCED_MOTION)
      mq.addEventListener('change', onChange)
      return () => mq.removeEventListener('change', onChange)
    },
    () => window.matchMedia(REDUCED_MOTION).matches,
    () => false,
  )
}

/** Fisher-Yates. Returns a new array; never mutates the caller's. */
function shuffled(items: string[]): string[] {
  const out = items.slice()
  for (let i = out.length - 1; i > 0; i--) {
    const j = (Math.random() * (i + 1)) | 0
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

// ---------------------------------------------------------------------------
// Sound. Oscillators only — no audio files to ship, cache, or fail to load on
// venue wifi. The SPIN click is the gesture that unlocks the AudioContext.
// ---------------------------------------------------------------------------

function useStageAudio() {
  const ctxRef = useRef<AudioContext | null>(null)

  const unlock = useCallback(() => {
    type WithWebkit = typeof window & {
      webkitAudioContext?: typeof AudioContext
    }
    const Ctor = window.AudioContext ?? (window as WithWebkit).webkitAudioContext
    if (!Ctor) return
    ctxRef.current ??= new Ctor()
    if (ctxRef.current.state === 'suspended') void ctxRef.current.resume()
  }, [])

  const blip = useCallback(
    (freq: number, ms: number, peak: number, type: OscillatorType = 'square') => {
      const ac = ctxRef.current
      if (!ac) return
      const t = ac.currentTime
      const osc = ac.createOscillator()
      const gain = ac.createGain()
      osc.type = type
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.0001, t)
      gain.gain.exponentialRampToValueAtTime(peak, t + 0.006)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000)
      osc.connect(gain).connect(ac.destination)
      osc.start(t)
      osc.stop(t + ms / 1000 + 0.02)
    },
    [],
  )

  const tick = useCallback(() => blip(1250 + Math.random() * 260, 45, 0.05), [blip])

  /** A rising major triad on the landing. Short — the room is about to cheer. */
  const fanfare = useCallback(() => {
    if (!ctxRef.current) return
    ;[523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      window.setTimeout(() => blip(f, 620, 0.09, 'triangle'), i * 105)
    })
  }, [blip])

  // Stable identity: this object ends up in the dependency list of the spin
  // handler, and a fresh one every render would defeat every useCallback here.
  return useMemo(() => ({ unlock, tick, fanfare }), [unlock, tick, fanfare])
}

// ---------------------------------------------------------------------------
// The reel
// ---------------------------------------------------------------------------

type ReelHandle = {
  spin: (strip: string[], onDone: () => void) => void
  /** Unfreeze after a win and go back to drifting the live pool. */
  resume: () => void
}

type Spin = {
  start: number
  from: number
  mainTo: number
  finalTo: number
  onDone: () => void
}

/**
 * A horizontal strip of names sliding under a fixed pointer.
 *
 * Only the ~15 cards that can be on screen exist in the DOM. The naive version
 * — 440 nodes in a flex row — puts a 100,000px-wide layer under a blur filter,
 * which is a memory problem on the borrowed laptop this will actually run on.
 * Instead a fixed pool of slot nodes is recycled and repositioned every frame,
 * and their text is rewritten as indices scroll past.
 */
function Reel({
  bag,
  onTick,
  apiRef,
}: {
  /** The live pool, one string per entry. Drifted through while idle. */
  bag: string[]
  onTick: () => void
  apiRef: React.RefObject<ReelHandle | null>
}) {
  const windowRef = useRef<HTMLDivElement | null>(null)
  const trackRef = useRef<HTMLDivElement | null>(null)
  const slotsRef = useRef<(HTMLDivElement | null)[]>([])

  const [slotCount, setSlotCount] = useState(10)

  const cardWRef = useRef(240)
  const stripRef = useRef<string[]>(['—'])
  const modeRef = useRef<'drift' | 'spin' | 'frozen'>('drift')
  const spinRef = useRef<Spin | null>(null)
  const xRef = useRef(0)
  const lastXRef = useRef(0)
  const lastCenterRef = useRef(0)
  const lastTickAtRef = useRef(0)
  const onTickRef = useRef(onTick)

  // Latched in an effect, not during render: the rAF loop below is set up once
  // and has to reach the current callback without being torn down to get it.
  useEffect(() => {
    onTickRef.current = onTick
  }, [onTick])

  // The drift order is shuffled here rather than handed down as a prop: the
  // strip is a detail of the animation, it changes randomly, and it belongs in
  // a ref the rAF loop reads — not in React state that re-renders the page.
  //
  // The weighted bag arrives grouped (all ten of a family's entries in a row),
  // which drifts past as a stutter of the same name. Shuffling interleaves it.
  const driftRef = useRef<string[]>(['—'])
  useEffect(() => {
    driftRef.current = bag.length ? shuffled(bag) : ['—']
    // A spin owns the strip until it lands; overwriting it mid-flight would
    // move the winner out from under the pointer.
    if (modeRef.current === 'drift') stripRef.current = driftRef.current
  }, [bag])

  useEffect(() => {
    const measure = () => {
      const el = windowRef.current
      if (!el) return
      const raw = getComputedStyle(el).getPropertyValue('--card-w')
      const cw = parseFloat(raw) || 240
      cardWRef.current = cw
      setSlotCount(Math.ceil(el.clientWidth / cw) + 3)
    }
    measure()
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [])

  useEffect(() => {
    let raf = 0
    let prev = 0

    const nameAt = (i: number) => {
      const s = stripRef.current
      if (!s.length) return ''
      return s[((i % s.length) + s.length) % s.length]
    }

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)

      const el = windowRef.current
      const track = trackRef.current
      if (!el || !track) return

      const dt = prev ? Math.min(now - prev, 64) : 16
      prev = now

      const W = el.clientWidth
      const cw = cardWRef.current
      let x = xRef.current

      const spin = spinRef.current
      if (spin) {
        const t = now - spin.start
        if (t < MAIN_MS) {
          const u = t / MAIN_MS
          x = spin.from + (spin.mainTo - spin.from) * (1 - Math.pow(1 - u, 3))
        } else if (t < MAIN_MS + SETTLE_MS) {
          const u = (t - MAIN_MS) / SETTLE_MS
          x = spin.mainTo + (spin.finalTo - spin.mainTo) * (1 - Math.pow(1 - u, 3))
        } else {
          x = spin.finalTo
          spinRef.current = null
          modeRef.current = 'frozen'
          spin.onDone()
        }
      } else if (modeRef.current === 'drift') {
        x -= dt * DRIFT
      }

      xRef.current = x
      const speed = Math.abs(x - lastXRef.current)
      lastXRef.current = x

      // Motion blur on the track only. Below ~8px a frame the blur is
      // invisible and the filter is pure cost, so it comes off entirely.
      track.style.filter = speed > 8 ? `blur(${Math.min(14, speed / 70).toFixed(2)}px)` : ''

      const center = Math.round(-x / cw - 0.5)
      if (center !== lastCenterRef.current) {
        lastCenterRef.current = center
        // At full speed three cards cross the pointer every frame. Ticking on
        // each one is a buzz, not a reel — so the ticks are rate-limited and
        // naturally thin out into individual clicks as it slows.
        if (modeRef.current === 'spin' && now - lastTickAtRef.current > 55) {
          lastTickAtRef.current = now
          onTickRef.current()
        }
      }

      const first = Math.floor((-x - W / 2) / cw) - 1
      const slots = slotsRef.current
      for (let s = 0; s < slots.length; s++) {
        const node = slots[s]
        if (!node) continue
        const i = first + s
        node.style.transform = `translate3d(${W / 2 + x + i * cw}px,0,0)`

        const label = node.firstElementChild as HTMLElement | null
        const name = nameAt(i)
        if (label && label.textContent !== name) label.textContent = name

        const alt = i % 2 === 0 ? '0' : '1'
        if (node.dataset.alt !== alt) node.dataset.alt = alt

        const hot = i === center && speed < 26 ? '1' : '0'
        if (node.dataset.hot !== hot) node.dataset.hot = hot
      }
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  useEffect(() => {
    const offset = (i: number) => -(i * cardWRef.current + cardWRef.current / 2)

    apiRef.current = {
      spin(strip, onDone) {
        stripRef.current = strip
        const from = offset(0)
        const finalTo = offset(WINNER_INDEX)
        xRef.current = from
        lastXRef.current = from
        lastCenterRef.current = 0
        modeRef.current = 'spin'
        spinRef.current = {
          start: performance.now(),
          from,
          mainTo: finalTo - OVERSHOOT * cardWRef.current,
          finalTo,
          onDone,
        }
      },
      resume() {
        spinRef.current = null
        modeRef.current = 'drift'
        stripRef.current = driftRef.current
      },
    }
    return () => {
      apiRef.current = null
    }
  }, [apiRef])

  return (
    <div ref={windowRef} className="reel-window">
      <div ref={trackRef} className="reel-track">
        {Array.from({ length: slotCount }, (_, s) => (
          <div
            key={s}
            ref={(el) => {
              slotsRef.current[s] = el
            }}
            className="reel-card"
            data-alt="0"
          >
            <span className="reel-card-name" />
          </div>
        ))}
      </div>
      <div className="reel-pointer" />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Strip building
// ---------------------------------------------------------------------------

/**
 * One slot per entry, not per name. A family with ten tickets shows up ten
 * times as often on the wheel — the weighting the database applies is the
 * weighting the room can see go past.
 */
function weightedBag(pool: RafflePoolEntry[]): string[] {
  const bag: string[] = []
  for (const p of pool) for (let i = 0; i < p.entries; i++) bag.push(p.display_name)
  return bag
}

function buildStrip(bag: string[], winnerName: string): string[] {
  const strip = new Array<string>(STRIP_LEN)
  for (let i = 0; i < STRIP_LEN; i++) {
    strip[i] = bag.length ? bag[(Math.random() * bag.length) | 0] : winnerName
  }
  strip[WINNER_INDEX] = winnerName

  // If the winner holds a lot of entries they can land next to themselves,
  // which makes it genuinely unclear which card the pointer stopped on.
  const other = bag.find((n) => n !== winnerName)
  if (other) {
    for (const j of [WINNER_INDEX - 1, WINNER_INDEX + 1]) {
      if (strip[j] === winnerName) strip[j] = other
    }
  }
  return strip
}

// ---------------------------------------------------------------------------
// Stage
// ---------------------------------------------------------------------------

const ERRORS: Record<string, string> = {
  POOL_EMPTY: 'Everyone has already been drawn. Reset to put them all back in.',
  PRIZE_REQUIRED: 'Type the prize first.',
  UNAUTHORIZED: 'Your session expired. Sign in again.',
  INVALID: 'Type the prize first.',
}

export function RaffleStage({ initial }: { initial: RaffleState }) {
  const [state, setState] = useState(initial)
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' })
  const [prize, setPrize] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)
  const [shake, setShake] = useState(false)

  const reduced = usePrefersReducedMotion()

  const reelRef = useRef<ReelHandle | null>(null)
  const audio = useStageAudio()

  const bag = useMemo(() => weightedBag(state.pool), [state.pool])

  /** Everything the room is allowed to know lands at once, with the reel. */
  const land = useCallback(
    (winner: Winner, nextState: RaffleState) => {
      setState(nextState)
      setPhase({ kind: 'won', winner })
      setBusy(false)
      audio.fanfare()
      if (!reduced) {
        setShake(true)
        window.setTimeout(() => setShake(false), 560)
      }
    },
    [audio, reduced],
  )

  const spin = useCallback(async () => {
    if (busy || phase.kind !== 'idle') return
    const p = prize.trim()
    if (!p) {
      setError('Type the prize first.')
      return
    }

    setBusy(true)
    setError(null)
    audio.unlock() // this click is the gesture that lets the reel make noise

    let data: {
      success: boolean
      error?: string
      draw_id?: string
      display_name?: string
      prize?: string
      entries_at_draw?: number
      pool_entries?: number
      pool_households?: number
      spinPool?: RafflePoolEntry[]
      state?: RaffleState
    }
    try {
      const res = await fetch('/api/staff/raffle', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prize: p }),
        cache: 'no-store',
      })
      data = await res.json()
    } catch {
      setError("Couldn't reach the server. Nothing was drawn — try again.")
      setBusy(false)
      return
    }

    if (!data.success) {
      setError(ERRORS[data.error ?? ''] ?? 'That draw did not go through. Try again.')
      setBusy(false)
      return
    }

    const winner: Winner = {
      drawId: data.draw_id!,
      name: data.display_name!,
      prize: data.prize!,
      entries: data.entries_at_draw!,
      poolEntries: data.pool_entries!,
      poolHouseholds: data.pool_households!,
    }
    // Held, not applied. Until the reel stops, the screen must still show the
    // pool as it was — otherwise the winners list names the winner while the
    // wheel is still turning.
    const nextState = data.state ?? state

    if (reduced) {
      land(winner, nextState)
      return
    }

    setPhase({ kind: 'spinning', winner, nextState })
    reelRef.current?.spin(buildStrip(weightedBag(data.spinPool ?? []), winner.name), () =>
      land(winner, nextState),
    )
  }, [audio, busy, land, phase.kind, prize, reduced, state])

  const nextDraw = useCallback(() => {
    setPrize('')
    setError(null)
    setPhase({ kind: 'idle' })
    reelRef.current?.resume()
  }, [])

  const undo = useCallback(
    async (drawId: string) => {
      setBusy(true)
      try {
        const res = await fetch(`/api/staff/raffle/${drawId}`, {
          method: 'DELETE',
          cache: 'no-store',
        })
        const data = await res.json()
        if (!data.success) {
          setError('That draw could not be undone.')
          return
        }
        setState(data.state)
        nextDraw()
      } catch {
        setError("Couldn't reach the server.")
      } finally {
        setBusy(false)
      }
    },
    [nextDraw],
  )

  const reset = useCallback(async () => {
    setBusy(true)
    try {
      const res = await fetch('/api/staff/raffle/reset', {
        method: 'POST',
        cache: 'no-store',
      })
      const data = await res.json()
      if (!data.success) {
        setError('Reset failed.')
        return
      }
      setState(data.state)
      setConfirmReset(false)
      nextDraw()
    } catch {
      setError("Couldn't reach the server.")
    } finally {
      setBusy(false)
    }
  }, [nextDraw])

  const poolEmpty = state.pool.length === 0
  const spinning = phase.kind === 'spinning'

  return (
    <div className={`raffle-root ${shake ? 'stage-shake' : ''}`}>
      {phase.kind === 'won' && !reduced && <Confetti key={phase.winner.drawId} />}

      <div className="relative z-10 mx-auto flex min-h-dvh w-full max-w-6xl flex-col gap-6 px-4 py-6 sm:px-8">
        <header className="flex items-start justify-between gap-4">
          <div>
            <p className="text-xs font-bold uppercase tracking-[0.3em] text-[#e0bb63]">
              SCV Sarigama · Onam 2026
            </p>
            <h1 className="mt-1 text-3xl font-black tracking-tight sm:text-4xl">Raffle</h1>
          </div>

          {/* No mute control: the ticking reel and the fanfare are the point of
              this screen, and a toggle up here is one more thing to knock by
              accident mid-draw. Volume lives on the laptop. */}
          <div className="flex shrink-0 items-center gap-2">
            <a
              href="/staff"
              className="whitespace-nowrap rounded-xl border border-white/20 px-3 py-2 text-sm font-semibold text-white/80 hover:bg-white/10"
            >
              Done
            </a>
          </div>
        </header>

        {/* The reel is full-bleed and the columns sit under it. Boxing it into
            a content column next to the winners list shrinks the one thing the
            whole room is looking at. */}
        <div className="flex flex-1 flex-col justify-center gap-7">
          <Reel bag={bag} onTick={audio.tick} apiRef={reelRef} />

          <div className="grid gap-7 lg:grid-cols-[minmax(0,1fr)_300px]">
            <main className="flex min-w-0 flex-col gap-5">
              {phase.kind === 'won' ? (
                <section className="winner-panel text-center">
                  <p className="text-xs font-bold uppercase tracking-[0.3em] text-[#e0bb63]">
                    {phase.winner.prize}
                  </p>
                  <p className="winner-glow mt-3 text-4xl font-black leading-tight text-[#ffd977] sm:text-6xl">
                    {phase.winner.name}
                  </p>
                  <p className="mt-4 text-sm text-white/60">
                    {phase.winner.entries} {phase.winner.entries === 1 ? 'entry' : 'entries'} ·
                    drawn from {phase.winner.poolEntries.toLocaleString()} entries across{' '}
                    {phase.winner.poolHouseholds.toLocaleString()} names
                  </p>

                  <div className="mt-6 flex flex-wrap justify-center gap-3">
                    <button
                      type="button"
                      onClick={nextDraw}
                      className="rounded-xl bg-[#ffd977] px-7 py-4 text-lg font-black text-[#0b1a13] hover:bg-[#ffe49b] active:scale-[0.98]"
                    >
                      Next draw
                    </button>
                    <button
                      type="button"
                      onClick={() => undo(phase.winner.drawId)}
                      disabled={busy}
                      className="rounded-xl border border-white/25 px-6 py-4 font-semibold text-white/80 hover:bg-white/10 disabled:opacity-50"
                    >
                      Undo this draw
                    </button>
                  </div>
                </section>
              ) : (
                <section className="fade-up">
                  {poolEmpty ? (
                    <div className="rounded-2xl border border-[#ffd977]/40 bg-[#ffd977]/10 p-6 text-center">
                      <p className="text-xl font-black text-[#ffd977]">Everyone has been drawn</p>
                      <p className="mt-2 text-sm text-white/70">
                        No names are left in the pool. Reset below to put them all back in.
                      </p>
                    </div>
                  ) : (
                    <>
                      <label
                        htmlFor="prize"
                        className="block text-xs font-bold uppercase tracking-[0.3em] text-[#e0bb63]"
                      >
                        Prize
                      </label>
                      <div className="mt-2 flex flex-col gap-3 sm:flex-row">
                        <input
                          id="prize"
                          value={prize}
                          onChange={(e) => setPrize(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') void spin()
                          }}
                          disabled={spinning || busy}
                          placeholder="Gold coin, gift hamper, …"
                          maxLength={120}
                          className="min-w-0 flex-1 rounded-xl border border-white/20 bg-black/30 px-4 py-4 text-lg font-semibold text-white placeholder:text-white/30 focus:border-[#ffd977] focus:outline-none disabled:opacity-60"
                        />
                        <button
                          type="button"
                          onClick={() => void spin()}
                          disabled={spinning || busy || !prize.trim()}
                          className="rounded-xl bg-[#ffd977] px-10 py-4 text-xl font-black tracking-wide text-[#0b1a13] hover:bg-[#ffe49b] active:scale-[0.98] disabled:bg-white/20 disabled:text-white/40"
                        >
                          {spinning ? 'Drawing…' : 'SPIN'}
                        </button>
                      </div>
                    </>
                  )}
                </section>
              )}

              {error && (
                <p className="rounded-xl border border-[#ff9d94]/40 bg-[#a4231c]/25 px-4 py-3 text-sm font-semibold text-[#ffcfcb]">
                  {error}
                </p>
              )}
            </main>

            <aside className="flex min-w-0 flex-col gap-3">
              <h2 className="text-xs font-bold uppercase tracking-[0.3em] text-[#e0bb63]">
                Winners ({state.draws.length})
              </h2>

              {state.draws.length === 0 ? (
                <p className="text-sm text-white/45">Nobody drawn yet.</p>
              ) : (
                <ol className="flex max-h-[52vh] flex-col gap-2 overflow-y-auto pr-1">
                  {state.draws.map((d) => (
                    <li
                      key={d.id}
                      className="rounded-xl border border-[#ffd977]/25 bg-white/5 px-4 py-3"
                    >
                      <p className="font-bold text-[#ffd977]">{d.display_name}</p>
                      <p className="mt-0.5 text-sm text-white/70">{d.prize}</p>
                      <button
                        type="button"
                        onClick={() => void undo(d.id)}
                        disabled={busy || spinning}
                        className="mt-1 text-xs font-semibold text-white/40 underline hover:text-white/70 disabled:opacity-40"
                      >
                        Put back in
                      </button>
                    </li>
                  ))}
                </ol>
              )}
            </aside>
          </div>
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-4 border-t border-white/10 pt-4 text-sm">
          <p className="text-white/60">
            <strong className="text-white">{state.households.toLocaleString()}</strong> names ·{' '}
            <strong className="text-white">{state.entries.toLocaleString()}</strong> entries still
            in the pool
          </p>

          {/* Two-step, no browser confirm: a dialog trains people to tap
              through it, and this button un-draws the whole evening. */}
          {confirmReset ? (
            <span className="flex items-center gap-2">
              <span className="text-white/70">Put all {state.draws.length} winners back in?</span>
              <button
                type="button"
                onClick={() => void reset()}
                disabled={busy}
                className="rounded-lg bg-[#a4231c] px-4 py-2 font-bold text-white disabled:opacity-50"
              >
                Yes, reset
              </button>
              <button
                type="button"
                onClick={() => setConfirmReset(false)}
                className="rounded-lg border border-white/25 px-4 py-2 font-semibold text-white/70"
              >
                Cancel
              </button>
            </span>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmReset(true)}
              disabled={busy || spinning || state.draws.length === 0}
              className="rounded-lg border border-white/25 px-4 py-2 font-semibold text-white/70 hover:bg-white/10 disabled:opacity-40"
            >
              Reset raffle
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
