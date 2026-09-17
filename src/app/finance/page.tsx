import type { Metadata } from 'next'

import { AppShell } from '@/components/ui/app-shell'
import { TrackerFilters, TrackerGridPlaceholder } from '@/components/finance/tracker-placeholder'
import { requireUser } from '@/lib/auth'

export const metadata: Metadata = {
  title: 'Finance Tracker · TAE Finance',
}

/** Authenticated: rendered per request, never statically cached. */
export const dynamic = 'force-dynamic'

export default async function FinancePage() {
  const user = await requireUser('/finance')

  return (
    <AppShell userEmail={user.email}>
      <h1 className="text-xl font-semibold tracking-tight">Finance Tracker</h1>
      <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
        Batch-level payment and installment tracking. Controls below are placeholders — no
        finance data is connected in this ticket.
      </p>

      <div className="mt-6">
        <TrackerFilters />
        <p id="tracker-filters-note" className="mt-2 text-xs text-zinc-500">
          Filters are disabled until the finance schema and workbook import land.
        </p>
        <TrackerGridPlaceholder />
      </div>
    </AppShell>
  )
}
