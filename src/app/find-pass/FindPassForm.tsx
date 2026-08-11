'use client'

import { useState } from 'react'

type State =
  | { kind: 'idle' }
  | { kind: 'sending' }
  | { kind: 'done'; message: string }
  | { kind: 'error'; message: string }

export function FindPassForm() {
  const [contact, setContact] = useState('')
  const [state, setState] = useState<State>({ kind: 'idle' })

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault()
    if (state.kind === 'sending') return
    setState({ kind: 'sending' })

    try {
      const res = await fetch('/api/find-pass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact }),
      })
      const data = (await res.json()) as { ok?: boolean; error?: string; message?: string }

      if (data.ok && data.message) {
        setState({ kind: 'done', message: data.message })
        return
      }
      if (data.error === 'RATE_LIMITED') {
        setState({
          kind: 'error',
          message: data.message ?? 'Too many tries. Please wait a few minutes.',
        })
        return
      }
      setState({
        kind: 'error',
        message: 'Please enter an email address or a phone number.',
      })
    } catch {
      setState({
        kind: 'error',
        message: "We couldn't reach the internet just now. Please try again.",
      })
    }
  }

  // The confirmation replaces the form: re-submitting the same address does
  // nothing useful and only burns the rate limit.
  if (state.kind === 'done') {
    return (
      <div className="mt-6 rounded-2xl border-2 border-[var(--ok)] bg-[var(--ok-bg)] p-6 text-center">
        <p className="text-lg font-bold text-[var(--ok)]">Check your inbox</p>
        <p className="mt-3 text-[15px] leading-relaxed">{state.message}</p>
        <p className="mt-3 text-[15px] leading-relaxed text-black/60">
          It may take a minute to arrive. Have a look in your spam folder too.
        </p>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="mt-6">
      <label htmlFor="contact" className="block text-[15px] font-semibold">
        Email address or phone number
      </label>
      <input
        id="contact"
        name="contact"
        type="text"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        required
        placeholder="you@example.com"
        value={contact}
        onChange={(e) => {
          setContact(e.target.value)
          if (state.kind === 'error') setState({ kind: 'idle' })
        }}
        className="field mt-2"
      />

      <p className="mt-2 text-sm text-black/55">
        Use the one you gave when you paid.
      </p>

      {state.kind === 'error' && (
        <p
          role="alert"
          className="mt-4 rounded-xl bg-[var(--danger-bg)] px-4 py-3 text-[15px] font-semibold text-[var(--danger)]"
        >
          {state.message}
        </p>
      )}

      <button type="submit" className="btn-primary mt-5 w-full" disabled={state.kind === 'sending'}>
        {state.kind === 'sending' ? 'Sending…' : 'Send me my pass'}
      </button>
    </form>
  )
}
