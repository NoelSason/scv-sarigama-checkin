import { notFound } from 'next/navigation'
import QRCode from 'qrcode'
import { findByToken, passUrl } from '@/lib/households'
import { PassStatus } from './PassStatus'

export const dynamic = 'force-dynamic'

export default async function PassPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const household = await findByToken(token)
  if (!household) notFound()

  const url = passUrl(household.pass_token)

  // The QR encodes the pass URL and nothing else. No balance, no name, no id —
  // so a screenshot taken this morning still resolves to the live balance.
  const qrSvg = await QRCode.toString(url, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2, // quiet zone; nothing decorative may intrude here
    color: { dark: '#000000', light: '#ffffff' },
  })

  const isValid =
    household.pass_enabled && (household.payment_status === 'paid' || household.payment_status === 'comped')

  // Raffle entries are narrower than admission: one per ticket actually bought.
  // Complimentary passes get into the Sadhya but did not buy an entry, and the
  // demo households are not real people. Neither sees this card at all —
  // "0 entries" only invites a question a volunteer cannot answer.
  const raffleEntries =
    household.payment_status === 'paid' && !household.is_test ? household.tickets_purchased : 0

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 py-8">
      <header className="text-center">
        <p className="text-sm font-bold uppercase tracking-[0.2em] text-[var(--gold-deep)]">
          SCV Sarigama
        </p>
        <h1 className="mt-1 text-3xl font-black text-[var(--green-deep)]">Onam 2026</h1>
      </header>

      <h2 className="mt-6 text-center text-2xl font-bold break-words">{household.display_name}</h2>

      {isValid ? (
        <>
          <div className="mt-6 rounded-3xl border border-black/10 bg-white p-5 shadow-sm">
            {/* Dark on white, full width, nothing overlapping the quiet zone. */}
            <div
              className="mx-auto w-full [&>svg]:h-auto [&>svg]:w-full"
              dangerouslySetInnerHTML={{ __html: qrSvg }}
            />
          </div>

          <PassStatus
            token={household.pass_token}
            initialPurchased={household.tickets_purchased}
            initialRedeemed={household.tickets_redeemed}
          />

          {/* Server-rendered, and deliberately not part of PassStatus: that
              component polls the admissions balance, which falls all day.
              Entries come from tickets bought and do not move, so this number
              must never flicker in sympathy with the one above it. */}
          {raffleEntries > 0 && (
            <section className="mt-6 rounded-3xl border border-[var(--gold)]/40 bg-[var(--cream)] p-5 text-center">
              <p className="text-sm font-bold uppercase tracking-widest text-[var(--gold-deep)]">
                Raffle
              </p>
              <p className="mt-1 text-5xl font-black tabular-nums text-[var(--gold-deep)]">
                {raffleEntries}
              </p>
              <p className="mt-1 text-lg font-semibold">
                {raffleEntries === 1 ? 'entry in the raffle' : 'entries in the raffle'}
              </p>
              <p className="mt-2 text-sm leading-relaxed text-black/65">
                Every ticket is one entry. Your entries stay in the draw whether or not you
                use all your admissions — you don&apos;t need to be here to win.
              </p>
            </section>
          )}

          {household.children_under_6 > 0 && (
            <p className="mt-4 rounded-xl bg-[var(--cream)] px-4 py-3 text-center text-sm">
              Plus {household.children_under_6} child
              {household.children_under_6 === 1 ? '' : 'ren'} under 6, who enter free — no
              admission needed.
            </p>
          )}

          <div className="mt-6 rounded-2xl bg-white/70 p-5 text-[15px] leading-relaxed">
            <p className="font-semibold">Show this QR code at the Sadhya entrance.</p>
            <p className="mt-2 text-black/70">
              You can screenshot it or share it with your family — everyone can use the same
              code. Admissions are counted as they&apos;re used, so the number above always
              shows what&apos;s left.
            </p>
          </div>
        </>
      ) : (
        <div className="mt-8 rounded-2xl border-2 border-[var(--warn)] bg-[var(--warn-bg)] p-6 text-center">
          <p className="text-2xl font-black text-[var(--warn)]">Not ready yet</p>
          <p className="mt-3 text-[15px] leading-relaxed">
            This pass isn&apos;t active. Please visit the registration desk when you arrive and
            a volunteer will sort it out.
          </p>
        </div>
      )}

      <footer className="mt-auto pt-10 text-center text-xs text-black/40">
        SCV Sarigama Onam 2026
      </footer>
    </main>
  )
}
