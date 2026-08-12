import { notFound } from 'next/navigation'
import QRCode from 'qrcode'
import { findByToken, logAuditThrottled, passUrl } from '@/lib/households'
import { requestContext } from '@/lib/request-context'
import {
  Greeting,
  KasavuBand,
  KasavuRule,
  Lamp,
  Petals,
  PookalamArc,
  PookalamDot,
} from '@/components/onam'
import { PassStatus } from './PassStatus'

export const dynamic = 'force-dynamic'

/**
 * Printed on the stub so a guest and a volunteer can say the same thing out
 * loud when a QR will not scan. Derived from the pass token, which the guest
 * is already looking at in their address bar — this exposes nothing new.
 */
function serial(token: string): string {
  return `SRG-2026-${token.slice(0, 6).toUpperCase()}`
}

export default async function PassPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  const household = await findByToken(token)
  if (!household) notFound()

  // Every time a guest opens their pass: address, approximate location, browser,
  // and which pass. Throttled to one entry per address per five minutes, because
  // the page polls itself and an open tab would otherwise write a row every
  // thirty seconds.
  //
  // The token is deliberately not recorded — it is the credential that opens the
  // pass, and the audit trail is read by more people than the pass table is.
  const ctx = await requestContext()
  await logAuditThrottled(
    'pass_opened',
    `${household.id}:${ctx.ip ?? 'unknown'}`,
    300,
    {
      actorType: 'guest',
      householdId: household.id,
      metadata: {
        guest: household.display_name,
        remaining: household.tickets_remaining,
        purchased: household.tickets_purchased,
      },
    },
  )

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

  // Both optional. A ticket carrying the wrong date or hall is worse than one
  // carrying neither, so an unset value simply drops the line.
  const eventLine = process.env.EVENT_DATE_LINE?.trim()
  const venue = process.env.EVENT_VENUE?.trim()

  return (
    <div className="relative min-h-dvh overflow-hidden">
      <PookalamArc />
      {isValid && <Petals seed={7} />}

      <main className="relative z-[2] mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 py-7">
        <header className="text-center">
          <Lamp glow className="mx-auto" />
          <p className="mt-2 text-xs font-black uppercase tracking-[0.28em] text-[var(--gold-deep)]">
            SCV Sarigama
          </p>
          <h1 className="display mt-0.5 text-4xl leading-[1.1] text-[var(--green-deep)]">
            Onam 2026
          </h1>
          <Greeting className="mt-1 text-[17px]" />
        </header>

        {isValid ? (
          <>
            {/* ---------------- the ticket ----------------
                A single keepsake object: woven bands top and bottom, a
                perforation, and a tear-off stub carrying the admit count. The
                QR panel inside stays pure black on pure white with its quiet
                zone untouched — ornament frames it and never enters it. */}
            <section
              aria-label="Sadhya pass"
              className="relative mt-5 overflow-hidden rounded-[20px] border-2 border-[var(--gold)] bg-[var(--card)]"
              style={{
                boxShadow:
                  'inset 0 0 0 1px rgba(200,149,28,0.35), inset 0 0 0 4px #FFFDF6, 0 10px 30px -12px rgba(138,100,16,0.35)',
              }}
            >
              <KasavuBand height={8} />

              <div className="px-[18px] pt-[18px] pb-4">
                <div className="flex items-baseline justify-between gap-2">
                  <p className="text-[11px] font-black uppercase leading-4 tracking-[0.22em] text-[var(--gold-deep)]">
                    Sadhya Pass
                  </p>
                  <p className="font-mono text-[11px] font-semibold leading-4 text-black/55">
                    № {serial(household.pass_token)}
                  </p>
                </div>

                <h2 className="display mt-2.5 text-center text-[26px] font-bold leading-tight break-words">
                  {household.display_name}
                </h2>

                <div className="mt-3.5 rounded-2xl border border-[var(--line-strong)] bg-white p-3.5">
                  <div
                    className="mx-auto w-full [&>svg]:h-auto [&>svg]:w-full"
                    dangerouslySetInnerHTML={{ __html: qrSvg }}
                  />
                </div>

                <p className="mt-2.5 text-center text-[13px] leading-[18px] text-black/60">
                  Show this code at the Sadhya entrance · screenshot-friendly
                </p>
              </div>

              {/* Perforation. The two notches are cut out of the card in the
                  page background colour, so the tear reads as a real one. */}
              <div
                aria-hidden
                className="relative h-0 border-t-2 border-dashed border-[rgba(200,149,28,0.55)]"
              >
                <div className="absolute -left-3 -top-3 box-border h-6 w-6 rounded-full border-r-2 border-[rgba(200,149,28,0.55)] bg-[var(--background)]" />
                <div className="absolute -right-3 -top-3 box-border h-6 w-6 rounded-full border-l-2 border-[rgba(200,149,28,0.55)] bg-[var(--background)]" />
              </div>

              <div className="flex items-center gap-3.5 bg-[var(--cream)] px-[18px] pt-3.5 pb-4">
                <div className="shrink-0 border-r border-[var(--line)] pr-3.5 text-center">
                  <p className="text-[10px] font-black uppercase leading-[14px] tracking-[0.2em] text-[var(--gold-deep)]">
                    Admit
                  </p>
                  <p className="display text-[40px] leading-[1.05] tabular-nums text-[var(--green-deep)]">
                    {household.tickets_purchased}
                  </p>
                </div>
                <div className="min-w-0">
                  <p className="text-[13px] font-extrabold leading-[18px] break-words">
                    {household.display_name}{' '}
                    <span className="greeting" lang="ml">
                      · ഓണാശംസകൾ
                    </span>
                  </p>
                  {eventLine && (
                    <p className="mt-[3px] text-[12.5px] leading-[17px] text-black/65">
                      {eventLine}
                    </p>
                  )}
                  {venue && (
                    <p className="mt-px text-[12.5px] leading-[17px] text-black/65">{venue}</p>
                  )}
                </div>
              </div>

              <KasavuBand height={8} />
            </section>

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
              <section className="mt-6 rounded-[18px] border border-[var(--line-strong)] bg-[var(--cream)] p-5 text-center">
                <PookalamDot />
                <p className="mt-2 text-xs font-black uppercase tracking-[0.22em] text-[var(--gold-deep)]">
                  Raffle
                </p>
                <p className="display mt-1 text-[44px] leading-none tabular-nums text-[var(--gold-deep)]">
                  {raffleEntries}
                </p>
                <p className="mt-1 text-[17px] font-bold">
                  {raffleEntries === 1 ? 'entry in the raffle' : 'entries in the raffle'}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-black/65">
                  Every ticket is one entry. Your entries stay in the draw whether or not you
                  use all your admissions — you don&apos;t need to be here to win.
                </p>
              </section>
            )}

            {household.children_under_6 > 0 && (
              <p className="mt-4 rounded-xl border border-[var(--line)] bg-[var(--cream)] px-4 py-3 text-center text-sm">
                Plus {household.children_under_6} child
                {household.children_under_6 === 1 ? '' : 'ren'} under 6, who enter free — no
                admission needed.
              </p>
            )}

            <div className="mt-6 rounded-2xl border border-[var(--line)] bg-white/75 p-5 text-[15px] leading-relaxed">
              <p className="font-semibold">Show this QR code at the Sadhya entrance.</p>
              <p className="mt-2 text-black/70">
                You can screenshot it or share it with your family — everyone can use the same
                code. Admissions are counted as they&apos;re used, so the number above always
                shows what&apos;s left.
              </p>
            </div>
          </>
        ) : (
          <>
            <h2 className="display mt-6 text-center text-2xl font-bold break-words">
              {household.display_name}
            </h2>
            <div className="mt-8 rounded-2xl border-2 border-[var(--warn)] bg-[var(--warn-bg)] p-6 text-center">
              <p className="text-2xl font-black text-[var(--warn)]">Not ready yet</p>
              <p className="mt-3 text-[15px] leading-relaxed">
                This pass isn&apos;t active. Please visit the registration desk when you arrive and
                a volunteer will sort it out.
              </p>
            </div>
          </>
        )}

        <footer className="mt-auto pt-9 text-center">
          <KasavuRule />
          <p className="mt-2.5 text-xs text-black/45">SCV Sarigama Onam 2026</p>
        </footer>
      </main>
    </div>
  )
}
