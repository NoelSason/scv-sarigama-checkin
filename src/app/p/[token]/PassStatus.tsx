'use client'

import { useCallback, useEffect, useState } from 'react'

/**
 * Live balance for the guest.
 *
 * Refreshes on mount, on an interval, and whenever the tab regains focus —
 * so a guest who screenshots the page, walks to the food line, and reopens it
 * sees the real number rather than a stale one. There is still a manual
 * refresh button, because at a venue people trust a button they pressed.
 */
export function PassStatus({
  token,
  initialPurchased,
  initialRedeemed,
}: {
  token: string
  initialPurchased: number
  initialRedeemed: number
}) {
  const [purchased, setPurchased] = useState(initialPurchased)
  const [redeemed, setRedeemed] = useState(initialRedeemed)
  const [state, setState] = useState<'idle' | 'loading' | 'offline'>('idle')

  const refresh = useCallback(async () => {
    setState('loading')
    try {
      const res = await fetch(`/api/pass/${token}`, { cache: 'no-store' })
      if (!res.ok) throw new Error('lookup failed')
      const data = await res.json()
      setPurchased(data.tickets_purchased)
      setRedeemed(data.tickets_redeemed)
      setState('idle')
    } catch {
      setState('offline')
    }
  }, [token])

  useEffect(() => {
    void refresh()
    const timer = setInterval(refresh, 30_000)
    const onFocus = () => void refresh()
    document.addEventListener('visibilitychange', onFocus)
    window.addEventListener('focus', onFocus)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onFocus)
      window.removeEventListener('focus', onFocus)
    }
  }, [refresh])

  const remaining = Math.max(0, purchased - redeemed)

  return (
    <section className="mt-6 text-center">
      <p className="text-sm font-bold uppercase tracking-widest text-black/50">
        Sadhya admissions
      </p>

      <p
        className={`mt-2 text-6xl font-black tabular-nums ${
          remaining === 0 ? 'text-black/35' : 'text-[var(--green-deep)]'
        }`}
      >
        {remaining}
      </p>
      <p className="mt-1 text-lg font-semibold">
        {remaining === 1 ? 'admission left' : 'admissions left'}
      </p>
      <p className="mt-1 text-sm text-black/55">
        {redeemed} of {purchased} used
      </p>

      {remaining === 0 && (
        <p className="mt-4 rounded-xl bg-[var(--warn-bg)] px-4 py-3 text-sm font-semibold text-[var(--warn)]">
          All admissions have been used. See the registration desk if this looks wrong.
        </p>
      )}

      <button
        type="button"
        onClick={refresh}
        className="btn-neutral mt-5 w-full"
        disabled={state === 'loading'}
      >
        {state === 'loading' ? 'Checking…' : 'Refresh'}
      </button>

      {state === 'offline' && (
        <p className="mt-2 text-sm font-semibold text-[var(--danger)]">
          Couldn&apos;t check just now — this number may be out of date.
        </p>
      )}
    </section>
  )
}
