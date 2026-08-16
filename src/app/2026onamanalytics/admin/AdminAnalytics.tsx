'use client'

import Link from 'next/link'
import type { OnamAnalytics } from '@/lib/analytics/types'
import type { SensitiveAnalytics } from '@/lib/analytics/sensitive'
import { Analytics } from '../Analytics'
import { Tips } from '../Tips'
import { EventLog } from '../EventLog'
import { ChartFrame, ShareBar } from '../charts'

/*
 * The staff-only report.
 *
 * Composed rather than forked: the whole public page renders first, unchanged,
 * and everything sensitive is appended after it. That way there is exactly one
 * implementation of the shared report, and no chance of a prop default quietly
 * turning a private section on for the public route — the public page does not
 * import any of this.
 *
 * Density is deliberate down here. This is a reference for whoever runs the
 * event next year, not something anyone reads front to back.
 */

function money(cents: number | null): string {
  if (cents === null) return '—'
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  })
}

function when(iso: string | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
  })
}

export function AdminAnalytics({
  initial,
  sensitive,
  staffName,
}: {
  initial: OnamAnalytics
  sensitive: SensitiveAnalytics
  staffName: string
}) {
  const s = sensitive
  const m = initial.money

  return (
    <div>
      <Analytics initial={initial} />

      <div className="mx-auto max-w-5xl space-y-12 px-4 pb-16 sm:px-6">
        <section className="rounded-2xl border-2 border-[var(--gold)] bg-[var(--cream)] p-5">
          <h2 className="display text-2xl leading-8 text-[var(--gold-deep)]">
            Everything else — organizers only
          </h2>
          <p className="mt-1.5 text-[15px] leading-relaxed text-black/70">
            Signed in as {staffName}. Below this line is the detail the public page leaves out:
            addresses, devices, places, individual payment amounts, every correction and its
            reason, and the full per-family ledger. It is behind the volunteer password.{' '}
            <Link href="/2026onamanalytics" className="font-semibold underline">
              The public version is here
            </Link>
            .
          </p>
        </section>

        {/* ------------------------------------------------------------ money */}
        <section>
          <Head title="The money" blurb="Recorded against each family's ledger row, never inferred from a payment amount." />
          <div className="mt-4 grid gap-4 lg:grid-cols-2 lg:items-start [&>*]:min-w-0">
            <ChartFrame title="How people paid" subtitle="Share of everything collected.">
              <ShareBar
                rows={m.byMethod.map((r) => ({
                  key: r.key,
                  label: r.label,
                  value: r.cents,
                  detail: `${r.households} families · ${r.guests} admissions · ${r.checkedIn} scanned in`,
                }))}
                unit="the money"
                format={(v) => money(v)}
              />
            </ChartFrame>
            <div className="grid grid-cols-2 gap-3 self-start">
              <Stat label="Total collected" value={money(m.totalCents)} />
              <Stat label="Per admission" value={money(m.averagePerAdmissionCents)} hint="average" />
              <Stat label="Per family" value={money(m.averagePerHouseholdCents)} hint="average" />
              <Stat
                label="Taken at the door"
                value={money(m.walkInCents)}
                hint={`${m.walkInAdmissions} walk-up admissions`}
              />
              {m.donationCents > 0 && <Stat label="Donations" value={money(m.donationCents)} />}
              {m.abandonedCheckouts > 0 && (
                <Stat label="Abandoned checkouts" value={m.abandonedCheckouts} hint="never paid" />
              )}
            </div>
          </div>

          {initial.registration.walkIns.length > 0 && (
            <ChartFrame title="Walk-ups, in the order they arrived" subtitle="Sold at the desk on the day.">
              <Table
                head={['Time', 'Name', 'Seats', 'Paid']}
                rows={initial.registration.walkIns.map((w) => [
                  when(w.at),
                  w.name,
                  String(w.guests),
                  money(w.cents),
                ])}
              />
            </ChartFrame>
          )}

          {s.refunds.length > 0 && (
            <ChartFrame title="Refunds" subtitle="Netted out of the totals above.">
              <Table
                head={['When', 'Provider', 'Family', 'Amount']}
                rows={s.refunds.map((r) => [when(r.at), r.provider, r.household ?? '—', money(r.cents)])}
              />
            </ChartFrame>
          )}
        </section>

        {/* -------------------------------------------------- where and what */}
        <section>
          <Head
            title="Where and what"
            blurb="Approximate location from the network each device was on, and the browser it used. Recorded by the app for security; never shown publicly."
          />
          <div className="mt-4 grid gap-4 lg:grid-cols-2 lg:items-start [&>*]:min-w-0">
            <ChartFrame title="Where guests opened their pass">
              <Table
                head={['Place', 'Opens', 'Families']}
                rows={s.passOpenPlaces.map((p) => [p.label, String(p.opens), String(p.households)])}
              />
            </ChartFrame>
            <ChartFrame title="What they opened it on">
              <Table
                head={['Device', 'Opens', 'Families']}
                rows={s.passOpenDevices.map((d) => [
                  d.bot ? `${d.label} (not a person)` : d.label,
                  String(d.opens),
                  String(d.households),
                ])}
              />
            </ChartFrame>
          </div>
          <ChartFrame title="Where the door scans happened">
            <Table
              head={['Place', 'Scans', 'Admissions']}
              rows={s.scanPlaces.map((p) => [p.label, String(p.scans), String(p.guests)])}
            />
          </ChartFrame>
        </section>

        {/* ------------------------------------------------- channel timing */}
        <section>
          <Head title="When each channel's guests arrived" blurb="Walk-ups bought and arrived in the same motion." />
          <ChartFrame title="First, middle and last guest by channel">
            <Table
              head={['Channel', 'Guests', 'First', 'Middle', 'Last']}
              rows={initial.insights.arrivalByChannel.map((r) => [
                r.label,
                String(r.guests),
                r.firstAt ?? '—',
                r.medianAt ?? '—',
                r.lastAt ?? '—',
              ])}
            />
          </ChartFrame>
        </section>

        {/* --------------------------------------------------- the volunteers */}
        <section>
          <Head title="Who did the work" blurb="Per volunteer, across the whole run." />
          <ChartFrame title="Volunteer activity">
            <Table
              head={['Name', 'Role', 'Scans', 'Admitted', 'Desk lookups', 'Corrections', 'Sign-ins', 'Last seen']}
              rows={s.staffActivity.map((a) => [
                a.name,
                a.role ?? '—',
                String(a.scans),
                String(a.guests),
                String(a.deskLookups),
                String(a.corrections),
                String(a.signIns),
                when(a.lastSeen),
              ])}
            />
          </ChartFrame>
          <ChartFrame title="Sign-ins" subtitle="Every volunteer session, with where it came from.">
            <Table
              head={['When', 'Who', 'Address', 'Place', 'Browser', '']}
              rows={s.sessions.map((x) => [
                when(x.at),
                x.name ?? '—',
                x.ip ?? '—',
                x.place ?? '—',
                x.userAgent ?? '—',
                x.revoked ? 'signed out' : '',
              ])}
            />
          </ChartFrame>
        </section>

        {/* ------------------------------------------------------ corrections */}
        <section>
          <Head title="Every correction" blurb="What was given back, and the reason somebody typed at the time." />
          <ChartFrame title={`${s.corrections.length} corrections`}>
            <Table
              head={['When', 'Family', 'Change', 'Reason', 'By']}
              rows={s.corrections.map((c) => [
                when(c.at),
                c.household,
                c.delta > 0 ? `+${c.delta}` : String(c.delta),
                c.reason,
                c.staff ?? 'system',
              ])}
            />
          </ChartFrame>

          {s.merges.length > 0 && (
            <ChartFrame title={`${s.merges.length} duplicate families merged`} subtitle="The same household paying through two channels.">
              <Table
                head={['When', 'Kept', 'Absorbed', 'Matched on', 'Admissions moved']}
                rows={s.merges.map((x) => [
                  when(x.at),
                  x.survivor,
                  x.absorbed,
                  x.basis,
                  `${x.ticketsMoved} (${x.redeemedMoved} already used)`,
                ])}
              />
            </ChartFrame>
          )}

          {s.locked.length > 0 && (
            <ChartFrame title="Households locked by hand" subtitle="The sheet sync leaves these alone.">
              <Table head={['Family', 'Reason', 'Locked']} rows={s.locked.map((l) => [l.name, l.reason ?? '—', when(l.at)])} />
            </ChartFrame>
          )}

          {s.contactCollisions.length > 0 && (
            <ChartFrame title="Shared contact details" subtitle="Where the duplicate detector had something to go on.">
              <Table
                head={['Kind', 'Value', 'Families']}
                rows={s.contactCollisions.map((c) => [c.kind, c.value, c.households.join(', ')])}
              />
            </ChartFrame>
          )}
        </section>

        {/* ---------------------------------------------------- review queue */}
        <section>
          <Head title="Everything flagged for a human" blurb="What the importers refused to guess about." />
          <ChartFrame title={`${s.reviews.length} review items`}>
            <Table
              head={['When', 'Kind', 'Status', 'Family', 'Summary']}
              rows={s.reviews.map((r) => [
                when(r.at),
                r.kind,
                r.status,
                r.household ?? '—',
                r.summary,
              ])}
            />
          </ChartFrame>
        </section>

        {/* ---------------------------------------------------------- email */}
        <section>
          <Head title="Every email" blurb="Including the ones that failed." />
          <ChartFrame title={`${s.emails.length} deliveries`}>
            <Table
              head={['When', 'Mailing', 'Status', 'To', 'Family', 'Seats at send', 'Error']}
              rows={s.emails.map((e) => [
                when(e.at),
                e.kind,
                e.status,
                e.toEmail,
                e.household ?? '—',
                e.ticketsAtSend === null ? '—' : String(e.ticketsAtSend),
                e.error ?? '',
              ])}
            />
          </ChartFrame>
        </section>

        {/* ------------------------------------------------------- machinery */}
        <section>
          <Head title="The machinery" blurb="Everything the app talked to, and how often." />
          <div className="mt-4 grid gap-4 lg:grid-cols-2 lg:items-start [&>*]:min-w-0">
            <ChartFrame title="Payment traffic">
              <Table
                head={['Provider', 'Event', 'Count', 'Amount', 'Errors', 'Last']}
                rows={s.paymentEvents.map((p) => [
                  p.provider,
                  p.eventType ?? '—',
                  String(p.count),
                  p.cents === null ? '—' : money(p.cents),
                  p.errors ? String(p.errors) : '',
                  when(p.lastAt),
                ])}
              />
            </ChartFrame>
            <ChartFrame title="Sync runs">
              <Table
                head={['Source', 'Status', 'Runs', 'Median', 'Failures', 'Last']}
                rows={s.syncs.map((x) => [
                  x.source,
                  x.status,
                  String(x.runs),
                  x.medianSeconds === null ? '—' : `${x.medianSeconds}s`,
                  x.failures ? String(x.failures) : '',
                  when(x.lastAt),
                ])}
              />
            </ChartFrame>
          </div>
        </section>

        {/* --------------------------------------------------- performances */}
        {s.performanceSignups.length > 0 && (
          <section>
            <Head title="Programme registrations" blurb="Collected at storefront checkout, replacing the Google Form." />
            <ChartFrame title={`${s.performanceSignups.length} sign-ups`}>
              <Table
                head={['Name', 'Individual or group', 'Type', 'Members', 'Media', 'Stage', 'Notes']}
                rows={s.performanceSignups.map((x) => [
                  x.name,
                  x.kind ?? '—',
                  x.type ?? '—',
                  x.members ?? '—',
                  x.wantsMedia ? 'yes' : '',
                  x.wantsStage ? 'yes' : '',
                  x.notes ?? '',
                ])}
              />
            </ChartFrame>
          </section>
        )}

        {/* ------------------------------------------------------- the ledger */}
        <section>
          <Head title="Every family" blurb="The whole ledger, exactly as the app holds it." />
          <ChartFrame title={`${s.households.length} families`}>
            <Table
              head={['Name', 'Email', 'Phone', 'Bought', 'Used', 'Left', 'U6', 'Status', 'How', 'Paid', 'Source', 'Pass opened', 'Added']}
              rows={s.households.map((x) => [
                x.name,
                x.email ?? '—',
                x.phone ?? '—',
                String(x.purchased),
                String(x.redeemed),
                String(x.remaining),
                x.childrenUnder6 ? String(x.childrenUnder6) : '',
                x.status,
                x.method ?? '—',
                money(x.cents),
                x.source ?? '—',
                x.passOpened ? 'yes' : 'no',
                when(x.createdAt),
              ])}
            />
          </ChartFrame>
        </section>

        {/* ------------------------------------------------------------ tips */}
        <section>
          <Head
            title="Tips for next year"
            blurb="Drawn from what the day actually recorded. Each one shows the number behind it, and each moves as the numbers do."
          />
          <div className="mt-4">
            <Tips tips={initial.tips} />
          </div>
        </section>

        {/* --------------------------------------------------------- the log */}
        <section>
          <Head
            title="Every recorded event"
            blurb="One row for everything the system ever did, with the address, place and device on each."
          />
          <div className="mt-4">
            <EventLog
              categories={initial.logCategories}
              total={initial.logTotal}
              firstPage={initial.logFirstPage}
              full
            />
          </div>
        </section>

        <p className="pb-8 text-center text-xs text-black/40">
          Organizers only · behind the volunteer password
        </p>
      </div>
    </div>
  )
}

/* ---------------------------------------------------------------- pieces */

function Head({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div>
      <h2 className="display text-2xl leading-8 text-[var(--green-deep)] sm:text-3xl">{title}</h2>
      <p className="mt-1 text-[15px] leading-relaxed text-black/60">{blurb}</p>
    </div>
  )
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--card)] p-3">
      <div className="display text-xl leading-6 tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs font-semibold leading-tight text-black/55">{label}</div>
      {hint && <div className="mt-0.5 text-[11px] leading-tight text-black/40">{hint}</div>}
    </div>
  )
}

/**
 * A dense table that scrolls inside its own box.
 *
 * The ledger is thirteen columns wide and this page is read on phones. Letting
 * the table scroll horizontally keeps the page itself from doing so, which is
 * the thing that makes a layout feel broken.
 */
function Table({ head, rows }: { head: string[]; rows: string[][] }) {
  if (!rows.length) {
    return <p className="text-sm text-black/50">Nothing recorded.</p>
  }
  return (
    <div className="-mx-1 overflow-x-auto">
      <table className="w-full min-w-full border-collapse text-left text-xs">
        <thead>
          <tr className="border-b-2 border-[var(--line-strong)]">
            {head.map((h, i) => (
              <th key={i} className="whitespace-nowrap px-2 py-1.5 font-bold text-black/60">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-[var(--line)] align-top">
              {row.map((cell, j) => (
                <td key={j} className="px-2 py-1.5 tabular-nums">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
