/**
 * Email transport contract.
 *
 * Deliberately tiny: a subject, two bodies, one recipient. Resend is the only
 * implementation today, but the event runs once and a provider outage the
 * morning of would mean swapping this out under pressure — so nothing above
 * this file knows Resend exists.
 */

/**
 * An embedded file. `contentId` is what makes the QR appear in the body rather
 * than as a paperclip: the HTML references it as `cid:<contentId>`, and because
 * the bytes travel with the message there is no remote image for a client to
 * block. Data URIs would have been simpler and are stripped by Gmail.
 */
export type EmailAttachment = {
  filename: string
  content: Buffer
  contentType: string
  contentId?: string
}

export type EmailMessage = {
  to: string
  subject: string
  html: string
  text: string
  attachments?: EmailAttachment[]
}

export type EmailResult =
  | { ok: true; providerMessageId: string | null; deliveredTo: string }
  | { ok: false; error: string; deliveredTo: string }

export interface EmailProvider {
  readonly name: string
  /** Never throws. A transport failure is a value, not an exception. */
  send(message: EmailMessage): Promise<EmailResult>
}

// ---------------------------------------------------------------------------
// Safety valve
//
// EMAIL_TEST_REDIRECT is the one thing standing between a half-finished build
// and ~92 households receiving a broken pass email that cannot be recalled.
// It is read at SEND time (not at construction) so clearing it in the hosting
// dashboard takes effect on the next request, and it is applied by a decorator
// that wraps every provider before anything else can reach it — no call site
// can forget it, because no call site ever holds an unwrapped provider.
// ---------------------------------------------------------------------------

export function testRedirectTarget(): string | null {
  const raw = process.env.EMAIL_TEST_REDIRECT?.trim()
  return raw && raw.includes('@') ? raw : null
}

function redirectBannerHtml(intended: string): string {
  return (
    `<div style="margin:0;padding:12px 16px;background:#fdf3dd;border-bottom:3px solid #8a5a00;` +
    `font-family:ui-sans-serif,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;` +
    `font-size:13px;line-height:1.5;color:#8a5a00;">` +
    `<strong>TEST REDIRECT.</strong> This message was addressed to ` +
    `<strong>${escapeForBanner(intended)}</strong> and was routed here instead because ` +
    `EMAIL_TEST_REDIRECT is set. No guest received it.` +
    `</div>`
  )
}

function escapeForBanner(value: string): string {
  return value.replace(/[&<>"]/g, (c) => {
    if (c === '&') return '&amp;'
    if (c === '<') return '&lt;'
    if (c === '>') return '&gt;'
    return '&quot;'
  })
}

/**
 * Rewrite a message so it can only reach the test inbox, with the real
 * recipient stated in both the subject and the body — a redirected message
 * must never be mistakable for a real delivery.
 */
export function applyTestRedirect(message: EmailMessage): {
  message: EmailMessage
  redirectedTo: string | null
} {
  const target = testRedirectTarget()
  if (!target) return { message, redirectedTo: null }

  return {
    redirectedTo: target,
    message: {
      // Attachments ride along unchanged: a redirected test must show the same
      // embedded QR the guest would have seen, or it tests nothing.
      ...message,
      to: target,
      subject: `[TEST → ${message.to}] ${message.subject}`,
      html: redirectBannerHtml(message.to) + message.html,
      text: `*** TEST REDIRECT — intended for ${message.to}. No guest received this. ***\n\n${message.text}`,
    },
  }
}

/** The single choke point. Every provider handed out is wrapped in this. */
export function withTestRedirect(provider: EmailProvider): EmailProvider {
  return {
    name: provider.name,
    async send(message) {
      const { message: outgoing, redirectedTo } = applyTestRedirect(message)
      if (redirectedTo) {
        console.info(`[email] redirected: ${message.to} → ${redirectedTo} (EMAIL_TEST_REDIRECT)`)
      }
      return provider.send(outgoing)
    },
  }
}

/**
 * Stand-in used when no API key is configured. Logs the full message so a
 * developer can see exactly what would have gone out, and reports failure so
 * the delivery ledger never records a send that did not happen.
 */
export function createLogOnlyProvider(reason: string): EmailProvider {
  return {
    name: 'log-only',
    async send(message) {
      console.warn(
        [
          `[email] NOT SENT (${reason})`,
          `  to:      ${message.to}`,
          `  subject: ${message.subject}`,
          ...(message.attachments?.length
            ? [
                `  files:   ${message.attachments
                  .map((a) => `${a.filename}${a.contentId ? ` (inline cid:${a.contentId})` : ''}`)
                  .join(', ')}`,
              ]
            : []),
          `  text:`,
          message.text
            .split('\n')
            .map((line) => `    ${line}`)
            .join('\n'),
        ].join('\n'),
      )
      return { ok: false, error: reason, deliveredTo: message.to }
    },
  }
}
