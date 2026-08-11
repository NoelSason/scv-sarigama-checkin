import { requireStaff } from '@/lib/auth'
import { query } from '@/lib/db'

export const dynamic = 'force-dynamic'

type Row = {
  display_name: string
  email: string | null
  phone: string | null
  payment_method: string | null
  payment_status: string
  tickets_purchased: number
  tickets_redeemed: number
  tickets_remaining: number
  children_under_6: number
  is_test: boolean
}

/**
 * Printable contingency roster.
 *
 * This exists for one scenario: the venue network dies completely and the app
 * is unreachable. Someone then works off paper and reconciles afterwards. It is
 * deliberately dense and unstyled for print — this is not a screen page.
 *
 * Print it BEFORE the event. A roster you can only reach when the network is up
 * is no use during the outage it was meant to cover.
 */
export default async function RosterPage() {
  await requireStaff('admin')

  const rows = await query<Row>(
    `select display_name, email, phone, payment_method, payment_status,
            tickets_purchased, tickets_redeemed, tickets_remaining,
            children_under_6, is_test
       from households
      where payment_status in ('paid', 'comped')
      order by lower(display_name)`,
  )

  const totalTickets = rows.reduce((n, r) => n + r.tickets_purchased, 0)
  const totalRemaining = rows.reduce((n, r) => n + r.tickets_remaining, 0)
  const printedAt = new Date().toLocaleString('en-US', {
    dateStyle: 'medium',
    timeStyle: 'short',
  })

  return (
    <div className="roster">
      <style>{`
        @media print {
          /* The staff nav and any surrounding chrome are noise on paper. */
          header, nav, .no-print { display: none !important; }
          .roster { font-size: 10pt; }
          thead { display: table-header-group; }
          tr { break-inside: avoid; }
          @page { margin: 12mm; size: portrait; }
        }
        .roster table { width: 100%; border-collapse: collapse; }
        .roster th, .roster td {
          border-bottom: 1px solid #ccc; padding: 4px 6px;
          text-align: left; vertical-align: top;
        }
        .roster th { border-bottom: 2px solid #333; font-size: 0.85em; text-transform: uppercase; }
        .roster td.num { text-align: right; font-variant-numeric: tabular-nums; }
      `}</style>

      <div className="mb-3">
        <h1 className="text-xl font-black">SCV Sarigama Onam 2026 — Sadhya roster</h1>
        <p className="text-sm">
          Printed {printedAt} · {rows.length} households · {totalTickets} admissions sold ·{' '}
          {totalRemaining} unused at print time
        </p>
        <p className="mt-2 border-2 border-black p-2 text-sm font-bold">
          SNAPSHOT ONLY. These numbers were correct when printed and go out of date the
          moment anyone is scanned. Use this only if the app is unreachable, mark it by hand,
          and reconcile afterwards. The app is always authoritative.
        </p>
        <button
          type="button"
          className="no-print btn-neutral mt-3 print:hidden"
          // A plain form-less button: this page has no server interaction at all.
          formAction=""
        >
          Use your browser&apos;s Print command (⌘P)
        </button>
      </div>

      <table>
        <thead>
          <tr>
            <th>Family</th>
            <th>Contact</th>
            <th>Pay</th>
            <th className="num">Bought</th>
            <th className="num">Used</th>
            <th className="num">Left</th>
            <th>Hand tally</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              <td>
                {r.is_test && <strong>[TEST] </strong>}
                {r.display_name}
                {r.children_under_6 > 0 && (
                  <span> (+{r.children_under_6} under 6, free)</span>
                )}
              </td>
              <td>{[r.email, r.phone].filter(Boolean).join(' · ') || '—'}</td>
              <td>{r.payment_method ?? '—'}</td>
              <td className="num">{r.tickets_purchased}</td>
              <td className="num">{r.tickets_redeemed}</td>
              <td className="num">
                <strong>{r.tickets_remaining}</strong>
              </td>
              {/* Deliberately empty: this is where a volunteer writes during an outage. */}
              <td style={{ minWidth: '90px' }}>&nbsp;</td>
            </tr>
          ))}
        </tbody>
      </table>

      {rows.length === 0 && (
        <p className="mt-4">No paid households yet — nothing to print.</p>
      )}
    </div>
  )
}
