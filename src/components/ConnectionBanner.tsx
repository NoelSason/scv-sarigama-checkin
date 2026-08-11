'use client'

import { useEffect, useState } from 'react'

/**
 * Offline warning.
 *
 * We deliberately do NOT allow offline redemption: two phones offline at the
 * same entrance would both think they had the last ticket. So the honest thing
 * is to tell the volunteer plainly to stop and wait, rather than let the UI
 * appear to work.
 */
export function ConnectionBanner() {
  const [online, setOnline] = useState(true)

  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    update()
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])

  if (online) return null

  return (
    <div
      role="alert"
      className="sticky top-0 z-30 bg-[var(--danger)] px-4 py-3 text-center text-white"
    >
      <p className="text-lg font-black">⚠ Connection unavailable — do not redeem yet</p>
      <p className="text-sm">
        Wait for signal to return. Do not admit anyone based on a screen showing an old balance.
      </p>
    </div>
  )
}
