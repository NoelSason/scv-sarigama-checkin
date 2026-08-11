import type { Metadata } from 'next'
import { FindPassForm } from './FindPassForm'

export const metadata: Metadata = {
  title: 'Find my pass — SCV Sarigama Onam 2026',
  description: 'Have your Onam Sadhya pass sent to you again.',
}

export default function FindPassPage() {
  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col px-5 py-8">
      <header className="text-center">
        <p className="text-sm font-bold uppercase tracking-[0.2em] text-[var(--gold-deep)]">
          SCV Sarigama
        </p>
        <h1 className="mt-1 text-3xl font-black text-[var(--green-deep)]">Onam 2026</h1>
      </header>

      <h2 className="mt-6 text-center text-2xl font-bold">Find my pass</h2>
      <p className="mt-3 text-center text-[15px] leading-relaxed text-black/70">
        Lost the link to your Sadhya pass? Tell us how to reach you and we&apos;ll send it
        again.
      </p>

      <div className="mt-6 rounded-2xl border border-black/10 bg-white p-5 shadow-sm">
        <FindPassForm />
      </div>

      {/* Most households paid by Zelle and we have no way to reach them. Saying
          so plainly here is what stops a queue forming at the desk of people who
          assumed the email was late. */}
      <div className="mt-6 rounded-2xl bg-[var(--cream)] p-5 text-[15px] leading-relaxed">
        <p className="font-semibold text-[var(--gold-deep)]">Paid by Zelle?</p>
        <p className="mt-2 text-black/75">
          We most likely don&apos;t have your email, so there&apos;s nothing for us to send.
          Nothing to worry about — just come to the registration desk when you arrive. Give
          your name, and a volunteer will hand you your pass right there.
        </p>
      </div>

      <p className="mt-6 text-center text-[15px] leading-relaxed text-black/60">
        Anything at all looks wrong? The registration desk can fix it in a moment.
      </p>

      <footer className="mt-auto pt-10 text-center text-xs text-black/40">
        SCV Sarigama Onam 2026
      </footer>
    </main>
  )
}
