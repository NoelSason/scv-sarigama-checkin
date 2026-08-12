import QRCode from 'qrcode'
import type { EmailAttachment } from './provider'

/**
 * The pass QR, as embeddable PNG bytes.
 *
 * Its own module so the CLI preview script can build the exact same attachment
 * the real send builds, without importing the send path and dragging the
 * database in behind it.
 */

/** Referenced by the template as `cid:pass-qr`. */
export const QR_CID = 'pass-qr'

/**
 * Encodes the pass URL and nothing else — no balance, no name, no id — so the
 * code a guest screenshots this morning still resolves to the live balance at
 * the door, and is byte-for-byte the same code the pass page shows.
 *
 * A failure here must not cost the guest their email: callers fall back to a
 * link-only message rather than aborting the send.
 */
export async function renderPassQr(passHref: string): Promise<EmailAttachment | null> {
  try {
    const content = await QRCode.toBuffer(passHref, {
      type: 'png',
      errorCorrectionLevel: 'M',
      margin: 2, // quiet zone; nothing decorative may intrude here
      width: 648, // 3x the 216px display size, for retina and for scanning off a laptop
      color: { dark: '#000000', light: '#ffffff' },
    })
    return { filename: 'sadhya-pass.png', content, contentType: 'image/png', contentId: QR_CID }
  } catch (err) {
    console.error('[email] QR generation failed; sending link-only pass', err)
    return null
  }
}
