import { requireStaff } from '@/lib/auth'
import { Scanner } from './Scanner'

export const dynamic = 'force-dynamic'

export default async function ScanPage() {
  const staff = await requireStaff('scanner')
  return <Scanner staffName={staff.name} />
}
