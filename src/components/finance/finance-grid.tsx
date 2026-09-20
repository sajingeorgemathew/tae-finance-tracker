'use client'

import {
  createColumnHelper,
  rowSelectionFeature,
  tableFeatures,
  useTable,
  type ColumnDef,
  type RowSelectionState,
} from '@tanstack/react-table'
import { useMemo } from 'react'

import { LegacyBadge, Money, ReceiptBadge, ReminderCell } from '@/components/finance/finance-cells'
import type { LegacyColumn } from '@/lib/finance/grid/legacy-cells'
import { BLANK_MONEY } from '@/lib/finance/grid/money'
import { NO_STUDENT_NUMBER } from '@/lib/finance/grid/student-name'
import type { FinanceGridRow, ScheduledColumn } from '@/lib/finance/grid/types'
import { cn } from '@/lib/utils'

/**
 * The Excel-style finance grid.
 *
 * A real `<table>`, not a grid of divs: screen readers announce row and column
 * relationships from the markup, and the whole point of this screen is that it
 * behaves like the spreadsheet senior staff already know.
 *
 * ## Why TanStack Table
 *
 * Two things earn it here. Grouped headers — building the ACTUAL / INSTALLMENT
 * / STATUS banner row and its placeholder cells by hand is fiddly and easy to
 * get subtly wrong when the column set changes per batch. And row selection,
 * which has to track select-one, select-all and the indeterminate state in
 * between. Everything else (sorting, filtering, pagination) is deliberately not
 * registered: this is a read-only historical view, ordered the way the workbook
 * orders it, and unregistered features cannot accidentally reorder history.
 *
 * ## Why not virtualised
 *
 * `@tanstack/react-virtual` is installed and is not used. The largest batch
 * holds around thirty students. Virtualising that would buy nothing and would
 * put the sticky header and the sticky first columns at risk, which are what
 * make the grid readable. When a view appears that genuinely needs it — a
 * cross-batch report — it can be added there.
 */

/**
 * Only row selection. Registered once at module scope: TanStack rebuilds its
 * models when `features` changes identity, so this must not be created inside
 * the component.
 */
const features = tableFeatures({ rowSelectionFeature })

const helper = createColumnHelper<typeof features, FinanceGridRow>()

/** Column widths, in pixels, for the three frozen columns. */
const SELECT_WIDTH = 40
// Wide enough that "No student number" sits on one line: an unresolved
// student must not be the row that breaks the grid's rhythm.
const NUMBER_WIDTH = 132
const NAME_WIDTH = 224

export interface FinanceGridProps {
  rows: FinanceGridRow[]
  columns: LegacyColumn[]
  scheduledColumns: ScheduledColumn[]
  rowSelection: RowSelectionState
  onRowSelectionChange: (updater: React.SetStateAction<RowSelectionState>) => void
  onOpenDetails: (row: FinanceGridRow) => void
}

export function FinanceGrid({
  rows,
  columns,
  scheduledColumns,
  rowSelection,
  onRowSelectionChange,
  onOpenDetails,
}: FinanceGridProps) {
  const columnDefs = useMemo(
    () => buildColumns(columns, scheduledColumns, onOpenDetails),
    [columns, scheduledColumns, onOpenDetails],
  )

  const table = useTable({
    features,
    data: rows,
    columns: columnDefs,
    // Keyed by finance record so a selection survives a re-render and cannot
    // silently move to a different student when the row order changes.
    getRowId: (row) => row.financeRecordId,
    state: { rowSelection },
    onRowSelectionChange,
  })

  return (
    <div className="relative overflow-auto rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <table className="w-max min-w-full border-collapse text-[13px]">
        <caption className="sr-only">
          Historical finance figures for the selected batch, as recorded in the source workbook.
        </caption>

        <thead className="sticky top-0 z-30">
          {table.getHeaderGroups().map((group, groupIndex) => (
            <tr key={group.id}>
              {group.headers.map((header) => {
                const frozen = frozenOffset(header.column.id)
                const isBanner = groupIndex === 0

                return (
                  <th
                    key={header.id}
                    colSpan={header.colSpan}
                    scope={header.colSpan > 1 ? 'colgroup' : 'col'}
                    style={frozen === null ? undefined : { left: frozen, width: widthOf(header.column.id) }}
                    className={cn(
                      'border-b border-zinc-200 px-2 py-1.5 text-left font-medium whitespace-nowrap dark:border-zinc-800',
                      isBanner
                        ? 'bg-zinc-100 text-[11px] tracking-wide text-zinc-600 uppercase dark:bg-zinc-900 dark:text-zinc-400'
                        : 'bg-zinc-50 text-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-300',
                      isBanner && 'border-l border-zinc-200 dark:border-zinc-800',
                      isMoneyColumn(header.column.id) && !isBanner && 'text-right',
                      frozen !== null && 'sticky z-10',
                    )}
                  >
                    {header.isPlaceholder ? null : <table.FlexRender header={header} />}
                  </th>
                )
              })}
            </tr>
          ))}
        </thead>

        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr
              key={row.id}
              className="group border-b border-zinc-100 last:border-b-0 hover:bg-sky-50/70 dark:border-zinc-900 dark:hover:bg-sky-950/30"
            >
              {row.getAllCells().map((cell) => {
                const frozen = frozenOffset(cell.column.id)
                return (
                  <td
                    key={cell.id}
                    style={frozen === null ? undefined : { left: frozen, width: widthOf(cell.column.id) }}
                    className={cn(
                      'border-r border-zinc-100 px-2 py-1 align-middle last:border-r-0 dark:border-zinc-900',
                      frozen !== null &&
                        'sticky z-10 bg-white group-hover:bg-sky-50/70 dark:bg-zinc-950 dark:group-hover:bg-sky-950/30',
                    )}
                  >
                    <table.FlexRender cell={cell} />
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

// -----------------------------------------------------------------------------
// Column definitions
// -----------------------------------------------------------------------------

/**
 * The frozen columns and where each one starts.
 *
 * `identity` is the banner cell spanning the three of them. It is frozen too,
 * otherwise the group heading slides out from over its own columns as soon as
 * the grid is scrolled sideways — which is the first thing anyone does here.
 */
const FROZEN: Record<string, number> = {
  identity: 0,
  select: 0,
  studentNumber: SELECT_WIDTH,
  studentName: SELECT_WIDTH + NUMBER_WIDTH,
}

function frozenOffset(columnId: string): number | null {
  return columnId in FROZEN ? FROZEN[columnId] : null
}

function widthOf(columnId: string): number | undefined {
  if (columnId === 'identity') return SELECT_WIDTH + NUMBER_WIDTH + NAME_WIDTH
  if (columnId === 'select') return SELECT_WIDTH
  if (columnId === 'studentNumber') return NUMBER_WIDTH
  if (columnId === 'studentName') return NAME_WIDTH
  return undefined
}

function isMoneyColumn(columnId: string): boolean {
  return columnId.startsWith('actual:') || columnId.startsWith('sched:')
}

function buildColumns(
  historical: readonly LegacyColumn[],
  scheduled: readonly ScheduledColumn[],
  onOpenDetails: (row: FinanceGridRow) => void,
): ColumnDef<typeof features, FinanceGridRow, unknown>[] {
  const identity = helper.group({
    id: 'identity',
    header: 'Identity',
    columns: helper.columns([
      helper.display({
        id: 'select',
        header: ({ table }) => (
          <input
            type="checkbox"
            aria-label="Select all visible students"
            checked={table.getIsAllRowsSelected()}
            ref={(element) => {
              if (element) element.indeterminate = table.getIsSomeRowsSelected()
            }}
            onChange={table.getToggleAllRowsSelectedHandler()}
            className="size-3.5 cursor-pointer align-middle accent-zinc-900 dark:accent-zinc-100"
          />
        ),
        cell: ({ row }) => (
          <input
            type="checkbox"
            aria-label={`Select ${row.original.studentName}`}
            checked={row.getIsSelected()}
            onChange={row.getToggleSelectedHandler()}
            className="size-3.5 cursor-pointer align-middle accent-zinc-900 dark:accent-zinc-100"
          />
        ),
      }),
      helper.accessor('studentNumber', {
        id: 'studentNumber',
        header: 'Student #',
        cell: ({ getValue }) => {
          const value = getValue()
          // The seven unresolved students carry no number. They are told apart
          // by an honest statement of absence, never by an invented id.
          return value === null ? (
            <span className="text-[11px] whitespace-nowrap text-zinc-400 italic dark:text-zinc-600">
              {NO_STUDENT_NUMBER}
            </span>
          ) : (
            <span className="tabular-nums">{value}</span>
          )
        },
      }),
      helper.accessor('studentName', {
        id: 'studentName',
        header: 'Student name',
        cell: ({ row, getValue }) => (
          <span className="flex items-center">
            <button
              type="button"
              onClick={() => onOpenDetails(row.original)}
              className="truncate text-left hover:underline focus-visible:underline focus-visible:outline-none"
              title={`View details for ${getValue()}`}
            >
              {getValue()}
            </button>
            <LegacyBadge flags={row.original.legacyFlags} />
          </span>
        ),
      }),
    ]),
  })

  const actual = helper.group({
    id: 'actual',
    header: 'Actual fee structure (as recorded)',
    columns: helper.columns(
      historical.map((column) =>
        helper.display({
          id: column.key,
          header: column.label,
          cell: ({ row }) => <Money cell={row.original.actualCells[column.key] ?? BLANK_MONEY} />,
        }),
      ),
    ),
  })

  const installments = helper.group({
    id: 'scheduled',
    header: 'Installment fee structure (scheduled)',
    columns: helper.columns(
      scheduled.map((column) =>
        helper.display({
          id: column.key,
          header: column.label,
          cell: ({ row }) => (
            <Money cell={row.original.scheduledCells[column.key] ?? BLANK_MONEY} />
          ),
        }),
      ),
    ),
  })

  const status = helper.group({
    id: 'status',
    header: 'Status',
    columns: helper.columns([
      helper.display({
        id: 'receipt',
        header: 'Receipt',
        cell: ({ row }) => <ReceiptBadge summary={row.original.receiptSummary} />,
      }),
      helper.display({
        id: 'reminder',
        header: 'Reminder',
        cell: () => <ReminderCell />,
      }),
      helper.display({
        id: 'actions',
        header: 'Actions',
        cell: ({ row }) => (
          <div className="flex items-center gap-1 whitespace-nowrap">
            <button
              type="button"
              onClick={() => onOpenDetails(row.original)}
              className="rounded border border-zinc-300 px-1.5 py-0.5 text-[11px] text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              View details
            </button>
            {/*
              Disabled, not wired to a no-op: a button that looks live and does
              nothing is worse than one that says why it cannot act yet.
            */}
            <button
              type="button"
              disabled
              title="Receipt sending will be enabled in the receipt workflow."
              className="cursor-not-allowed rounded border border-dashed border-zinc-300 px-1.5 py-0.5 text-[11px] text-zinc-400 dark:border-zinc-700 dark:text-zinc-600"
            >
              Receipt
            </button>
            <button
              type="button"
              disabled
              title="Reminder sending will be enabled in the reminder workflow."
              className="cursor-not-allowed rounded border border-dashed border-zinc-300 px-1.5 py-0.5 text-[11px] text-zinc-400 dark:border-zinc-700 dark:text-zinc-600"
            >
              Reminder
            </button>
          </div>
        ),
      }),
    ]),
  })

  // A group with no columns is omitted entirely rather than rendered as an
  // empty banner. Two views reach this: an ECEA batch, which has no scheduled
  // installments at all, and the unassigned records, which have no batch sheet
  // behind them and so no ACTUAL section either. In both cases an empty banner
  // would imply the columns exist and failed to load.
  const groups = [
    identity,
    ...(historical.length > 0 ? [actual] : []),
    ...(scheduled.length > 0 ? [installments] : []),
    status,
  ]

  return groups as unknown as ColumnDef<typeof features, FinanceGridRow, unknown>[]
}
