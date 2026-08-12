/**
 * Send one pass email to an address you type out in full.
 *
 *   npx dotenv -e .env.local -- npx tsx scripts/send-test-email.ts you@example.com
 *
 * Deliberately touches no database: it renders a made-up household, so running
 * it can never mark a real guest as having received their pass. The address is
 * a required argument with no default — there is no way to run this and have it
 * pick a recipient for you.
 *
 * While EMAIL_TEST_REDIRECT is set the message goes there instead, whatever you
 * type. That guard lives in the provider and this script cannot reach past it.
 */
import { testRedirectTarget } from '@/lib/email/provider'
import { QR_CID, renderPassQr } from '@/lib/email/qr'
import { createResendProvider } from '@/lib/email/resend'
import { renderPassEmail } from '@/lib/email/templates'

const SAMPLE = {
  display_name: 'Kavitha Raveendra Raja',
  tickets_purchased: 4,
}

function usage(message: string): never {
  console.error(`\n${message}\n`)
  console.error('  npx dotenv -e .env.local -- npx tsx scripts/send-test-email.ts you@example.com\n')
  process.exit(1)
}

async function main() {
  const to = process.argv[2]?.trim()
  if (!to) usage('Pass the recipient address explicitly.')
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) usage(`"${to}" is not an email address.`)

  const base = process.env.APP_BASE_URL?.replace(/\/$/, '') ?? 'http://localhost:3000'
  const href = `${base}/p/SAMPLE-TOKEN-NOT-A-REAL-PASS`

  const qr = await renderPassQr(href)

  const redirect = testRedirectTarget()
  console.log(`from:     ${process.env.EMAIL_FROM ?? '(EMAIL_FROM unset — provider default)'}`)
  console.log(`to:       ${to}`)
  console.log(`qr:       ${qr ? `embedded as cid:${QR_CID}` : 'FAILED — sending link-only'}`)
  if (redirect) {
    console.log(`redirect: EMAIL_TEST_REDIRECT is set — this will arrive at ${redirect}`)
  } else {
    console.log('redirect: EMAIL_TEST_REDIRECT is NOT set — this will go to the address above')
  }
  console.log('')

  const message = {
    to,
    ...renderPassEmail(SAMPLE, href, { qrCid: qr ? QR_CID : null }),
    attachments: qr ? [qr] : undefined,
  }
  const result = await createResendProvider().send(message)

  if (result.ok) {
    console.log(`sent to ${result.deliveredTo} (id ${result.providerMessageId ?? 'n/a'})`)
    return
  }
  console.error(`not sent: ${result.error}`)
  process.exitCode = 1
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
