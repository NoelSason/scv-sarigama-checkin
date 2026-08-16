import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { currentStaff } from '@/lib/auth'
import { loadOnamAnalytics } from '@/lib/analytics/onam'
import { loadSensitive } from '@/lib/analytics/sensitive'
import { AdminAnalytics } from './AdminAnalytics'

/**
 * The full report, behind the volunteer password.
 *
 * Same password as the scanner and the desk — `STAFF_PASSWORD`, through the
 * ordinary session cookie. There is deliberately no second credential to
 * distribute, remember, or leave in a group chat.
 *
 * `currentStaff()` rather than `requireStaff()` so the redirect can carry a
 * `next`, and signing in lands the volunteer back here instead of on the
 * scanner screen.
 *
 * This page shows what the public one will not: addresses, devices, places,
 * individual payment amounts, every correction and its reason, and the full
 * per-family ledger. The sensitive queries are not even issued until the check
 * above has passed.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Onam 2026 — full report',
  description: 'The complete Onam 2026 record, for organizers.',
  robots: { index: false, follow: false },
}

export default async function OnamAdminAnalyticsPage() {
  const staff = await currentStaff()
  if (!staff) redirect(`/staff/login?next=${encodeURIComponent('/2026onamanalytics/admin')}`)

  /*
   * Sequenced, not `Promise.all`.
   *
   * Each loader already fans out into a few dozen parallel queries over Neon's
   * HTTP driver. Running both at once put ~50 fetches in flight for a single
   * page render, which is where transient `fetch failed` errors start showing
   * up — and one failed query blanks the whole report. Waiting for the first
   * batch costs a few hundred milliseconds on a page nobody loads in a hurry.
   */
  const data = await loadOnamAnalytics()
  const sensitive = await loadSensitive()

  return <AdminAnalytics initial={data} sensitive={sensitive} staffName={staff.name} />
}
