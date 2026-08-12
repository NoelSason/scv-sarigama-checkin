import { query } from '@/lib/db'
import { logAudit, type Household } from '@/lib/households'
import { testRedirectTarget } from './provider'
import { sendPassEmail } from './index'

/**
 * Send passes to anyone who has paid and does not have one yet.
 *
 * Deliberately written as "find everyone owed a pass" rather than "send this
 * household their pass on the way past". A per-payment hook has to be added to
 * every path money can arrive by — Square webhook, sheet sync, walk-in, an email
 * address filled in days after payment — and the day one of those is missed, a
 * guest silently never receives their ticket and nothing looks wrong.
 *
 * Asking the question from the other end means every path is covered by the same
 * code, and a path that forgets to call this is caught by the next one that does.
 *
 * Idempotent: a household with a successful pass delivery on record is never
 * picked up again, so calling this from several places, or twice in a row, sends
 * nothing extra.
 */

/** Kept small: this runs inside a webhook and a sync that both have deadlines. */
const MAX_PER_RUN = 10

/** Under Resend's 2/second. */
const GAP_MS = 400

export type DispatchResult = {
  sent: number
  failed: number
  skipped: 'disabled' | 'test-redirect' | null
  recipients: string[]
}

/**
 * `AUTO_SEND_PASSES=off` stops all automatic sending without a deploy.
 *
 * Worth having: this is the one piece of the system that reaches guests without
 * a human pressing anything, and the ability to stop it from a dashboard in
 * thirty seconds is the difference between a mistake and an incident.
 */
function autoSendEnabled(): boolean {
  return (process.env.AUTO_SEND_PASSES ?? '').trim().toLowerCase() !== 'off'
}

export async function dispatchPendingPasses(
  reason: string,
  limit = MAX_PER_RUN,
): Promise<DispatchResult> {
  if (!autoSendEnabled()) {
    return { sent: 0, failed: 0, skipped: 'disabled', recipients: [] }
  }

  /**
   * Refuse to run while the test redirect is on, rather than sending to it.
   *
   * A redirected send is still recorded as a successful delivery — that is
   * correct, it did leave the building — so the household would be marked done
   * and never picked up again. The guest would silently never receive a pass,
   * and the ledger would insist they had. There is no way to notice that until
   * somebody is turned away at the door.
   *
   * A human running the sender by hand can see the redirect warning printed and
   * decide; an automatic dispatcher has nobody to warn, so it declines.
   */
  const redirect = testRedirectTarget()
  if (redirect) {
    console.warn(
      `[dispatch] skipped (${reason}): EMAIL_TEST_REDIRECT is set to ${redirect}. ` +
        'Automatic sending stays off until it is cleared, so nobody is marked ' +
        'as having received a pass that only reached the test inbox.',
    )
    return { sent: 0, failed: 0, skipped: 'test-redirect', recipients: [] }
  }

  // The gate mirrors sendPassEmail() exactly, plus "has never had one".
  const pending = await query<Household>(
    `select h.*
       from households h
      where not h.is_test
        and h.merged_into_id is null
        and h.pass_enabled
        and h.payment_status in ('paid', 'comped')
        and coalesce(trim(h.email), '') <> ''
        and not exists (
          select 1 from email_deliveries d
           where d.household_id = h.id
             and d.kind = 'pass'
             and d.status = 'sent'
             -- Must have reached THIS guest. A delivery recorded against a
             -- different address (a redirect, or an address later corrected)
             -- is not evidence that they hold a pass.
             and lower(d.to_email) = lower(trim(h.email))
        )
      order by h.created_at
      limit $1`,
    [limit],
  )

  if (pending.length === 0) return { sent: 0, failed: 0, skipped: null, recipients: [] }

  let sent = 0
  let failed = 0
  const recipients: string[] = []

  for (const [i, household] of pending.entries()) {
    try {
      const result = await sendPassEmail(household, 'pass')
      if (result.ok) {
        sent++
        recipients.push(household.email ?? '')
      } else {
        failed++
      }
    } catch (err) {
      // A failed send must never take down the webhook or sync that triggered
      // it — losing the payment record is far worse than a late pass, and the
      // next run picks this household up again anyway.
      failed++
      console.error(`[dispatch] send threw for ${household.id}:`, err)
    }
    if (i < pending.length - 1) await new Promise((r) => setTimeout(r, GAP_MS))
  }

  if (sent > 0 || failed > 0) {
    await logAudit('passes_auto_sent', {
      actorType: 'system',
      metadata: { reason, sent, failed, recipients },
    })
  }

  return { sent, failed, skipped: null, recipients }
}

/**
 * Fire-and-forget wrapper for callers that must not wait or fail.
 *
 * Awaited rather than truly detached: a serverless function is frozen the moment
 * it responds, so a promise left running would simply never finish. The cost is
 * a few seconds on a webhook that is not latency-sensitive.
 */
export async function dispatchPendingPassesSafely(reason: string): Promise<DispatchResult> {
  try {
    return await dispatchPendingPasses(reason)
  } catch (err) {
    console.error('[dispatch] failed:', err)
    return { sent: 0, failed: 0, skipped: null, recipients: [] }
  }
}
