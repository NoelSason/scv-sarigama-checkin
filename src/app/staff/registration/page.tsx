import { requireStaff } from '@/lib/auth'
import { RegistrationDesk } from './RegistrationDesk'

export const dynamic = 'force-dynamic'

export default async function RegistrationPage() {
  const staff = await requireStaff('registration')
  return <RegistrationDesk staffName={staff.name} />
}
