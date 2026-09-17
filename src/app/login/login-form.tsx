'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'

import { signIn, type SignInState } from './actions'

function SubmitButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className="w-full rounded-md bg-zinc-900 px-3 py-2 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-60 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
    >
      {pending ? 'Signing in…' : 'Sign in'}
    </button>
  )
}

export function LoginForm({ redirectTo }: { redirectTo?: string }) {
  const [state, formAction] = useActionState<SignInState, FormData>(signIn, {})

  return (
    <form action={formAction} className="space-y-4">
      <input type="hidden" name="redirectTo" value={redirectTo ?? ''} />

      <div className="space-y-1">
        <label htmlFor="email" className="block text-sm font-medium">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="username"
          required
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
        />
      </div>

      <div className="space-y-1">
        <label htmlFor="password" className="block text-sm font-medium">
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="w-full rounded-md border border-zinc-300 bg-white px-3 py-2 text-sm outline-none focus:border-zinc-500 dark:border-zinc-700 dark:bg-zinc-950"
        />
      </div>

      {state.error ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : null}

      <SubmitButton />
    </form>
  )
}
