'use client'

import { useCallback, useMemo, useState } from 'react'

import { FinanceDetailDrawer } from '@/components/finance/finance-detail-drawer'
import { FinanceFilterBar } from '@/components/finance/finance-filter-bar'
import { FinanceGrid } from '@/components/finance/finance-grid'
import { FinanceSummaryStrip } from '@/components/finance/finance-summary-strip'
import {
  countReceiptStatuses,
  filterRows,
  type ReceiptFilter,
  type SessionFilter,
  type StatusFilter,
} from '@/lib/finance/grid/filters'
import { countPaymentStatuses } from '@/lib/finance/grid/payment-status'
import { selectedIds, type RowSelection } from '@/lib/finance/grid/selection'
import type { FinanceGridRow, FinanceGridView } from '@/lib/finance/grid/types'

/**
 * The finance tracker workspace.
 *
 * Owns the state that belongs to the browser rather than to the URL's intake:
 * the search term, the session, Payment Status and legacy receipt filters,
 * which rows are ticked, and which row the drawer shows. Rows arrive fully built from the
 * server — both cohorts of a combined intake at once — so narrowing to
 * Morning, to Outstanding, or to one student is instant and never re-queries
 * an intake that is already on screen.
 *
 * Read-only by construction. There is no mutation path from this component —
 * no server action is imported, and the receipt and reminder controls are
 * disabled rather than wired to a placeholder handler.
 */

export interface FinanceTrackerProps {
  view: FinanceGridView
  initialSearch: string
  initialStatus: StatusFilter
  initialSession: SessionFilter
  initialReceipt: ReceiptFilter
}

export function FinanceTracker({
  view,
  initialSearch,
  initialStatus,
  initialSession,
  initialReceipt,
}: FinanceTrackerProps) {
  const [search, setSearch] = useState(initialSearch)
  const [status, setStatus] = useState<StatusFilter>(initialStatus)
  const [session, setSession] = useState<SessionFilter>(initialSession)
  const [receipt, setReceipt] = useState<ReceiptFilter>(initialReceipt)
  const [rowSelection, setRowSelection] = useState<RowSelection>({})
  const [detailRow, setDetailRow] = useState<FinanceGridRow | null>(null)

  const rows = useMemo(
    () => filterRows(view.rows, { search, status, session, receipt }),
    [view.rows, search, status, session, receipt],
  )

  // What each pill would show if pressed: the rows every *other* filter
  // leaves, counted by the same field the row's own cell shows.
  const statusCounts = useMemo(
    () => countPaymentStatuses(filterRows(view.rows, { search, session, receipt })),
    [view.rows, search, session, receipt],
  )
  const receiptCounts = useMemo(
    () => countReceiptStatuses(filterRows(view.rows, { search, session, status })),
    [view.rows, search, session, status],
  )

  const showSession = useMemo(() => view.rows.some((row) => row.session !== null), [view.rows])

  const closeDrawer = useCallback(() => setDetailRow(null), [])
  const openDetails = useCallback((row: FinanceGridRow) => setDetailRow(row), [])

  const selectedCount = selectedIds(rowSelection).length

  return (
    <div className="space-y-3">
      <FinanceFilterBar
        view={view}
        search={search}
        onSearchChange={setSearch}
        status={status}
        onStatusChange={setStatus}
        session={session}
        onSessionChange={setSession}
        receipt={receipt}
        onReceiptChange={setReceipt}
        statusCounts={statusCounts}
        receiptCounts={receiptCounts}
        visibleRows={rows.length}
      />

      <FinanceSummaryStrip view={view} />

      {view.rows.length === 0 ? (
        <EmptyState
          title={
            view.selectedIntake === null && !view.unassigned
              ? 'No intake selected'
              : 'No students in this intake'
          }
          body={
            view.selectedIntake === null && !view.unassigned
              ? view.selectionNote
              : 'This intake has no imported finance records. Nothing was hidden by a filter — the underlying batches themselves are empty.'
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No matching students"
          body="No student in this intake matches the current session, status, receipt and search filters. The rows are still here — only the display is narrowed."
        />
      ) : (
        <FinanceGrid
          rows={rows}
          columns={view.columns}
          scheduledColumns={view.scheduledColumns}
          showSession={showSession}
          unassigned={view.unassigned}
          rowSelection={rowSelection}
          onRowSelectionChange={setRowSelection}
          onOpenDetails={openDetails}
        />
      )}

      {selectedCount > 0 ? (
        <SelectionBar count={selectedCount} onClear={() => setRowSelection({})} />
      ) : null}

      <FinanceDetailDrawer
        row={detailRow}
        intake={view.selectedIntake}
        scheduledColumns={view.scheduledColumns}
        onClose={closeDrawer}
      />
    </div>
  )
}

/**
 * The selection action bar.
 *
 * Groundwork only. The receipt and reminder buttons are disabled and say why —
 * this ticket builds no sending path at all, and a button that silently does
 * nothing would be worse than one that is honest about not being ready.
 */
function SelectionBar({ count, onClear }: { count: number; onClear: () => void }) {
  return (
    <div
      role="status"
      className="sticky bottom-4 z-40 mx-auto flex w-fit items-center gap-3 rounded-full border border-zinc-300 bg-white px-4 py-2 text-sm shadow-lg dark:border-zinc-700 dark:bg-zinc-900"
    >
      <span className="font-medium">{count} selected</span>

      <button
        type="button"
        disabled
        title="Available in a later workflow: receipt generation and sending."
        className="cursor-not-allowed rounded-md border border-dashed border-zinc-300 px-2.5 py-1 text-xs text-zinc-400 dark:border-zinc-700 dark:text-zinc-600"
      >
        Receipt
      </button>
      <button
        type="button"
        disabled
        title="Available in a later workflow: reminder sending."
        className="cursor-not-allowed rounded-md border border-dashed border-zinc-300 px-2.5 py-1 text-xs text-zinc-400 dark:border-zinc-700 dark:text-zinc-600"
      >
        Reminder
      </button>

      <button
        type="button"
        onClick={onClear}
        className="text-xs text-zinc-600 underline hover:text-zinc-900 dark:text-zinc-400 dark:hover:text-zinc-100"
      >
        Clear
      </button>
    </div>
  )
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div className="rounded-md border border-dashed border-zinc-300 bg-white px-6 py-12 text-center dark:border-zinc-700 dark:bg-zinc-950">
      <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">{title}</p>
      <p className="mx-auto mt-1 max-w-lg text-sm text-zinc-500">{body}</p>
    </div>
  )
}
