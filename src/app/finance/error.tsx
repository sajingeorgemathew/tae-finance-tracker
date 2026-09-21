'use client'

import { useEffect } from 'react'

/**
 * Last-resort boundary for the finance route.
 *
 * Expected database failures are handled in the page itself, which shows a
 * sanitised message and keeps the shell intact. This catches what that cannot:
 * a render-time fault. It shows nothing about the cause, because an error
 * reaching here is unclassified and its message may quote a query, a column or
 * a policy — none of which belongs in front of a staff member.
 *
 * The digest is Next.js's own server-side correlation id, not error text, so it
 * is safe to display and is what an administrator needs to find the log entry.
 */
export default function FinanceError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    // Console only, on whichever side rendered. Nothing is sent anywhere.
    console.error('[finance] Unhandled error rendering /finance:', error.digest ?? error.message)
  }, [error])

  return (
    <div className="mx-auto max-w-lg px-6 py-16 text-center" role="alert">
      <h1 className="text-lg font-semibold">The finance tracker could not be displayed.</h1>
      <p className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">
        Nothing was changed. No finance record was modified by this page — it only reads.
      </p>

      {error.digest ? (
        <p className="mt-2 text-xs text-zinc-400">
          Reference for an administrator: <span className="font-mono">{error.digest}</span>
        </p>
      ) : null}

      <button
        type="button"
        onClick={reset}
        className="mt-6 rounded-md border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
      >
        Try again
      </button>
    </div>
  )
}
