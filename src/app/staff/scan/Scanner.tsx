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

/**
 * Marks that this phone has already been shown the briefing.
 *
 * Per-device rather than per-session: a volunteer who steps away and comes back
 * should land straight on the camera, not on a wall of text with a queue in
 * front of them. Bump the suffix if the steps themselves ever change.
 */
const BRIEF_KEY = 'onam.scan.brief.v1'

export function Scanner({ staffName }: { staffName: string }) {
  const [phase, setPhase] = useState<Phase>({ kind: 'scanning' })
  const [manualOpen, setManualOpen] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // null until localStorage has been read — rendering the briefing before then
  // would flash it at every volunteer who has already dismissed it.
  const [brief, setBrief] = useState<boolean | null>(null)

  // Read after mount, not in the initialiser: the server has no localStorage,
  // so deciding during render would hydrate a different tree than it sent.
  useEffect(() => {
    try {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBrief(localStorage.getItem(BRIEF_KEY) !== 'seen')
    } catch {
      // Private mode, storage disabled — show it once and move on.
      setBrief(true)
    }
  }, [])

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

  const { videoRef, state, backend, message, diag, start, stop } = useQrScanner({
    onScan: lookup,
    paused,
  })

  /**
   * Close the briefing.
   *
   * `openCamera` is what makes it cost nothing: the camera needs a tap to start
   * anyway, so the volunteer who reads the steps spends the same single tap as
   * the one who skips them.
   */
  function dismissBrief(openCamera: boolean) {
    try {
      localStorage.setItem(BRIEF_KEY, 'seen')
    } catch {
      /* nothing to remember it with — the button still works */
    }
    setBrief(false)
    if (openCamera) void start()
  }

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
      {/* ---------------- first-run briefing ----------------
          Sits over the scanner rather than replacing it, so the <video> is
          already mounted when "open camera" fires and start() has something to
          attach the stream to. */}
      {brief === true && (
        <ScannerBrief
          // Reopened from the footer while the camera is already live: closing
          // must not restart the stream underneath it.
          onStart={() => dismissBrief(state !== 'running')}
          onSkip={() => dismissBrief(false)}
        />
      )}

      {/* ---------------- camera ----------------
          Exactly one preview is mounted at a time. html5-qrcode injects its own
          <video> and scan-region graphic, so leaving ours mounted alongside it
          drew two boxes with a dead black band above them.

          Height is capped rather than a fixed aspect ratio: on a phone a 3:4
          preview pushed the quantity buttons below the fold, and a volunteer
          should never have to scroll between scanning and tapping a number. */}
      <div className="relative overflow-hidden rounded-2xl bg-black shadow-[0_0_0_2px_rgba(200,149,28,0.5)]">
        {backend !== 'fallback' && (
          <video
            ref={videoRef}
            muted
            playsInline
            className="h-[42dvh] max-h-[520px] min-h-[240px] w-full object-cover sm:h-[50dvh]"
          />
        )}

        {/* html5-qrcode owns the <video> inside here, and its geometry must not
            be touched.

            It sets only style.width, letting height follow the stream's aspect
            ratio, and then builds its decode canvas at clientWidth ×
            clientHeight and blits the frame into it. Forcing h-full/object-cover
            made that canvas container-shaped while the frame stayed 720×1280, so
            drawImage squashed it about 2× vertically. A QR whose modules are no
            longer square cannot be decoded by anything — which looked exactly
            like a dead scanner.

            So the video keeps its natural size and the CONTAINER does the
            cropping: flex centres it, overflow-hidden trims the excess. Same
            look as object-cover, without lying to the decoder about its shape. */}
        <div
          id="qr-fallback-region"
          className={
            backend === 'fallback'
              ? 'flex max-h-[46dvh] w-full items-center justify-center overflow-hidden [&_video]:shrink-0'
              : 'hidden'
          }
        />

        {/* Our reticle belongs only to the native path — the fallback draws
            its own, and two of them read as a broken screen. */}
        {backend === 'native' && state === 'running' && phase.kind === 'scanning' && (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="h-52 w-52 rounded-2xl border-4 border-[rgba(232,184,75,0.9)] shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
        )}

        {/* Decoder readout.
            "Not scanning" looks the same whether frames never reach the decoder,
            reach it and fail, or decode fine and get swallowed downstream. These
            three numbers tell those apart from across a room, which beats
            plugging a phone into a laptop at an event. */}
        {state === 'running' && (
          <div className="pointer-events-none absolute bottom-1.5 left-1.5 rounded-md bg-black/65 px-2 py-1 font-mono text-[10px] leading-tight text-white/85">
            {backend} · {diag.video ?? 'video ?'} · seen {diag.misses} · read {diag.decodes}
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
        <div className="rounded-2xl bg-[var(--ok)] p-7 text-center text-white shadow-[inset_0_0_0_2px_rgba(232,184,75,0.4)]">
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
        <div className="rounded-2xl bg-[var(--gold-deep)] p-7 text-center text-white shadow-[inset_0_0_0_2px_rgba(255,253,246,0.35)]">
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
          <button
            type="button"
            onClick={() => setBrief(true)}
            className="mt-3 w-full py-2 text-sm font-semibold text-black/55 underline"
          >
            Show me the steps again
          </button>
          <p className="mt-3 text-center text-xs text-black/45">
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
 * The thirty seconds of training a scanner volunteer actually gets.
 *
 * Most of them are handed a phone at the door by someone who is already busy,
 * and /staff/help only helps the volunteer who thinks to go and read it. This
 * catches the one moment they are guaranteed to pass through.
 *
 * One screen, not a carousel: with a queue forming, anything with a "next"
 * button gets tapped through without reading. Everything here is either a step
 * they perform or a mistake that costs the event free meals — the reasoning
 * lives in /staff/help, linked at the bottom.
 *
 * Skip is deliberately as easy as continue. A volunteer who has done this
 * before and gets held hostage by a tutorial is worse off than one who never
 * saw it, and the footer link brings it back any time.
 */
function ScannerBrief({ onStart, onSkip }: { onStart: () => void; onSkip: () => void }) {
  return (
    // Column layout with the buttons pinned: on a phone the steps run past the
    // fold, and a volunteer who has to scroll to find "start" is a volunteer
    // standing at a food line wondering whether the app is broken.
    <div className="fixed inset-0 z-50 flex flex-col bg-[var(--background)]">
      <div className="mx-auto w-full max-w-lg flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
        <div>
          <p className="text-sm font-extrabold tracking-[0.08em] text-black/50">SADHYA SCANNER</p>
          <h1 className="display text-[28px] leading-[36px]">Five steps, every time</h1>
        </div>

        <ol className="card space-y-3 text-[15px] leading-relaxed">
          <BriefStep n={1}>Point the camera at their QR code.</BriefStep>
          <BriefStep n={2}>
            <strong>Read the family name out loud.</strong> That confirms you scanned the right
            code.
          </BriefStep>
          <BriefStep n={3}>
            Ask <strong>&ldquo;how many are eating right now?&rdquo;</strong> — not how many they
            bought.
          </BriefStep>
          <BriefStep n={4}>Tap that number, then confirm it on the next screen.</BriefStep>
          <BriefStep n={5}>
            <strong>Wait for the green screen.</strong> Then let them through.
          </BriefStep>
        </ol>

        <div className="rounded-xl border-2 border-[var(--gold)] bg-[var(--cream)] p-4">
          <p className="font-black">Who needs an admission?</p>
          <p className="mt-1 text-[15px] leading-relaxed">
            Everyone <strong>6 and older</strong>. Children under 6 eat free — don&apos;t count
            them.
          </p>
        </div>

        <div className="rounded-xl border-2 border-[var(--danger)] bg-[var(--danger-bg)] p-4">
          <p className="font-black text-[var(--danger)]">Never</p>
          <ul className="mt-2 space-y-1 text-[15px] font-semibold leading-relaxed">
            <li>• Never let anyone in on a screenshot alone. Only the green screen counts.</li>
            <li>• Never scan while the red connection bar is showing.</li>
            <li>• Never count people who aren&apos;t standing in front of you.</li>
          </ul>
        </div>

        <p className="text-[15px] leading-relaxed text-black/70">
          Tapped the wrong number? The green screen has{' '}
          <strong>&ldquo;Wrong number? Give tickets back&rdquo;</strong>. Anything else looks
          wrong — get the admin. Nothing here is permanent.
        </p>

        <p className="text-center text-sm">
          <Link href="/staff/help" className="text-black/55 underline">
            Full instructions
          </Link>
        </p>
      </div>

      <div className="border-t-2 border-[var(--line)] bg-[var(--card)] p-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        <div className="mx-auto max-w-lg">
          <button type="button" onClick={onStart} className="btn-primary w-full py-6 text-xl">
            Got it — open the camera
          </button>
          <button type="button" onClick={onSkip} className="btn-neutral mt-3 w-full py-4">
            Skip
          </button>
        </div>
      </div>
    </div>
  )
}

function BriefStep({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--green)] text-sm font-black text-white">
        {n}
      </span>
      <span>{children}</span>
    </li>
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
  // Nothing is redeemed straight off a number tap: the count has to survive one
  // more screen that spells out the age rule. See ConfirmCount below.
  const [pending, setPending] = useState<number | null>(null)
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

  if (pending !== null) {
    return (
      <ConfirmCount
        household={household}
        quantity={pending}
        onConfirm={() => onChoose(pending)}
        onBack={() => setPending(null)}
      />
    )
  }

  // Never offer a button that would fail. Buttons are capped at remaining.
  //
  // The cap used to be 6, which put every larger family behind the "Other" box:
  // a household of 10 arrives together, the volunteer sees six buttons, and the
  // way to admit all ten is to notice a text field, type, and press Go with a
  // queue waiting. Twelve covers essentially every real household, and the
  // typed fallback stays for the rare one above it.
  const quickMax = Math.min(remaining, 12)
  const quick = Array.from({ length: quickMax }, (_, i) => i + 1)

  return (
    <div className="card border-2 border-[var(--green)] shadow-[0_6px_18px_-12px_rgba(18,74,51,0.5)]">
      <p className="display text-[26px] leading-[34px] break-words">{household.display_name}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <StatusPill status={household.payment_status} />
        <span className="text-sm text-black/60">
          {household.tickets_purchased} bought · {household.tickets_redeemed} used
        </span>
      </div>

      <p className="display mt-4 text-center text-[52px] leading-none tabular-nums text-[var(--green-deep)]">
        {remaining}
      </p>
      <p className="text-center font-extrabold tracking-[0.08em]">REMAINING</p>

      <p className="mt-6 text-center text-lg font-black">HOW MANY ARE ENTERING?</p>
      <p className="mt-1 text-center text-sm font-bold text-[var(--green-deep)]">
        Count every child 6 and older. Under 6 eat free.
      </p>

      <div className="mt-3 grid grid-cols-3 gap-3">
        {quick.map((n) => (
          <button
            key={n}
            type="button"
            onClick={() => setPending(n)}
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
            onClick={() => setPending(Number(custom))}
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
 * The age check, and the last stop before admissions are consumed.
 *
 * The free-under-6 rule is the one thing a family can get wrong in good faith:
 * "the kids are free" is true right up until a child turns six, and the number
 * a parent says at the door reflects what they believe, not what they were
 * charged for. A line of small print above the keypad gets read once on the
 * first family of the day and never again, so the rule gets its own screen with
 * the count already on it — the volunteer cannot reach the green screen without
 * looking at the number and the rule together.
 *
 * It doubles as the mis-tap catch. Before this, a fat-thumbed 6 went straight
 * through and had to be walked back through Give back.
 */
function ConfirmCount({
  household,
  quantity,
  onConfirm,
  onBack,
}: {
  household: Household
  quantity: number
  onConfirm: () => void
  onBack: () => void
}) {
  const under6 = household.children_under_6

  return (
    <div className="card border-2 border-[var(--gold)]">
      <p className="text-center text-sm font-extrabold tracking-[0.08em] text-black/55">
        ADMITTING
      </p>
      <p className="display text-center text-[64px] leading-none tabular-nums text-[var(--green-deep)]">
        {quantity}
      </p>
      <p className="mt-1 text-center text-lg font-bold break-words">{household.display_name}</p>

      <div className="mt-5 rounded-xl border-2 border-[var(--gold)] bg-[var(--cream)] p-4 text-center">
        <p className="text-lg font-black">Any children with them?</p>
        <p className="mt-2 font-semibold">
          Every child <span className="text-[var(--danger)]">6 and older</span> needs an admission.
          Only under 6 eat free.
        </p>
        {under6 > 0 && (
          <p className="mt-3 text-sm font-bold text-black/70">
            This family registered {under6} child{under6 === 1 ? '' : 'ren'} under 6. Check they are
            still under 6.
          </p>
        )}
      </div>

      <button type="button" onClick={onConfirm} className="btn-primary mt-5 w-full py-6 text-2xl">
        Yes — admit {quantity}
      </button>
      <button type="button" onClick={onBack} className="btn-neutral mt-3 w-full">
        Change the number
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

  // Same reach as the admit grid: a family of ten counted wrong has to be able
  // to get all ten back without a text field.
  const quick = Array.from({ length: Math.min(max, 12) }, (_, i) => i + 1)

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
          className="w-full rounded-xl border-2 border-[var(--line)] bg-[var(--card)] p-4 text-left transition hover:bg-[var(--cream)] active:scale-[0.99]"
        >
          <span className="block text-lg font-extrabold">{h.display_name}</span>
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
