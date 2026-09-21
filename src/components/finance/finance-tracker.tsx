'use client'

import type { RowSelectionState } from '@tanstack/react-table'
import { useCallback, useMemo, useState } from 'react'

import { FinanceDetailDrawer } from '@/components/finance/finance-detail-drawer'
import { FinanceFilterBar } from '@/components/finance/finance-filter-bar'
import { FinanceGrid } from '@/components/finance/finance-grid'
import { FinanceSummaryStrip } from '@/components/finance/finance-summary-strip'
import { filterRows, type GridFilter } from '@/lib/finance/grid/filters'
import type { FinanceGridRow, FinanceGridView } from '@/lib/finance/grid/types'

/**
 * The finance tracker workspace.
 *
 * Owns the three pieces of state that belong to the browser rather than the
 * URL's batch: the search term, the active quick filter, and which rows are
 * ticked. Rows arrive fully built from the server, so searching and filtering
 * are instant and never re-query a batch that is already on screen.
 *
 * Read-only by construction. There is no mutation path from this component —
 * no server action is imported, and the receipt and reminder controls are
 * disabled rather than wired to a placeholder handler.
 */

export interface FinanceTrackerProps {
  view: FinanceGridView
  initialSearch: string
  initialFilter: GridFilter
}

export function FinanceTracker({ view, initialSearch, initialFilter }: FinanceTrackerProps) {
  const [search, setSearch] = useState(initialSearch)
  const [filter, setFilter] = useState<GridFilter>(initialFilter)
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({})
  const [detailRow, setDetailRow] = useState<FinanceGridRow | null>(null)

  const rows = useMemo(() => filterRows(view.rows, { search, filter }), [view.rows, search, filter])

  const closeDrawer = useCallback(() => setDetailRow(null), [])
  const openDetails = useCallback((row: FinanceGridRow) => setDetailRow(row), [])

  const selectedCount = Object.values(rowSelection).filter(Boolean).length

  return (
    <div className="space-y-4">
      <FinanceFilterBar
        view={view}
        search={search}
        onSearchChange={setSearch}
        filter={filter}
        onFilterChange={setFilter}
        visibleRows={rows.length}
      />

      <FinanceSummaryStrip view={view} />

      {view.rows.length === 0 ? (
        <EmptyState
          title={
            view.selectedBatch === null && !view.unassigned
              ? 'No batch selected'
              : 'No students in this batch'
          }
          body={
            view.selectedBatch === null && !view.unassigned
              ? view.batchSelectionNote
              : 'This batch has no imported finance records. Nothing was hidden by a filter — the batch itself is empty.'
          }
        />
      ) : rows.length === 0 ? (
        <EmptyState
          title="No matching students"
          body="No student in this batch matches the current search and filter. The rows are still here — only the display is narrowed."
        />
      ) : (
        <FinanceGrid
          rows={rows}
          columns={view.columns}
          scheduledColumns={view.scheduledColumns}
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
      <span className="font-medium">
        {count} selected
      </span>

      <button
        type="button"
        disabled
        title="Receipt sending will be enabled in the receipt workflow."
        className="cursor-not-allowed rounded-md border border-dashed border-zinc-300 px-2.5 py-1 text-xs text-zinc-400 dark:border-zinc-700 dark:text-zinc-600"
      >
        Receipt
      </button>
      <button
        type="button"
        disabled
        title="Reminder sending will be enabled in the reminder workflow."
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
