'use client'

import type { OnamAnalytics } from '@/lib/analytics/types'
import { ChartFrame, DayBars, ShareBar } from './charts'

/*
 * How guests actually used the pass they were sent.
 *
 * This is the part of the day nobody could see before. The email embeds the QR
 * as an attachment encoding nothing but the pass URL — byte for byte the same
 * code the pass page shows — so a guest could scan straight out of their inbox
 * and never load the site at all. Because the site records an open and the
 * scanner records an admission, the two behaviours can finally be told apart.
 */

function minutesWords(mins: number | null): string {
  if (mins === null) return '—'
  if (mins < 60) return `${mins} min`
  const h = Math.round(mins / 60)
  if (h < 48) return `${h} hours`
  return `${Math.round(h / 24)} days`
}

export function PassBehaviour({ data }: { data: OnamAnalytics }) {
  const p = data.passBehaviour
  const inbox = p.segments.find((s) => s.key === 'inbox_only')
  const opened = p.segments.find((s) => s.key === 'opened_page')

  return (
    <div className="space-y-4">
      {/* The finding, said plainly, before any chart. */}
      {inbox && opened && (
        <p className="rounded-xl border border-[var(--line)] bg-[var(--cream)] p-4 text-[15px] leading-relaxed text-black/75">
          The QR in the email and the QR on the pass page are the same code, so people had a real
          choice about how to carry it — and most of them never opened the website at all.{' '}
          <strong>
            {inbox.households} families ({inbox.came} guests) scanned straight out of their inbox
          </strong>
          , against {opened.households} who opened the live pass. The email did the work; the site
          was the backup.
        </p>
      )}

      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        <ChartFrame
          title="How each family carried their pass"
          subtitle="Every family falls in exactly one of these."
        >
          <ShareBar
            rows={p.segments.map((s) => ({
              key: s.key,
              label: s.label,
              value: s.households,
              detail: `${s.sold} admissions bought, ${s.came} scanned in`,
            }))}
            unit="families"
          />
          <ul className="mt-3 space-y-1.5 text-xs leading-snug text-black/55">
            {p.segments.map((s) => (
              <li key={s.key}>
                <strong className="text-black/70">{s.label}:</strong> {s.detail}
              </li>
            ))}
          </ul>
        </ChartFrame>

        <div className="space-y-4">
          <ChartFrame
            title="How long before they looked"
            subtitle="From the pass email landing to the first time that family opened it."
            footer={
              <>
                Median {minutesWords(p.medianMinutesToOpen)}. The quickest opened it{' '}
                {minutesWords(p.fastestMinutesToOpen)} after it arrived.
              </>
            }
          >
            <DayBars
              rows={p.timeToOpen.map((r) => ({
                key: r.band,
                label: r.label,
                value: r.households,
                sub: r.households === 1 ? 'family' : 'families',
              }))}
            />
          </ChartFrame>

          <ChartFrame
            title="When they opened it"
            subtitle="Relative to the moment they were scanned in at the door."
          >
            <DayBars
              rows={p.openVsArrival.map((r) => ({
                key: r.band,
                label: r.label,
                value: r.opens,
                sub: r.opens === 1 ? 'open' : 'opens',
              }))}
            />
          </ChartFrame>
        </div>
      </div>

      <ChartFrame
        title="How many times each family opened it"
        subtitle="A pass gets re-opened, and shared around a family."
      >
        <DayBars
          rows={p.opensPerHousehold.map((r) => ({
            key: String(r.opens),
            label: `${r.opens}×`,
            value: r.households,
            sub: r.households === 1 ? 'family' : 'families',
          }))}
        />
      </ChartFrame>

      <p className="text-[15px] leading-relaxed text-black/70">
        {p.householdsWithoutEmail} of the {p.householdsWithoutEmail + p.householdsWithEmail} families
        left no email address at all — mostly the Zelle payers, who sent money and nothing else.
        They could never have been sent a pass, and were found by name at the desk instead. That is
        the case the whole name-lookup path exists for, and it carried real people.
      </p>
    </div>
  )
}
