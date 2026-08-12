import { Resend } from 'resend'
import {
  createLogOnlyProvider,
  withTestRedirect,
  type EmailMessage,
  type EmailProvider,
  type EmailResult,
} from './provider'

const DEFAULT_FROM = 'SCV Sarigama <onboarding@resend.dev>'

/**
 * Not exported. The only way to obtain a working transport is
 * createResendProvider(), which wraps it in the test-redirect guard — so an
 * unguarded sender cannot be constructed from anywhere in the codebase.
 */
class ResendProvider implements EmailProvider {
  readonly name = 'resend'
  private readonly client: Resend

  constructor(apiKey: string) {
    this.client = new Resend(apiKey)
  }

  async send(message: EmailMessage): Promise<EmailResult> {
    try {
      const { data, error } = await this.client.emails.send({
        from: process.env.EMAIL_FROM?.trim() || DEFAULT_FROM,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
        attachments: message.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType,
          contentId: a.contentId,
        })),
      })

      if (error) {
        return { ok: false, error: `${error.name}: ${error.message}`, deliveredTo: message.to }
      }
      return { ok: true, providerMessageId: data?.id ?? null, deliveredTo: message.to }
    } catch (err) {
      // A thrown transport error must not take down a registration-desk request
      // mid-event; the caller records a failed delivery and moves on.
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        deliveredTo: message.to,
      }
    }
  }
}

/**
 * Build the outbound transport.
 *
 * Missing key is a normal state (local dev, CI), not an error: callers get a
 * provider that logs the message and reports failure.
 */
export function createResendProvider(): EmailProvider {
  const apiKey = process.env.RESEND_API_KEY?.trim()
  const base = apiKey
    ? new ResendProvider(apiKey)
    : createLogOnlyProvider('RESEND_API_KEY is not set')
  return withTestRedirect(base)
}
