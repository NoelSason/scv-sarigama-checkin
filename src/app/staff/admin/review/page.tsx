import Link from 'next/link'
import { requireStaff } from '@/lib/auth'
import { query } from '@/lib/db'
import { ReviewQueue, type ReviewItem } from './ReviewQueue'

export const dynamic = 'force-dynamic'

/**
 * Everything the importers refused to guess about ends up here.
 *
 * That is the point: a queued item a human resolves in ten seconds is far
 * cheaper than a household that silently got the wrong ticket balance.
 */
export default async function ReviewPage() {
  await requireStaff('admin')

  const items = await query<ReviewItem>(
    `select r.id, r.kind, r.summary, r.payload, r.status, r.created_at,
            r.household_id, h.display_name, h.tickets_purchased,
            h.tickets_redeemed, h.tickets_remaining, h.payment_status
       from review_items r
       left join households h on h.id = r.household_id
      where r.status = 'open'
      order by r.created_at`,
  )

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-black">Review queue</h1>
        <Link href="/staff/admin" className="ml-auto btn-neutral px-4 py-2 text-sm">
          Back to admin
        </Link>
      </div>

      {items.length === 0 ? (
        <div className="card text-center">
          <p className="text-xl font-bold">Nothing to review</p>
          <p className="mt-1 text-black/60">
            Every imported record mapped cleanly. This page fills up when a Square order,
            spreadsheet row, or refund needs a human decision.
          </p>
        </div>
      ) : (
        <ReviewQueue items={items} />
      )}
    </div>
  )
}
