import { AppShell } from '@/components/ui/app-shell'

/**
 * Shown while a batch loads.
 *
 * Deliberately a skeleton of the real layout rather than a spinner: switching
 * batch is the most common action on this screen, and keeping the filter bar,
 * summary strip and grid in the same places stops the page jumping under the
 * pointer when the rows arrive.
 *
 * No user email is passed — the shell renders without the account row rather
 * than guessing at one before the session has been read.
 */
export default function Loading() {
  return (
    <AppShell wide>
      <div className="flex flex-wrap items-baseline gap-x-4">
        <h1 className="text-xl font-semibold tracking-tight">Finance Tracker</h1>
        <p className="text-sm text-zinc-500">Loading historical batch figures…</p>
      </div>

      <div className="mt-6 animate-pulse space-y-4" aria-hidden="true">
        <div className="flex gap-3">
          <div className="h-16 w-40 rounded-md bg-zinc-200 dark:bg-zinc-900" />
          <div className="h-16 w-72 rounded-md bg-zinc-200 dark:bg-zinc-900" />
          <div className="h-16 w-64 rounded-md bg-zinc-200 dark:bg-zinc-900" />
        </div>
        <div className="h-20 rounded-md bg-zinc-200 dark:bg-zinc-900" />
        <div className="h-96 rounded-md bg-zinc-200 dark:bg-zinc-900" />
      </div>

      <p className="sr-only" role="status">
        Loading the finance tracker.
      </p>
    </AppShell>
  )
}
