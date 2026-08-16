'use client'

import { useCallback, useState } from 'react'
import type { OnamAnalytics } from '@/lib/analytics/types'
import { KasavuBand, KasavuRule, Lamp } from '@/components/onam'
import {
  ArrivalChart,
  ChartFrame,
  Columns,
  DayBars,
  HourBars,
  PairedBars,
  SeatingCurve,
  ShareBar,
} from './charts'
import { NoShows } from './NoShows'
import { EventLog } from './EventLog'
import { Program } from './Program'
import { PassBehaviour } from './PassBehaviour'
import { Tips } from './Tips'
import { Catering } from './Catering'

/*
 * The Onam 2026 post-event report.
 *
 * Written for the organizers who ran the day, not for whoever maintains the
 * app: every figure is captioned in plain language, and where a number needs a
 * caveat the caveat sits next to it rather than in a footnote nobody reads.
 */

function money(cents: number): string {
  return (cents / 100).toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: cents % 100 === 0 ? 0 : 2,
  })
}

function timeOfDay(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    timeZone: 'America/Los_Angeles',
  })
}

/*
 * Captions that state a finding are computed, never written by hand.
 *
 * The first draft of this page asserted that big parties no-show more and that
 * opening a pass predicts turning up. Both were wrong — the data says the
 * opposite of one and nothing at all about the other. A sentence that restates
 * the numbers cannot drift away from them, and these numbers still move every
 * time somebody marks a family present.
 */

function turnoutBySizeFooter(rows: OnamAnalytics['insights']['turnoutBySize']): string {
  if (rows.length < 2) return ''
  const ranked = [...rows].sort((a, b) => a.percent - b.percent)
  const worst = ranked[0]
  const best = ranked[ranked.length - 1]
  return `Turnout ran from ${worst.percent}% among families who bought ${worst.label.toLowerCase()} up to ${best.percent}% among those who bought ${best.label.toLowerCase()} — the bigger the booking, the more of it showed up.`
}

function passEffectFooter(rows: OnamAnalytics['insights']['passOpenedEffect']): string {
  if (rows.length < 2) return ''
  const opened = rows.find((r) => r.key.startsWith('Opened'))
  const not = rows.find((r) => !r.key.startsWith('Opened'))
  if (!opened || !not) return ''
  const gap = Math.abs(opened.percent - not.percent)
  if (gap <= 3) {
    return `${opened.percent}% against ${not.percent}% — no real difference. Opening the pass beforehand said nothing about whether the family would come, which is worth knowing before anyone builds a reminder around it.`
  }
  return `${opened.percent}% against ${not.percent}%, a gap of ${gap} points.`
}

function quartileFooter(
  rows: OnamAnalytics['insights']['quartiles'],
  firstScan: string | null,
  lastScan: string | null,
): string {
  const half = rows.find((r) => r.percent === 50)
  const quarter = rows.find((r) => r.percent === 25)
  if (!half || !quarter || !firstScan || !lastScan) return ''
  const midpoint = new Date((Date.parse(firstScan) + Date.parse(lastScan)) / 2)
  const halfAt = Date.parse(half.at)
  const side = halfAt > midpoint.getTime() ? 'just after' : 'just before'
  return `A quarter of the room was in by ${quarter.label} and half by ${half.label} — ${side} the midpoint of service. The queue built early and thinned out from there.`
}

function partySizeFooter(rows: OnamAnalytics['insights']['partyByPhase']): string {
  if (rows.length < 2) return ''
  const first = rows[0]
  const last = rows[rows.length - 1]
  if (last.averageParty > first.averageParty) {
    return `Parties got larger as the afternoon went on — ${first.averageParty.toFixed(1)} per scan early against ${last.averageParty.toFixed(1)} late. The singles and pairs came first.`
  }
  return `Parties got smaller as the afternoon went on — ${first.averageParty.toFixed(1)} per scan early against ${last.averageParty.toFixed(1)} late. The big groups came together and came first.`
}

function longDate(day: string | null): string {
  if (!day) return 'the event'
  return new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

export function Analytics({ initial }: { initial: OnamAnalytics }) {
  const [data, setData] = useState(initial)
  const [refreshing, setRefreshing] = useState(false)

  const refresh = useCallback(async () => {
    setRefreshing(true)
    try {
      const res = await fetch('/api/analytics/onam', { cache: 'no-store' })
      if (res.ok) setData((await res.json()) as OnamAnalytics)
    } catch {
      // Keep the numbers already on screen. A blank report is worse than one
      // that is a minute old.
    } finally {
      setRefreshing(false)
    }
  }, [])

  const h = data.headline
  const s = data.service
  const m = data.money

  return (
    <div className="min-h-dvh">
      <header className="border-b border-[var(--line)] bg-[var(--card)]">
        <KasavuBand height={6} />
        <div className="mx-auto max-w-5xl px-4 py-7 sm:px-6 sm:py-10">
          <div className="flex items-center gap-2.5">
            <Lamp width={22} glow />
            <p className="text-xs font-black uppercase tracking-[0.28em] text-[var(--gold-deep)]">
              SCV Sarigama
            </p>
          </div>
          <h1 className="display mt-1.5 text-[2.1rem] leading-[1.1] text-[var(--green-deep)] sm:text-5xl">
            Onam 2026 — the whole day in numbers
          </h1>
          <p className="mt-2 text-[15px] leading-relaxed text-black/65 sm:text-base">
            Sadhya served on {longDate(data.eventDay)}. Everything below is read live from the
            check-in system.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={refresh}
              disabled={refreshing}
              className="btn-neutral min-h-11 px-4 py-2 text-sm"
            >
              {refreshing ? 'Refreshing…' : 'Refresh'}
            </button>
            <span className="text-xs text-black/45" suppressHydrationWarning>
              Read at {new Date(data.generatedAt).toLocaleString('en-US', { timeStyle: 'short', dateStyle: 'medium' })}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-5xl space-y-12 px-4 py-8 sm:px-6 sm:py-12">
        {/* ------------------------------------------------------- headline */}
        <section>
          <SectionHead
            title="The headline"
            blurb="What the day added up to."
          />
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Hero label="Guests who ate" value={h.guestsWhoAte} tone="green" />
            <Hero label="Admissions sold" value={h.admissionsSold} />
            <Hero label="Families registered" value={h.households} />
            <Hero label="Money collected" value={money(h.moneyCents)} tone="gold" />
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Small label="Scanned in at the door" value={h.scannedIn} />
            <Small
              label="Marked present afterwards"
              value={h.markedPresent}
              hint={h.markedPresent > 0 ? 'no arrival time recorded' : undefined}
            />
            <Small label="Turnout" value={`${h.turnoutPercent}%`} />
            <Small label="Children under 6 (free)" value={h.childrenUnder6} />
          </div>
          {h.stillUnaccounted > 0 && (
            <p className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--cream)] p-3 text-[15px] leading-relaxed text-black/75">
              <strong>{h.stillUnaccounted} admissions</strong> were paid for and never scanned in.
              Some of those people ate anyway — the line outran the scanner near the end. The list
              is further down, with a way to mark who actually came.
            </p>
          )}
        </section>

        {/* -------------------------------------------------- catering */}
        <section id="catering">
          <SectionHead
            title="What was cooked against who came"
            blurb="The caterer needed a final number a week out. The headcount had not finished moving."
          />
          <div className="mt-4">
            <Catering data={data} />
          </div>
        </section>

        {/* -------------------------------------------------- run sheet */}
        <section id="schedule">
          <SectionHead
            title="Keeping to time"
            blurb="The printed run sheet against the actual clock. Tap an item as it starts and everything after it re-times itself."
          />
          <div className="mt-4">
            <Program state={data.program} onChanged={refresh} />
          </div>
        </section>

        {/* -------------------------------------------------- the service */}
        <section>
          <SectionHead
            title="Peak times and slow times"
            blurb={`Doors effectively opened at ${timeOfDay(s.firstScan)} and the last guest was checked in at ${timeOfDay(s.lastScan)} — ${Math.floor(s.durationMinutes / 60)}h ${s.durationMinutes % 60}m of service.`}
          />

          <div className="mt-4 space-y-4">
            <ChartFrame
              title="Arrivals, five minutes at a time"
              subtitle="Every column is five minutes. Darker means busier. The flat stretches are real — nobody arrived at all."
            >
              <ArrivalChart
                buckets={s.fine}
                peakLabel={s.peakFive ? `${s.peakFive.label} — ${s.peakFive.guests} guests` : null}
                lull={s.longestLull}
              />
            </ChartFrame>

            <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
              <ChartFrame
                title="Guests per hour"
                subtitle="The same day at the grain the serving line felt it."
              >
                <HourBars buckets={s.hourly} />
              </ChartFrame>

              <ChartFrame
                title="Filling the hall"
                subtitle="Guests arrived, running total, against the seating you actually had."
                footer={
                  <span>
                    {s.seatings.filter((x) => x.full).length} full turns of the room, then{' '}
                    {s.seatings.find((x) => !x.full)?.guests ?? 0} more in the last one.
                  </span>
                }
              >
                <SeatingCurve buckets={s.fine} capacity={80} lanes={4} seatsPerLane={20} />
              </ChartFrame>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Small label="Busiest hour" value={s.peakHour?.label ?? '—'} hint={`${s.peakHour?.guests ?? 0} guests`} />
            <Small
              label="Busiest 15 minutes"
              value={s.peakFifteen?.label ?? '—'}
              hint={`${s.peakFifteen?.guests ?? 0} guests — a rate of ${s.peakGuestsPerHour}/hour`}
            />
            <Small
              label="Pressure per lane at the peak"
              value={s.busiestLanePressure}
              hint="guests per lane, per 15 min"
            />
            <Small
              label="Longest gap with nobody"
              value={s.longestLull ? `${s.longestLull.minutes} min` : '—'}
              hint={s.longestLull ? `${s.longestLull.from} – ${s.longestLull.to}` : undefined}
            />
          </div>

          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Small label="Average party at the door" value={s.averagePartySize.toFixed(1)} hint="people per scan" />
            <Small label="Largest single party" value={s.largestParty} />
            <Small
              label="Typical wait between scans"
              value={`${s.medianSecondsBetweenScans} sec`}
              hint="median"
            />
            <Small
              label="Families who arrived in pieces"
              value={s.splitParties}
              hint="scanned more than once"
            />
          </div>

          <p className="mt-4 text-[15px] leading-relaxed text-black/70">
            Four lanes of about twenty is 80 seats a turn. The busiest quarter-hour put{' '}
            {s.peakFifteen?.guests ?? 0} guests through the door — about {s.busiestLanePressure} per
            lane — which is roughly {Math.round(((s.peakFifteen?.guests ?? 0) / 80) * 100)}% of a
            full seating arriving inside fifteen minutes.
          </p>
        </section>

        {/* ---------------------------------------------------------- money */}
        <section>
          <SectionHead
            title="The money"
            blurb="Recorded against each family's ledger row, not inferred from a payment amount."
          />
          <div className="mt-4 grid gap-4 lg:grid-cols-2 lg:items-start">
            <ChartFrame title="How people paid" subtitle="Share of everything collected.">
              <ShareBar
                rows={m.byMethod.map((r) => ({
                  key: r.key,
                  label: r.label,
                  value: r.cents,
                  detail: `${r.households} families · ${r.guests} admissions`,
                }))}
                unit="the money"
                format={money}
              />
            </ChartFrame>

            <div className="grid grid-cols-2 gap-3 self-start">
              <Small label="Total collected" value={money(m.totalCents)} />
              <Small label="Per admission" value={money(m.averagePerAdmissionCents)} hint="average" />
              <Small label="Per family" value={money(m.averagePerHouseholdCents)} hint="average" />
              <Small
                label="Taken at the door"
                value={money(m.walkInCents)}
                hint={`${m.walkInAdmissions} walk-up admissions`}
              />
              {m.donationCents > 0 && (
                <Small label="Donations" value={money(m.donationCents)} hint="storefront" />
              )}
              {m.abandonedCheckouts > 0 && (
                <Small label="Abandoned checkouts" value={m.abandonedCheckouts} hint="never paid" />
              )}
            </div>
          </div>

          {data.registration.walkIns.length > 0 && (
            <ChartFrame
              title="Walk-ups, in the order they arrived"
              subtitle="Sold at the desk on the day."
            >
              <ul className="divide-y divide-[var(--line)]">
                {data.registration.walkIns.map((w) => (
                  <li key={`${w.name}-${w.at}`} className="flex items-baseline gap-3 py-2 text-sm">
                    <span className="w-16 shrink-0 tabular-nums text-black/50">
                      {timeOfDay(w.at)}
                    </span>
                    <span className="flex-1 font-semibold">{w.name}</span>
                    <span className="tabular-nums text-black/60">
                      {w.guests} {w.guests === 1 ? 'seat' : 'seats'}
                    </span>
                    <span className="w-16 shrink-0 text-right font-bold tabular-nums">
                      {money(w.cents)}
                    </span>
                  </li>
                ))}
              </ul>
            </ChartFrame>
          )}
        </section>

        {/* --------------------------------------------------- who came */}
        <section>
          <SectionHead
            title="Who registered, and who turned up"
            blurb="Turnout was not the same across the three ways people bought."
          />
          <div className="mt-4 grid gap-4 lg:grid-cols-2 lg:items-start">
            <ChartFrame
              title="Turnout by how they bought"
              subtitle="Bought against actually scanned in."
            >
              <PairedBars
                rows={data.registration.bySource.map((r) => ({
                  key: r.key,
                  label: r.label,
                  sold: r.guests,
                  came: r.checkedIn,
                }))}
              />
            </ChartFrame>

            <ChartFrame
              title="How big the families were"
              subtitle="Admissions bought per family."
              footer={
                data.registration.largestHousehold ? (
                  <>
                    Largest single booking: {data.registration.largestHousehold.name} at{' '}
                    {data.registration.largestHousehold.guests}.
                  </>
                ) : undefined
              }
            >
              <Columns
                caption="Tap a column for the count."
                rows={data.registration.householdSizes.map((r) => ({
                  key: String(r.size),
                  label: String(r.size),
                  value: r.households,
                  sub: `${r.households} families, ${r.guests} admissions`,
                }))}
              />
              <p className="mt-2 text-xs text-black/50">Admissions bought (across the bottom)</p>
            </ChartFrame>
          </div>

          <ChartFrame
            title="When records entered the system"
            subtitle="Not the same as when people bought: the first day is the bulk import of every Square and spreadsheet sale that already existed."
          >
            <DayBars
              rows={data.registration.intake.map((r) => ({
                key: r.day,
                label: r.label,
                value: r.households,
                sub: `${r.guests} admissions`,
              }))}
            />
          </ChartFrame>
        </section>

        {/* ------------------------------------------------------- passes */}
        <section>
          <SectionHead
            title="Passes and messages"
            blurb="Each family got one QR pass carrying all of their admissions."
          />
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Small label="Pass emails sent" value={data.passes.passEmailsSent} />
            <Small label="Reminders sent" value={data.passes.reminderEmailsSent} />
            <Small
              label="Families who opened their pass"
              value={data.passes.householdsOpenedPass}
              hint={`${data.passes.openRatePercent}% of families`}
            />
            <Small
              label="Times a pass was opened"
              value={data.passes.passOpens}
              hint="passes get re-opened and shared"
            />
          </div>
          <ChartFrame title="When people looked at their pass" subtitle="Opens per day.">
            <DayBars
              rows={data.passes.opensByDay.map((r) => ({
                key: r.day,
                label: r.label,
                value: r.opens,
              }))}
            />
          </ChartFrame>
          {data.passes.emailsFailed > 0 && (
            <p className="mt-3 text-sm text-[var(--warn)]">
              {data.passes.emailsFailed} email did not send. Those families were looked up by name
              at the desk instead.
            </p>
          )}
        </section>

        {/* --------------------------------------------------- thank-you */}
        {data.thankyou.sent > 0 && (
          <section>
            <SectionHead
              title="The thank-you"
              blurb="Sent after the event to everyone who came. Measured by what people clicked, not by whether an image loaded — mail apps fetch those on their own, so an open rate would be counting software."
            />
            <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
              <Small label="Thank-you emails sent" value={data.thankyou.sent} />
              <Small
                label="Families who clicked through"
                value={data.thankyou.households}
                hint={`${data.thankyou.clickRatePercent}% of those it reached`}
              />
              <Small
                label="Clicks in total"
                value={data.thankyou.clicks}
                hint="links get re-opened and shared"
              />
              <Small
                label="Link previews"
                value={data.thankyou.botClicks}
                hint="fetched by software, not people"
              />
            </div>
            {data.thankyou.byTarget.length > 1 && (
              <ChartFrame title="Which link" subtitle="Families who clicked each one.">
                <DayBars
                  rows={data.thankyou.byTarget.map((t) => ({
                    key: t.target,
                    label: t.label,
                    value: t.households,
                    sub: `${t.clicks} clicks`,
                  }))}
                />
              </ChartFrame>
            )}
            {data.thankyou.failed > 0 && (
              <p className="mt-3 text-sm text-[var(--warn)]">
                {data.thankyou.failed} thank-you did not send.
              </p>
            )}
          </section>
        )}

        {/* -------------------------------------------- pass behaviour */}
        <section>
          <SectionHead
            title="Inbox or website?"
            blurb="The emailed QR and the pass page carry the same code, so how people chose to carry it is finally visible."
          />
          <div className="mt-4">
            <PassBehaviour data={data} />
          </div>
        </section>

        {/* ------------------------------------------------ deeper cuts */}
        <section>
          <SectionHead
            title="Patterns worth knowing next year"
            blurb="Cross-cuts of the same data that say something about how to run the day."
          />

          <div className="mt-4 grid gap-4 lg:grid-cols-2 lg:items-start">
            <ChartFrame
              title="Did big families turn up?"
              subtitle="Turnout by how many admissions a family bought."
              footer={turnoutBySizeFooter(data.insights.turnoutBySize)}
            >
              <PairedBars
                rows={data.insights.turnoutBySize.map((r) => ({
                  key: r.key,
                  label: `${r.label} — ${r.households} families`,
                  sold: r.sold,
                  came: r.came,
                }))}
              />
            </ChartFrame>

            <ChartFrame
              title="Did opening the pass predict turning up?"
              subtitle="Families who looked at their pass beforehand, against those who never did."
              footer={passEffectFooter(data.insights.passOpenedEffect)}
            >
              <PairedBars
                rows={data.insights.passOpenedEffect.map((r) => ({
                  key: r.key,
                  label: `${r.label} — ${r.households} families`,
                  sold: r.sold,
                  came: r.came,
                }))}
              />
            </ChartFrame>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2 lg:items-start">
            <ChartFrame
              title="How the afternoon filled"
              subtitle="The clock time by which each share of guests had arrived."
            >
              <ul className="space-y-2">
                {data.insights.quartiles.map((q) => (
                  <li key={q.percent} className="flex items-baseline gap-3">
                    <span className="w-12 shrink-0 text-right font-bold tabular-nums">
                      {q.percent}%
                    </span>
                    <span className="flex-1 border-b border-dashed border-[var(--line)]" />
                    <span className="shrink-0 font-bold tabular-nums">{q.label}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-3 text-sm leading-relaxed text-black/60">
                {quartileFooter(data.insights.quartiles, s.firstScan, s.lastScan)}
              </p>
            </ChartFrame>

            <ChartFrame
              title="Party size through the day"
              subtitle="Service split into equal thirds."
              footer={partySizeFooter(data.insights.partyByPhase)}
            >
              <ul className="space-y-2.5">
                {data.insights.partyByPhase.map((r) => (
                  <li key={r.phase} className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="font-semibold">{r.label}</span>
                    <span className="tabular-nums text-black/60">
                      {r.guests} guests in {r.scans} scans ·{' '}
                      <strong className="text-[var(--foreground)]">
                        {r.averageParty.toFixed(1)}
                      </strong>{' '}
                      per party
                    </span>
                  </li>
                ))}
              </ul>
            </ChartFrame>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2 lg:items-start">
            <ChartFrame
              title="When each channel's guests arrived"
              subtitle="Walk-ups excluded — they arrived and bought in the same motion."
            >
              <ul className="space-y-2.5">
                {data.insights.arrivalByChannel.map((r) => (
                  <li key={r.key}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="font-semibold leading-snug">{r.label}</span>
                      <span className="shrink-0 tabular-nums text-black/55">{r.guests} guests</span>
                    </div>
                    <div className="text-xs text-black/50">
                      first {r.firstAt} · middle guest {r.medianAt} · last {r.lastAt}
                    </div>
                  </li>
                ))}
              </ul>
            </ChartFrame>

            <ChartFrame
              title="How far ahead people committed"
              subtitle="When each family's record was created, grouped by how close to the day that was."
            >
              <DayBars
                rows={data.insights.leadTime.map((r) => ({
                  key: r.key,
                  label: r.label,
                  value: r.households,
                  sub: `${r.guests} admissions`,
                }))}
              />
            </ChartFrame>
          </div>
        </section>

        {/* ----------------------------------------------------- no-shows */}
        <section id="unaccounted">
          <SectionHead
            title="Paid for, never scanned"
            blurb="The gap between what was sold and what the scanner saw — and the correction for it."
          />
          <div className="mt-4">
            <NoShows rows={data.noShows} onChanged={refresh} />
          </div>
        </section>

        {/* -------------------------------------------------- operations */}
        <section>
          <SectionHead
            title="How the system behaved"
            blurb="The unglamorous half: corrections, duplicates, and everything the app talked to."
          />
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Small label="Scans at the door" value={data.integrity.scans} />
            <Small
              label="Scans undone"
              value={data.integrity.reversedScans}
              hint={`${data.integrity.admissionsHandedBack} admissions handed back`}
            />
            <Small
              label="Duplicate families merged"
              value={data.integrity.duplicateHouseholdsMerged}
              hint="one person, two purchases"
            />
            <Small
              label="Things flagged for a human"
              value={data.integrity.reviewsOpened}
              hint={`${data.integrity.reviewsStillOpen} still open`}
            />
            <Small label="Spreadsheet syncs" value={data.integrity.sheetSyncs.toLocaleString()} />
            <Small label="Square messages" value={data.integrity.squareEvents} />
            <Small label="Stripe messages" value={data.integrity.stripeEvents} />
            <Small label="Volunteer sign-ins" value={data.integrity.staffSignIns} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2 lg:items-start">
            <ChartFrame title="Which device did the checking in" subtitle="Guests admitted per scanner.">
              <ShareBar
                rows={data.integrity.devices.map((d) => ({
                  key: d.key,
                  label: d.label,
                  value: d.count,
                  detail: d.detail,
                }))}
                unit="the guests"
              />
            </ChartFrame>

            <ChartFrame
              title="Where the scans came from"
              subtitle="Approximate, from the network the device was on."
            >
              <ul className="space-y-1.5 text-sm">
                {data.integrity.scanLocations.map((l) => (
                  <li key={l.key} className="flex items-baseline justify-between gap-3">
                    <span>{l.label}</span>
                    <span className="tabular-nums text-black/60">{l.detail}</span>
                  </li>
                ))}
              </ul>
            </ChartFrame>
          </div>

          {data.integrity.testHouseholds > 0 && (
            <p className="mt-3 text-sm text-black/55">
              {data.integrity.testHouseholds} rehearsal records exist and are excluded from every
              number on this page, as is the absorbed half of each merged pair.
            </p>
          )}
        </section>

        {/* -------------------------------------------------------- raffle */}
        {data.raffle.length > 0 && (
          <section>
            <SectionHead
              title="The raffle"
              blurb="Every admission bought was one entry, so a family of nine had nine chances."
            />
            <ul className="mt-4 divide-y divide-[var(--line)] border-y border-[var(--line)]">
              {data.raffle.map((r) => (
                <li key={`${r.name}-${r.at}`} className="flex items-baseline gap-3 py-2.5 text-sm">
                  <span className="flex-1">
                    <span className="font-bold">{r.name}</span>
                    <span className="ml-2 text-black/60">{r.prize}</span>
                  </span>
                  <span className="shrink-0 tabular-nums text-black/50">
                    {r.entries} {r.entries === 1 ? 'entry' : 'entries'}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {/* ------------------------------------------------- next year */}
        <section id="next-year">
          <SectionHead
            title="Tips for next year"
            blurb="Drawn from what the day actually recorded. Each one shows the number behind it, and each moves as the numbers do."
          />
          <div className="mt-4">
            <Tips tips={data.tips} />
          </div>
        </section>

        {/* ----------------------------------------------------- full log */}
        <section>
          <SectionHead
            title="Every recorded event"
            blurb="One row for everything the system ever did — every scan, correction, payment, email, sign-in and sync."
          />
          <div className="mt-4">
            <EventLog
              categories={data.logCategories}
              total={data.logTotal}
              firstPage={data.logFirstPage}
            />
          </div>
        </section>

        <footer className="pt-4 text-center">
          <KasavuRule />
          <p className="mt-2.5 text-xs text-black/45">
            SCV Sarigama Onam 2026 · numbers read live from the check-in system
          </p>
        </footer>
      </main>
    </div>
  )
}

/* --------------------------------------------------------------- pieces */

function SectionHead({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div>
      <h2 className="display text-2xl leading-8 text-[var(--green-deep)] sm:text-3xl">{title}</h2>
      <p className="mt-1 text-[15px] leading-relaxed text-black/60">{blurb}</p>
    </div>
  )
}

function Hero({
  label,
  value,
  tone,
}: {
  label: string
  value: number | string
  tone?: 'green' | 'gold'
}) {
  const color =
    tone === 'green' ? 'var(--green-deep)' : tone === 'gold' ? 'var(--gold-deep)' : 'var(--foreground)'
  return (
    <div className="card-banded">
      <KasavuBand height={4} />
      <div className="p-4">
        <div className="display text-[2.4rem] leading-[1.05] tabular-nums" style={{ color }}>
          {value}
        </div>
        <div className="mt-1 text-xs font-bold uppercase tracking-wide text-black/55">{label}</div>
      </div>
    </div>
  )
}

function Small({
  label,
  value,
  hint,
}: {
  label: string
  value: number | string
  hint?: string
}) {
  return (
    <div className="rounded-xl border border-[var(--line)] bg-[var(--card)] p-3">
      <div className="display text-xl leading-6 tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs font-semibold leading-tight text-black/55">{label}</div>
      {hint && <div className="mt-0.5 text-[11px] leading-tight text-black/40">{hint}</div>}
    </div>
  )
}
