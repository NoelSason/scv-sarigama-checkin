import { redirect } from 'next/navigation'
import { currentStaff } from '@/lib/auth'
import { KasavuRule, Lamp } from '@/components/onam'
import { signInAction } from '../actions'

export const dynamic = 'force-dynamic'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  if (await currentStaff()) redirect('/staff')

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-10">
      <header className="text-center">
        <Lamp glow className="mx-auto" />
        <p className="mt-2 text-xs font-black uppercase tracking-[0.28em] text-[var(--gold-deep)]">
          SCV Sarigama
        </p>
        <h1 className="display mt-0.5 text-[2rem] leading-[1.15] text-[var(--green-deep)]">
          Onam Check-In
        </h1>
        <p className="mt-2 text-black/60">Enter the volunteer password</p>
      </header>

      <form action={signInAction} className="mt-8 space-y-4">
        <div>
          <label htmlFor="password" className="mb-1 block font-semibold">
            Password
          </label>
          <input
            id="password"
            name="password"
            type="password"
            autoComplete="current-password"
            autoFocus
            required
            className="field text-xl"
          />
        </div>

        {error && (
          <p
            role="alert"
            className="rounded-xl bg-[var(--danger-bg)] px-4 py-3 font-semibold text-[var(--danger)]"
          >
            {error}
          </p>
        )}

        <button type="submit" className="btn-primary w-full py-6 text-xl">
          Sign in
        </button>
      </form>

      <p className="mt-8 text-center text-sm text-black/50">
        You&apos;ll stay signed in on this phone. Ask the event admin for the password.
      </p>

      <KasavuRule className="mt-9" />
    </main>
  )
}
