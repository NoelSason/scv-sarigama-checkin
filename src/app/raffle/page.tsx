import { requireStaff } from '@/lib/auth'
import { loadRaffleState } from '@/lib/raffle'
import { RaffleStage } from './RaffleStage'
import './raffle.css'

export const dynamic = 'force-dynamic'

export const metadata = { title: 'Onam 2026 Raffle' }

/**
 * The end-of-day raffle stage.
 *
 * Deliberately outside /staff: this is projected on a wall, and the volunteer
 * header — Scan, Desk, Admin, Help — is noise on a screen the whole room is
 * looking at. It is still staff-only; requireStaff sends anyone else to login.
 */
export default async function RafflePage() {
  await requireStaff('admin')
  const initial = await loadRaffleState()

  return <RaffleStage initial={initial} />
}
