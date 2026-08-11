import 'server-only'
import { query, queryOne } from '@/lib/db'
import { findById, logAudit, passUrl, type Household } from '@/lib/households'
import type { EmailProvider } from './provider'
import { createResendProvider } from './resend'
import { renderPassEmail } from './templates'

export type { EmailMessage, EmailProvider, EmailResult } from './provider'
export { PASS_EMAIL_SUBJECT, renderPassEmail } from './templates'

const globalForEmail = globalThis as unknown as { __onamEmailProvider?: EmailProvider }

/**
 * The only way to obtain a sender. Memoized across warm lambda invocations;
 * the test-redirect target is still read per-send inside the provider, so
 * clearing the env var takes effect without a redeploy.
 */
export function getEmailProvider(): EmailProvider {
  if (!globalForEmail.__onamEmailProvider) {
    globalForEmail.__onamEmailProvider = createResendProvider()
  }
  return globalForEmail.__onamEmailProvider
}

export type SendPassResult =
  | { ok: true; deliveryId: string; providerMessageId: string | null }
  | { ok: false; reason: 'NO_EMAIL' | 'PASS_NOT_ACTIVE' | 'SEND_FAILED'; error: string }

function passIsSendable(household: Household): boolean {
  return (
    household.pass_enabled &&
    (household.payment_status === 'paid' || household.payment_status === 'comped')
  )
}

/**
 * Send a household their pass and record the attempt.
 *
 * The ledger row is written as `pending` before the network call, so a request
 * that dies mid-send leaves evidence rather than silence. On completion the row
 * records where the message actually went — which, while EMAIL_TEST_REDIRECT is
 * set, is the test inbox and not the guest. That distinction matters: a row
 * marked sent to the guest's address would later be read as "they already have
 * it" and the real send would skip them.
 */
export async function sendPassEmail(household: Household): Promise<SendPassResult> {
  const to = household.email?.trim()
  if (!to) {
    // Expected for most Zelle households — the payments sheet carries no
    // contact details. They collect their pass at the registration desk.
    return { ok: false, reason: 'NO_EMAIL', error: 'No email address on file' }
  }
  if (!passIsSendable(household)) {
    return {
      ok: false,
      reason: 'PASS_NOT_ACTIVE',
      error: 'Pass is disabled or the payment is not settled',
    }
  }

  const provider = getEmailProvider()
  const message = { to, ...renderPassEmail(household, passUrl(household.pass_token)) }

  const row = await queryOne<{ id: string }>(
    `insert into email_deliveries (household_id, to_email, subject, status, provider)
     values ($1, $2, $3, 'pending', $4)
     returning id`,
    [household.id, to, message.subject, provider.name],
  )
  const deliveryId = row!.id

  const result = await provider.send(message)

  await query(
    `update email_deliveries
        set status              = $2,
            to_email            = $3,
            provider_message_id = $4,
            error               = $5,
            sent_at             = case when $2 = 'sent' then now() else null end
      where id = $1`,
    [
      deliveryId,
      result.ok ? 'sent' : 'failed',
      result.deliveredTo,
      result.ok ? result.providerMessageId : null,
      result.ok ? null : result.error,
    ],
  )

  if (!result.ok) {
    return { ok: false, reason: 'SEND_FAILED', error: result.error }
  }
  return { ok: true, deliveryId, providerMessageId: result.providerMessageId }
}

/**
 * Staff-initiated send from the registration desk. Same path as the automatic
 * send, plus an audit trail of who asked for it.
 */
export async function resendPassEmail(
  householdId: string,
  staffId: string | null,
): Promise<SendPassResult & { household?: Household }> {
  const household = await findById(householdId)
  if (!household) {
    return { ok: false, reason: 'NO_EMAIL', error: 'Household not found' }
  }

  const result = await sendPassEmail(household)

  await logAudit('pass_email_sent', {
    actorType: staffId ? 'staff' : 'system',
    actorId: staffId,
    householdId: household.id,
    metadata: {
      ok: result.ok,
      reason: result.ok ? null : result.reason,
      error: result.ok ? null : result.error,
    },
  })

  return { ...result, household }
}
