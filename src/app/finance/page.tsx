import type { Metadata } from 'next'

import { FinanceTracker } from '@/components/finance/finance-tracker'
import { AppShell } from '@/components/ui/app-shell'
import { requireUser } from '@/lib/auth'
import { isGridFilter, type GridFilter } from '@/lib/finance/grid/filters'
import { loadFinanceGrid } from '@/lib/finance/grid/load'
import { FinanceQueryError } from '@/lib/finance/query'

export const metadata: Metadata = {
  title: 'Finance Tracker · TAE Finance',
}

/**
 * Authenticated and per-request. Never statically cached: the page reads a
 * user's session and returns rows Row Level Security selected for them, so a
 * cached copy would be one staff member's view served to another.
 */
export const dynamic = 'force-dynamic'

/**
 * The Finance Tracker workspace.
 *
 * Reads historical finance data through the request-scoped Supabase client, so
 * RLS applies and the service-role key is never involved. `requireUser`
 * revalidates the session with the auth server before any query runs;
 * `src/proxy.ts` redirects unauthenticated requests to `/login`, but that is a
 * convenience and this is the real gate.
 *
 * Everything on this page is read-only. No server action is defined or
 * imported, so there is no write path from here at all.
 */
export default async function FinancePage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const user = await requireUser('/finance')
  const params = await searchParams

  const program = firstValue(params.program)
  const batch = firstValue(params.batch)
  const search = firstValue(params.q) ?? ''
  const filterParam = firstValue(params.filter)
  const filter: GridFilter = isGridFilter(filterParam) ? filterParam : 'all'

  let view
  try {
    view = await loadFinanceGrid({ program, batch })
  } catch (error) {
    // `raiseQueryError` has already logged the driver detail server-side. What
    // reaches the browser is a sentence, never a Postgres message: those name
    // columns, constraints and policies.
    if (!(error instanceof FinanceQueryError)) throw error

    return (
      <AppShell userEmail={user.email} wide>
        <Header />
        <div
          role="alert"
          className="mt-6 rounded-md border border-red-200 bg-red-50 px-6 py-8 text-center dark:border-red-900 dark:bg-red-950/40"
        >
          <p className="text-sm font-medium text-red-800 dark:text-red-300">
            The finance data could not be loaded.
          </p>
          <p className="mx-auto mt-1 max-w-lg text-sm text-red-700 dark:text-red-400">
            The problem has been recorded in the server log. Nothing was changed. Try again, and
            tell an administrator if it keeps happening.
          </p>
        </div>
      </AppShell>
    )
  }

  if (view.programs.length === 0) {
    return (
      <AppShell userEmail={user.email} wide>
        <Header />
        <div className="mt-6 rounded-md border border-dashed border-zinc-300 bg-white px-6 py-12 text-center dark:border-zinc-700 dark:bg-zinc-950">
          <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            No finance data is visible to this account.
          </p>
          <p className="mx-auto mt-1 max-w-lg text-sm text-zinc-500">
            Either no programs have been configured, or this account does not have finance access.
            An administrator can confirm which.
          </p>
        </div>
      </AppShell>
    )
  }

  return (
    <AppShell userEmail={user.email} wide>
      <Header note={view.batchSelectionNote} />

      <div className="mt-6">
        <FinanceTracker view={view} initialSearch={search} initialFilter={filter} />
      </div>
    </AppShell>
  )
}

function Header({ note }: { note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <h1 className="text-xl font-semibold tracking-tight">Finance Tracker</h1>
      <p className="text-sm text-zinc-500">
        Historical batch figures, shown as the source workbook recorded them. Read-only.
      </p>
      {note ? <p className="w-full text-xs text-zinc-400 dark:text-zinc-600">{note}</p> : null}
    </div>
  )
}

/** A search param may legitimately repeat; the first value is the one used. */
function firstValue(value: string | string[] | undefined): string | null {
  if (value === undefined) return null
  return Array.isArray(value) ? (value[0] ?? null) : value
}
