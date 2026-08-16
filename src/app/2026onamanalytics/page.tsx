import type { Metadata } from 'next'
import { loadOnamAnalytics } from '@/lib/analytics/onam'
import { Analytics } from './Analytics'

/**
 * The public Onam 2026 report.
 *
 * No login, by request: the event is over, the organizing committee is spread
 * across a dozen phones, and a shared password would have been screenshotted
 * into a group chat within the hour anyway.
 *
 * What that costs, and what is done about it:
 *
 *   * The page names guests and says how many seats they bought. It shows no
 *     email address, no phone number, no home address and no payment
 *     identifier, and it describes nobody's device or whereabouts — the log
 *     publishes what the system did, not a profile of the person it did it
 *     for. Anyone who reaches the URL learns who came to a community lunch,
 *     which was public information at the lunch.
 *   * `robots: noindex, nofollow` (set app-wide) keeps it out of search.
 *   * The one write it allows is bounded by the ledger: a caller can only move
 *     a family's "they ate anyway" count between zero and the admissions that
 *     family actually paid for and did not scan. It cannot create a household,
 *     issue an admission, move money, or touch the redemption record.
 *
 * Rendered fresh on every request. A cached post-event report that silently
 * stops matching the database is worse than a slower one.
 */

export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Onam 2026 — the whole day in numbers',
  description: 'How the SCV Sarigama Onam 2026 Sadhya actually ran.',
  robots: { index: false, follow: false },
}

export default async function OnamAnalyticsPage() {
  const data = await loadOnamAnalytics()
  return <Analytics initial={data} />
}
