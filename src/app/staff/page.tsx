import Link from 'next/link'
import { requireStaff } from '@/lib/auth'
import { KasavuBand } from '@/components/onam'

export const dynamic = 'force-dynamic'

export default async function StaffHome() {
  const staff = await requireStaff('scanner')

  return (
    <div className="space-y-5">
      <div>
        <h1 className="display text-[26px] leading-[34px]">Hi {staff.name.split(' ')[0]}</h1>
        <p className="text-black/60">
          Signed in as <strong>{staff.role}</strong>
        </p>
      </div>

      <div className="grid gap-4">
        <Link href="/staff/scan" className="btn-primary w-full py-8 text-xl">
          📷 Scan Sadhya passes
        </Link>

        {(staff.role === 'registration' || staff.role === 'admin') && (
          <Link href="/staff/registration" className="btn-gold w-full py-8 text-xl">
            🔎 Registration desk
          </Link>
        )}

        {staff.role === 'admin' && (
          <>
            <Link href="/staff/admin" className="btn-neutral w-full py-6 text-lg">
              ⚙ Admin dashboard
            </Link>
            <Link href="/raffle" className="btn-neutral w-full py-6 text-lg">
              🎟 Raffle
            </Link>
          </>
        )}
      </div>

      <Link href="/staff/help" className="btn-neutral w-full py-6 text-lg">
        📖 How to do this
      </Link>

      <div className="card-banded">
        <KasavuBand height={5} />
        <div className="p-5 text-sm leading-relaxed text-black/70">
          <p className="font-extrabold text-[var(--foreground)]">Quick reminder</p>
          <p className="mt-1">
            Scanning shows the family&apos;s live balance. Ask how many people are entering
            <em> right now</em>, tap that number, and wait for the green screen before letting
            them through. Never admit someone from a screenshot alone.
          </p>
          <p className="mt-2">
            Full instructions for the desk and the scanner are in{' '}
            <Link href="/staff/help" className="font-bold text-[var(--green)] underline">
              How to do this
            </Link>
            .
          </p>
        </div>
      </div>
    </div>
  )
}
