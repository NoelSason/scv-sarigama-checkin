import Link from 'next/link'
import { requireStaff } from '@/lib/auth'

export const dynamic = 'force-dynamic'

/**
 * The runbook, in the app.
 *
 * EVENT_DAY.md is the printed copy, but a volunteer mid-queue is holding a
 * phone, not a binder. Same instructions, written to be read standing up with
 * someone waiting: short lines, one idea each, the answer before the reasoning.
 */
export default async function HelpPage() {
  await requireStaff('scanner')

  return (
    <div className="space-y-6 pb-10">
      <div>
        <h1 className="text-2xl font-black">How to do this</h1>
        <p className="mt-1 text-black/60">
          Two jobs. Find yours below — you only need to read that part.
        </p>
      </div>

      {/* The rule that prevents the worst mistake, before anything else. */}
      <section className="rounded-2xl border-2 border-[var(--gold)] bg-[var(--cream)] p-5">
        <h2 className="text-lg font-black">The one rule</h2>
        <p className="mt-2 text-[15px] leading-relaxed">
          The QR code does <strong>not</strong> hold the ticket count — it just identifies the
          family. The real number lives on the server and is checked every time you scan.
        </p>
        <p className="mt-2 text-[15px] leading-relaxed">
          So a family can screenshot their code and share it with their kids, and it still
          can&apos;t be used more times than they paid for. It also means{' '}
          <strong>a screenshot showing &ldquo;3 remaining&rdquo; proves nothing.</strong> Only the
          green success screen on your own phone counts.
        </p>
      </section>

      {/* ---------------------------------------------------------- */}
      <section className="card">
        <h2 className="text-xl font-black">🔎 Registration desk</h2>
        <p className="mt-1 text-black/60">You hand people their pass.</p>

        <ol className="mt-4 space-y-3 text-[15px] leading-relaxed">
          <Step n={1}>
            <strong>Ask their name</strong> and type it in the big box. Part of a name is
            enough — <code className="rounded bg-black/5 px-1">kavith</code> finds{' '}
            <em>Kavitha Raveendra Raja</em>.
          </Step>
          <Step n={2}>
            <strong>Tap their name.</strong> Their QR appears straight away.
          </Step>
          <Step n={3}>
            <strong>Check the status</strong> above the QR. <Pill ok>PAID</Pill> or{' '}
            <Pill ok>COMPED</Pill> — carry on. <Pill>UNPAID</Pill> — take payment first.{' '}
            <Pill>NEEDS REVIEW</Pill> — get the admin, don&apos;t guess.
          </Step>
          <Step n={4}>
            <strong>Say the number out loud:</strong> &ldquo;I have you down for 4 — is that
            right?&rdquo;
          </Step>
          <Step n={5}>
            <strong>&ldquo;Point your phone camera at this.&rdquo;</strong> Their phone opens
            their pass.
          </Step>
          <Step n={6}>
            <strong>Tell them to screenshot it.</strong> That&apos;s what gets scanned at the
            Sadhya line, and one pass covers the whole family.
          </Step>
        </ol>

        <p className="mt-4 rounded-xl bg-[var(--ok-bg)] px-4 py-3 font-semibold text-[var(--ok)]">
          That&apos;s the whole job. They now carry their own pass and never need you again.
        </p>

        <h3 className="mt-5 font-black">If something&apos;s off</h3>
        <ul className="mt-2 space-y-2 text-[15px] leading-relaxed text-black/80">
          <li>
            <strong>Camera won&apos;t scan?</strong> Tap &ldquo;Camera not working? Show the link
            instead&rdquo; under the QR and let them type it.
          </li>
          <li>
            <strong>Not in the system?</strong> Try a shorter piece of the name, or their email
            or phone. Still nothing — get the admin before creating anything. A duplicate
            household is worse than a two-minute wait.
          </li>
          <li>
            <strong>Two rows, same name?</strong> Some families paid twice. Both are real — give
            them both QRs.
          </li>
          <li>
            <strong>Paying at the door by cash or Zelle?</strong> Use{' '}
            <strong>+ NEW WALK-IN</strong>. Take the money <em>first</em>, then tick payment
            confirmed. Children under 6 go in the &ldquo;under 6&rdquo; box, not admissions —
            they eat free.
          </li>
        </ul>

        <div className="mt-5 rounded-xl border-2 border-[var(--warn)] bg-[var(--warn-bg)] p-4">
          <p className="font-black text-[var(--warn)]">Paying at the door by card?</p>
          <p className="mt-2 text-[15px] leading-relaxed">
            Have them buy it on their own phone at{' '}
            <strong>onam.scvsarigama.com</strong>, exactly like everyone else did. They appear
            in search within a few seconds — <strong>do not also make a walk-in</strong>, or
            they&apos;ll end up with two passes and double the meals.
          </p>
          <p className="mt-2 text-[15px] leading-relaxed">
            If you ring a card up on the Square app instead, pick the actual{' '}
            <em>Onam Experience</em> item and set the quantity. A custom amount tells us money
            arrived but not how many people it covers, so it lands in the admin review queue
            rather than becoming a pass.
          </p>
        </div>

        <p className="mt-4 text-[15px] font-semibold">
          Checking someone in here uses up nothing. Admissions are only spent at the food line.
        </p>
      </section>

      {/* ---------------------------------------------------------- */}
      <section className="card">
        <h2 className="text-xl font-black">📷 Sadhya scanner</h2>
        <p className="mt-1 text-black/60">You count people into the food line.</p>

        <ol className="mt-4 space-y-3 text-[15px] leading-relaxed">
          <Step n={1}>Tap <strong>Scan</strong>, point at their QR.</Step>
          <Step n={2}>
            <strong>Read the family name out loud.</strong> Confirms you scanned the right code.
          </Step>
          <Step n={3}>
            Ask: <strong>&ldquo;How many are eating right now?&rdquo;</strong>
          </Step>
          <Step n={4}>Tap that number.</Step>
          <Step n={5}>
            <strong>Wait for the green screen.</strong> Then let them through.
          </Step>
        </ol>

        <h3 className="mt-5 font-black">What the screens mean</h3>
        <dl className="mt-2 space-y-3 text-[15px]">
          <Screen label="✓ green — 2 ADMITTED" tone="ok">
            Let those 2 through. Done.
          </Screen>
          <Screen label="✕ ONLY 1 REMAINING" tone="bad">
            Nothing was used. They asked for more than they have. Send them to registration.
          </Screen>
          <Screen label="✕ NO TICKETS REMAINING" tone="bad">
            All admissions used. Send them to registration — don&apos;t argue at the food line.
          </Screen>
          <Screen label="✕ NOT PAID" tone="bad">
            Send them to registration to pay.
          </Screen>
          <Screen label="⚠ Connection unavailable" tone="warn">
            <strong>Stop. Do not admit anyone.</strong> Wait for signal to come back.
          </Screen>
        </dl>

        <h3 className="mt-5 font-black">Tapped the wrong number?</h3>
        <p className="mt-2 text-[15px] leading-relaxed">
          On the green screen, tap <strong>&ldquo;Wrong number? Give tickets back&rdquo;</strong>{' '}
          and choose how many to return. If they come back later saying they were counted wrong,
          scan them again — the same give-back option is on that screen too, even when nothing is
          left.
        </p>

        <h3 className="mt-5 font-black">Things that will happen</h3>
        <ul className="mt-2 space-y-2 text-[15px] leading-relaxed text-black/80">
          <li>
            <strong>A family splits up.</strong> Grandparents at 1pm, kids at 3pm, same QR.
            Totally fine — just redeem whoever is in front of you.
          </li>
          <li>
            <strong>They show a screenshot from this morning.</strong> Scan it anyway. The server
            gives you the live number.
          </li>
          <li>
            <strong>Dead phone or cracked screen?</strong> Tap <strong>Search manually</strong>,
            find them by name.
          </li>
          <li>
            <strong>Camera won&apos;t open?</strong> Use <strong>Search manually</strong> and get
            someone to check camera permissions between guests.
          </li>
        </ul>

        <div className="mt-5 rounded-xl border-2 border-[var(--danger)] bg-[var(--danger-bg)] p-4">
          <p className="font-black text-[var(--danger)]">Never</p>
          <ul className="mt-2 space-y-1 text-[15px] font-semibold">
            <li>• Never admit anyone on a screenshot alone.</li>
            <li>• Never redeem while the red connection bar is showing.</li>
            <li>• Never redeem in advance for people who aren&apos;t standing there.</li>
          </ul>
        </div>
      </section>

      {/* ---------------------------------------------------------- */}
      <section className="card">
        <h2 className="text-xl font-black">😬 Something looks wrong</h2>
        <p className="mt-2 text-[15px] leading-relaxed">
          Get the admin. Almost everything is fixable in about fifteen seconds, and every change
          is recorded — so a mistake is never permanent and never a disaster. Tell them the
          family name and what happened.
        </p>
        <p className="mt-2 text-[15px] leading-relaxed">
          Don&apos;t improvise, and don&apos;t edit the spreadsheet. During the event this app is
          the source of truth.
        </p>
      </section>

      <p className="text-center">
        <Link href="/staff" className="btn-neutral w-full">
          Back to menu
        </Link>
      </p>
    </div>
  )
}

/* ------------------------------------------------------------------ */

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-[var(--green)] text-sm font-black text-white">
        {n}
      </span>
      <span>{children}</span>
    </li>
  )
}

function Pill({ children, ok }: { children: React.ReactNode; ok?: boolean }) {
  return (
    <span
      className={`mx-0.5 rounded px-1.5 py-0.5 text-sm font-bold ${
        ok ? 'bg-[var(--ok-bg)] text-[var(--ok)]' : 'bg-[var(--warn-bg)] text-[var(--warn)]'
      }`}
    >
      {children}
    </span>
  )
}

function Screen({
  label,
  tone,
  children,
}: {
  label: string
  tone: 'ok' | 'bad' | 'warn'
  children: React.ReactNode
}) {
  const style =
    tone === 'ok'
      ? 'border-[var(--ok)] bg-[var(--ok-bg)]'
      : tone === 'bad'
        ? 'border-[var(--danger)] bg-[var(--danger-bg)]'
        : 'border-[var(--warn)] bg-[var(--warn-bg)]'
  return (
    <div className={`rounded-xl border-2 p-3 ${style}`}>
      <dt className="font-black">{label}</dt>
      <dd className="mt-1">{children}</dd>
    </div>
  )
}
