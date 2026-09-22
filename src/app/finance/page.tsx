import type { Metadata } from 'next'
import { redirect } from 'next/navigation'

import { FinanceTracker } from '@/components/finance/finance-tracker'
import { AppShell } from '@/components/ui/app-shell'
import { requireUser } from '@/lib/auth'
import {
  isReceiptFilter,
  isSessionFilter,
  isStatusFilter,
  receiptFilterFromLegacy,
  sessionFilterOf,
  statusFilterFromLegacy,
  type ReceiptFilter,
  type SessionFilter,
  type StatusFilter,
} from '@/lib/finance/grid/filters'
import { UNASSIGNED_INTAKE } from '@/lib/finance/grid/intake'
import { loadFinanceGrid } from '@/lib/finance/grid/load'
import type { FinanceGridView } from '@/lib/finance/grid/types'
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
 * URL state (FINANCE-GRID-03C):
 *
 *   ?program=PSW&intake=2026-07-29&session=morning&status=outstanding&receipt=sent&q=…
 *
 * `program` and `intake` decide which rows are loaded; `session`, `status`,
 * `receipt` (the historical workbook receipt status) and `q` narrow them in
 * the browser. The GRID-03 forms are still honoured:
 * `?batch=<uuid>` is mapped to the intake holding that batch, narrowed to its
 * session, and the address bar is moved to the new form; `?filter=` is read
 * as the equivalent `status`, or — for `legacy_receipt_gap`, which meant
 * "Not sent or Mixed" — as the receipt filter's compatibility value `gap`.
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
  const intake = firstValue(params.intake)
  const batch = firstValue(params.batch)
  const search = firstValue(params.q) ?? ''

  const statusParam = firstValue(params.status)
  const status: StatusFilter = isStatusFilter(statusParam)
    ? statusParam
    : (statusFilterFromLegacy(firstValue(params.filter)) ?? 'all')

  const sessionParam = firstValue(params.session)
  let session: SessionFilter = isSessionFilter(sessionParam) ? sessionParam : 'all'

  const receiptParam = firstValue(params.receipt)
  const receipt: ReceiptFilter = isReceiptFilter(receiptParam)
    ? receiptParam
    : (receiptFilterFromLegacy(firstValue(params.filter)) ?? 'all')

  let view: FinanceGridView
  try {
    view = await loadFinanceGrid({ program, intake, batch })
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

  // An old `?batch=<uuid>` link: move the address bar to the intake form, with
  // the session that narrows the grid to exactly the rows the old link showed.
  // Outside the try block, because `redirect` works by throwing.
  if (view.legacyBatchRedirect !== null && view.selectedProgram !== null) {
    const canonical = new URLSearchParams()
    canonical.set('program', view.selectedProgram.shortCode)
    canonical.set('intake', view.legacyBatchRedirect.intakeKey)
    const mappedSession = sessionFilterOf(view.legacyBatchRedirect.session)
    if (mappedSession !== 'all') canonical.set('session', mappedSession)
    if (status !== 'all') canonical.set('status', status)
    if (receipt !== 'all') canonical.set('receipt', receipt)
    if (search !== '') canonical.set('q', search)
    redirect(`/finance?${canonical.toString()}`)
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

  // A session filter only means something where the intake has two cohorts.
  if (view.unassigned || (view.selectedIntake?.availableSessions.length ?? 0) < 2) {
    session = 'all'
  }

  // Keyed on the selection, so search, filters, ticked rows and the open
  // drawer reset when staff move to a different intake rather than carrying
  // a selection of record ids that are no longer on screen.
  const trackerKey = `${view.selectedProgram?.shortCode ?? ''}:${
    view.unassigned ? UNASSIGNED_INTAKE : (view.selectedIntake?.key ?? '')
  }`

  return (
    <AppShell userEmail={user.email} wide>
      <Header note={view.selectionNote} />

      <div className="mt-5">
        <FinanceTracker
          key={trackerKey}
          view={view}
          initialSearch={search}
          initialStatus={status}
          initialSession={session}
          initialReceipt={receipt}
        />
      </div>
    </AppShell>
  )
}

function Header({ note }: { note?: string }) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
      <h1 className="text-xl font-semibold tracking-tight">Finance Tracker</h1>
      <p className="text-sm text-zinc-500">
        Historical intake figures, shown as the source workbook recorded them. Read-only.
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
