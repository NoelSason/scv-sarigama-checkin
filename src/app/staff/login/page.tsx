import { redirect } from 'next/navigation'
import { currentStaff, signInShared } from '@/lib/auth'

export const dynamic = 'force-dynamic'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const { error } = await searchParams
  if (await currentStaff()) redirect('/staff')

  async function action(formData: FormData) {
    'use server'
    const password = String(formData.get('password') ?? '')
    const result = await signInShared(password)
    if (!result.ok) redirect(`/staff/login?error=${encodeURIComponent(result.error)}`)
    redirect('/staff')
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-sm flex-col justify-center px-6 py-10">
      <header className="text-center">
        <p className="text-sm font-bold uppercase tracking-[0.2em] text-[var(--gold-deep)]">
          SCV Sarigama
        </p>
        <h1 className="mt-1 text-3xl font-black text-[var(--green-deep)]">Onam Check-In</h1>
        <p className="mt-2 text-black/60">Enter the volunteer password</p>
      </header>

      <form action={action} className="mt-8 space-y-4">
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
    </main>
  )
}
