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

/**
 * Fold repeat purchases together, but only where the evidence is strong.
 *
 * Same email address is strong: two Square checkouts from one account is not a
 * coincidence, and merging is safe to do without asking.
 *
 * Same name and nothing else is not. Every Zelle row arrives without an email or
 * phone, so name is all there is, and two families sharing a full name is
 * unlikely rather than impossible. The cost of being wrong is folding strangers'
 * tickets onto one pass — so those are flagged for a human to confirm against
 * the sheet, and left alone in the meantime.
 *
 * Already-emailed passes survive a merge: the absorbed row keeps a pointer to
 * the survivor and `findByToken` follows it, so a QR already sitting in
 * somebody's inbox still opens the right pass and still scans at the door.
 */
async function autoMergeConfidentDuplicates(): Promise<number> {
  const { loadHouseholdGroups } = await import('@/lib/duplicates')
  const { planMerge, applyMerge } = await import('@/lib/merge')

  const groups = await loadHouseholdGroups()
  const duplicates = groups.filter((g) => g.members.length > 1)
  if (duplicates.length === 0) return 0

  let mergedCount = 0

  for (const group of duplicates) {
    if (group.basis === 'email') {
      const plan = planMerge(group)
      if (!plan) continue
      try {
        await applyMerge(plan)
        mergedCount++
        await logAudit('households_auto_merged', {
          actorType: 'system',
          householdId: plan.survivor.id,
          metadata: {
            reason: 'same email address',
            absorbed: plan.absorbed.map((a) => a.id),
            ticketsBefore: plan.ticketsBefore,
            ticketsAfter: plan.ticketsAfter,
            name: group.primaryName,
          },
        })
      } catch (err) {
        console.error(`[dispatch] auto-merge failed for ${group.primaryName}:`, err)
      }
      continue
    }

    // Name-only match: record it and move on. The unique index on
    // (kind, source, source_record_id) keeps this to one open item per group
    // however often the sync runs.
    await query(
      `insert into review_items (kind, household_id, source, source_record_id, summary, payload)
       values ('possible_duplicate', $1, 'auto-merge', $2, $3, $4::jsonb)
       on conflict do nothing`,
      [
        group.members[0].id,
        `name:${group.key}`,
        `"${group.primaryName}" appears ${group.members.length} times with the same name but no ` +
          `shared email (${group.ticketsByPurchase.join(' + ')} = ${group.mergedTickets} admissions). ` +
          `Confirm in the sheet whether this is one person before merging.`,
        JSON.stringify({
          name: group.primaryName,
          members: group.members.map((m) => ({
            id: m.id,
            tickets: m.ticketsPurchased,
            source: m.source,
          })),
          mergedTickets: group.mergedTickets,
        }),
      ],
    )
  }

  return mergedCount
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

  // ALWAYS before selecting anyone. A second purchase creates a second
  // household, and mailing that on its own hands the guest a pass for the new
  // ticket alone while their real total sits split across two codes.
  const merged = await autoMergeConfidentDuplicates()
  if (merged > 0) console.log(`[dispatch] auto-merged ${merged} repeat buyer(s) before sending`)

  /**
   * Two conditions, and the second is the one that makes repeat purchases work.
   *
   *   never sent   — no delivery has reached this guest's address
   *   now stale    — the last one was sent when they had a different number of
   *                  admissions, so it understates what they now hold
   *
   * Without the second, somebody who buys again keeps an email claiming 2 while
   * the ledger says 5, and nothing ever corrects it because a pass was, in the
   * narrowest sense, sent.
   */
  const pending = await query<Household>(
    `select h.*
       from households h
      where not h.is_test
        and h.merged_into_id is null
        and h.pass_enabled
        and h.payment_status in ('paid', 'comped')
        and coalesce(trim(h.email), '') <> ''
        and coalesce(
              (select d.tickets_at_send
                 from email_deliveries d
                where d.household_id = h.id
                  and d.kind = 'pass'
                  and d.status = 'sent'
                  -- Must have reached THIS guest. A delivery recorded against a
                  -- different address (a redirect, or an address later
                  -- corrected) is not evidence that they hold a pass.
                  and lower(d.to_email) = lower(trim(h.email))
                order by d.sent_at desc nulls last
                limit 1),
              -1
            ) <> h.tickets_purchased
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
