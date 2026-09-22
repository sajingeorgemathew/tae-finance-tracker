'use client'

import { useMemo, type ReactNode } from 'react'

import {
  LegacyBadge,
  Money,
  PaymentStatusBadge,
  ReceiptBadge,
  ReminderCell,
  SessionBadge,
} from '@/components/finance/finance-cells'
import { BLANK_MONEY } from '@/lib/finance/grid/money'
import {
  allVisibleSelected,
  someVisibleSelected,
  toggleOne,
  toggleVisible,
  type RowSelection,
} from '@/lib/finance/grid/selection'
import { NO_STUDENT_NUMBER } from '@/lib/finance/grid/student-name'
import type { FinanceColumn, FinanceGridRow } from '@/lib/finance/grid/types'
import { cn } from '@/lib/utils'

/**
 * The Excel-style finance grid.
 *
 * A real `<table>`, not a grid of divs: screen readers announce row and column
 * relationships from the markup, and the whole point of this screen is that it
 * behaves like the spreadsheet senior staff already know.
 *
 * ## Layout (FINANCE-GRID-03C)
 *
 *   STUDENT            select · Student # · Student name           frozen
 *   STATUS             Session · Payment status · Balance          frozen ≥ 1280px
 *   RECEIPT · REMINDER Receipt · Reminder
 *   ACTUAL FEE STRUCTURE (as recorded)   …manifest columns…
 *   INSTALLMENT FEE STRUCTURE (scheduled) …manifest columns…
 *   ACTIONS            Details · Receipt · Reminder
 *
 * The operational answers — who is this, which cohort, do they owe money, how
 * much — come first and stay put while the Excel-like detail scrolls under
 * them. The frozen region is 644px with the Session column and 568px without,
 * which leaves a usable scrolling area on a 1366px laptop; on a narrower
 * window the STATUS group scrolls with the rest so the detail is still
 * reachable. The STUDENT trio is frozen at every width.
 *
 * Rows are never coloured as a whole: status is a small pill, the figures stay
 * in plain ink, and the density stays at 13px type on compact rows.
 *
 * ## Why not TanStack Table any more
 *
 * GRID-03 used `@tanstack/react-table` for grouped headers and row selection.
 * Both are now small, explicit pieces of this file: the column model below is
 * a plain list of groups, and selection is the pure `selection.ts` so that
 * "select all visible" can be tested as a rule. The package stays installed;
 * nothing here imports it. Not virtualised, for the same reason as before: the
 * largest intake is 41 rows, and virtualising would risk the sticky header and
 * frozen columns for no gain.
 */

// -----------------------------------------------------------------------------
// Widths, in pixels, for the frozen columns
// -----------------------------------------------------------------------------

const SELECT_WIDTH = 36
// Wide enough that "No student number" sits on one line: an unresolved
// student must not be the row that breaks the grid's rhythm.
const NUMBER_WIDTH = 120
const NAME_WIDTH = 200
const SESSION_WIDTH = 76
const STATUS_WIDTH = 112
const BALANCE_WIDTH = 100

type Freeze = 'always' | 'xl' | null

interface GridColumn {
  id: string
  header: ReactNode
  /** Right-aligned heading for money columns — by the manifest's kind, never a guess from the key. */
  align: 'left' | 'right'
  width?: number
  freeze: Freeze
  cell: (row: FinanceGridRow) => ReactNode
}

interface GridGroup {
  id: string
  label: string
  freeze: Freeze
  columns: GridColumn[]
}

export interface FinanceGridProps {
  rows: FinanceGridRow[]
  /** The ACTUAL group, from the batches' column manifests, unioned per intake. */
  columns: FinanceColumn[]
  /** The INSTALLMENT group, likewise. */
  scheduledColumns: FinanceColumn[]
  /** Whether any row states a session. When none does, the column is not shown. */
  showSession: boolean
  rowSelection: RowSelection
  onRowSelectionChange: (next: RowSelection) => void
  onOpenDetails: (row: FinanceGridRow) => void
}

export function FinanceGrid({
  rows,
  columns,
  scheduledColumns,
  showSession,
  rowSelection,
  onRowSelectionChange,
  onOpenDetails,
}: FinanceGridProps) {
  const visibleIds = useMemo(() => rows.map((row) => row.financeRecordId), [rows])
  const allSelected = allVisibleSelected(rowSelection, visibleIds)
  const someSelected = someVisibleSelected(rowSelection, visibleIds)

  const groups = useMemo(
    () =>
      buildGroups({
        historical: columns,
        scheduled: scheduledColumns,
        showSession,
        onOpenDetails,
        selectAll: (
          <input
            type="checkbox"
            aria-label="Select all visible students"
            checked={allSelected}
            ref={(element) => {
              if (element) element.indeterminate = someSelected
            }}
            onChange={(event) =>
              // Only the rows on screen: an intake, session, status or search
              // filter that hides a row also keeps it out of "select all".
              onRowSelectionChange(toggleVisible(rowSelection, visibleIds, event.target.checked))
            }
            className="size-3.5 cursor-pointer align-middle accent-zinc-900 dark:accent-zinc-100"
          />
        ),
        isSelected: (row) => rowSelection[row.financeRecordId] === true,
        toggle: (row) => onRowSelectionChange(toggleOne(rowSelection, row.financeRecordId)),
      }),
    [
      columns,
      scheduledColumns,
      showSession,
      onOpenDetails,
      allSelected,
      someSelected,
      rowSelection,
      visibleIds,
      onRowSelectionChange,
    ],
  )

  // Frozen offsets, left to right, for the columns that freeze.
  const offsets = useMemo(() => {
    const out = new Map<string, number>()
    let left = 0
    for (const group of groups) {
      if (group.freeze !== null) out.set(`group:${group.id}`, left)
      for (const column of group.columns) {
        if (column.freeze !== null) {
          out.set(column.id, left)
          left += column.width ?? 0
        }
      }
    }
    return out
  }, [groups])

  const leaves = groups.flatMap((group) => group.columns)

  return (
    <div className="relative overflow-auto rounded-md border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      {/*
        Separate borders, not collapsed. A collapsed border is shared between
        two cells and neither cell's background paints under it, so when the
        grid scrolls sideways a one-pixel sliver of the scrolled cells shows
        through between the frozen columns. With separate borders each frozen
        cell paints its own background edge to edge and nothing bleeds
        through. Row borders are therefore on the cells: a border on a <tr>
        renders only in the collapsed model.
      */}
      <table className="w-max min-w-full border-separate border-spacing-0 text-[13px]">
        <caption className="sr-only">
          Historical finance figures for the selected intake, as recorded in the source workbook,
          with the operational payment status derived from each row&rsquo;s imported balance.
        </caption>

        <thead className="sticky top-0 z-30">
          <tr>
            {groups.map((group) => (
              <th
                key={group.id}
                colSpan={group.columns.length}
                scope="colgroup"
                style={frozenStyle(offsets.get(`group:${group.id}`), groupWidth(group))}
                className={cn(
                  'border-b border-l border-zinc-200 bg-zinc-100 px-2 py-1 text-left text-[11px] font-medium tracking-wide whitespace-nowrap text-zinc-600 uppercase first:border-l-0 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400',
                  freezeClass(group.freeze),
                )}
              >
                {group.label}
              </th>
            ))}
          </tr>
          <tr>
            {leaves.map((column) => (
              <th
                key={column.id}
                scope="col"
                style={frozenStyle(offsets.get(column.id), column.width)}
                className={cn(
                  'border-b border-zinc-200 bg-zinc-50 px-2 py-1 text-left font-medium whitespace-nowrap text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900/60 dark:text-zinc-300',
                  column.align === 'right' && 'text-right',
                  freezeClass(column.freeze),
                )}
              >
                <Clamp width={column.width}>{column.header}</Clamp>
              </th>
            ))}
          </tr>
        </thead>

        <tbody>
          {rows.map((row) => (
            <tr
              key={row.financeRecordId}
              data-batch-id={row.batchId ?? undefined}
              data-session={row.session ?? undefined}
              data-status={row.paymentStatus}
              className="group hover:bg-sky-50/70 dark:hover:bg-sky-950/30"
            >
              {leaves.map((column) => (
                <td
                  key={column.id}
                  style={frozenStyle(offsets.get(column.id), column.width)}
                  className={cn(
                    'border-r border-b border-zinc-100 px-2 py-[3px] align-middle last:border-r-0 group-last:border-b-0 dark:border-zinc-900',
                    column.freeze !== null &&
                      'bg-white group-hover:bg-sky-50/70 dark:bg-zinc-950 dark:group-hover:bg-sky-950/30',
                    freezeClass(column.freeze),
                  )}
                >
                  <Clamp width={column.width}>{column.cell(row)}</Clamp>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/**
 * What the clamp subtracts from a column's declared width: `px-2` padding on
 * both sides plus the body cell's 1px right border. Without the border in the
 * sum each frozen column runs one pixel wide and the offsets drift.
 */
const CELL_PADDING = 17

/**
 * Holds a frozen cell's content to the column's declared width.
 *
 * A table column is never narrower than its widest content, so a long name or
 * "No student number" would silently widen a frozen column past the offset
 * the next frozen column is stuck at, and the two would overlap once the grid
 * scrolls. Clamping the content keeps the declared widths true; the name
 * still truncates with an ellipsis and its full text is in the title.
 */
function Clamp({ width, children }: { width: number | undefined; children: ReactNode }) {
  if (width === undefined) return <>{children}</>
  return (
    <div className="overflow-hidden whitespace-nowrap" style={{ width: width - CELL_PADDING }}>
      {children}
    </div>
  )
}

/**
 * A finance column heading: the source heading, verbatim.
 *
 * In a combined intake a column only one cohort's table has carries that
 * cohort as a compact secondary label, so two similar columns sitting side by
 * side — "Mar" from the Morning table, "Marc" from the Evening table at the
 * same sheet position — read as what they are. The tooltip names the other
 * heading at that position. A column both tables share is labelled by its
 * heading alone; nothing is merged, renamed or given a session it does not
 * have. Rows from the cohort whose table lacks the column are blank there,
 * which is not the same as $0.00.
 */
function FinanceHeading({ column }: { column: FinanceColumn }) {
  if (column.sessions.length !== 1) return <>{column.label}</>

  const session = column.sessions[0]
  const other = session === 'Morning' ? 'Evening' : 'Morning'
  const title =
    column.conflictingHeadings.length > 0
      ? `From the ${session} table. The ${other} table heads the same column position ${column.conflictingHeadings
          .map((heading) => `“${heading}”`)
          .join(' and ')}, shown beside it. Neither heading was changed.`
      : `Only the ${session} table has this column. ${other} rows are blank here because their table had no such cell.`

  return (
    <span title={title} data-source-session={session}>
      {column.label}{' '}
      <span className="rounded border border-zinc-200 px-1 text-[9px] leading-3 font-normal tracking-wide text-zinc-500 uppercase dark:border-zinc-700 dark:text-zinc-400">
        {session}
      </span>
    </span>
  )
}

function frozenStyle(left: number | undefined, width: number | undefined): React.CSSProperties | undefined {
  if (left === undefined) return undefined
  return { left, width, minWidth: width }
}

function groupWidth(group: GridGroup): number | undefined {
  if (group.freeze === null) return undefined
  return group.columns.reduce((sum, column) => sum + (column.width ?? 0), 0)
}

/**
 * `always` freezes at every width. `xl` freezes only from 1280px up, so on a
 * small laptop the STATUS group scrolls with the detail rather than eating
 * the space the detail needs. The z-index and background apply either way;
 * without `position: sticky` they are inert.
 */
function freezeClass(freeze: Freeze): string | undefined {
  if (freeze === 'always') return 'sticky z-10'
  if (freeze === 'xl') return 'xl:sticky z-10'
  return undefined
}

// -----------------------------------------------------------------------------
// Column model
// -----------------------------------------------------------------------------

function buildGroups(input: {
  historical: readonly FinanceColumn[]
  scheduled: readonly FinanceColumn[]
  showSession: boolean
  onOpenDetails: (row: FinanceGridRow) => void
  selectAll: ReactNode
  isSelected: (row: FinanceGridRow) => boolean
  toggle: (row: FinanceGridRow) => void
}): GridGroup[] {
  const student: GridGroup = {
    id: 'student',
    label: 'Student',
    freeze: 'always',
    columns: [
      {
        id: 'select',
        header: input.selectAll,
        align: 'left',
        width: SELECT_WIDTH,
        freeze: 'always',
        cell: (row) => (
          <input
            type="checkbox"
            aria-label={`Select ${row.studentName}`}
            checked={input.isSelected(row)}
            onChange={() => input.toggle(row)}
            className="size-3.5 cursor-pointer align-middle accent-zinc-900 dark:accent-zinc-100"
          />
        ),
      },
      {
        id: 'studentNumber',
        header: 'Student #',
        align: 'left',
        width: NUMBER_WIDTH,
        freeze: 'always',
        cell: (row) =>
          // The seven unresolved students carry no number. They are told apart
          // by an honest statement of absence, never by an invented id.
          row.studentNumber === null ? (
            <span className="text-[11px] whitespace-nowrap text-zinc-400 italic dark:text-zinc-600">
              {NO_STUDENT_NUMBER}
            </span>
          ) : (
            <span className="tabular-nums">{row.studentNumber}</span>
          ),
      },
      {
        id: 'studentName',
        header: 'Student name',
        align: 'left',
        width: NAME_WIDTH,
        freeze: 'always',
        cell: (row) => (
          <span className="flex items-center">
            <button
              type="button"
              onClick={() => input.onOpenDetails(row)}
              className="truncate text-left hover:underline focus-visible:underline focus-visible:outline-none"
              title={`View details for ${row.studentName}`}
            >
              {row.studentName}
            </button>
            <LegacyBadge flags={row.legacyFlags} />
          </span>
        ),
      },
    ],
  }

  const status: GridGroup = {
    id: 'status',
    label: 'Status',
    freeze: 'xl',
    columns: [
      ...(input.showSession
        ? [
            {
              id: 'session',
              header: 'Session',
              align: 'left' as const,
              width: SESSION_WIDTH,
              freeze: 'xl' as const,
              cell: (row: FinanceGridRow) => <SessionBadge session={row.session} />,
            },
          ]
        : []),
      {
        id: 'paymentStatus',
        header: 'Payment status',
        align: 'left',
        width: STATUS_WIDTH,
        freeze: 'xl',
        cell: (row) => <PaymentStatusBadge status={row.paymentStatus} />,
      },
      {
        id: 'balance',
        header: 'Balance',
        align: 'right',
        width: BALANCE_WIDTH,
        freeze: 'xl',
        // The imported figure, sign and all. The status beside it is what
        // says whether a negative means owed; the number itself is history.
        cell: (row) => <Money cell={row.legacyBalance} emphasis />,
      },
    ],
  }

  const history: GridGroup = {
    id: 'history',
    label: 'Receipt · Reminder',
    freeze: null,
    columns: [
      {
        id: 'receipt',
        header: 'Receipt',
        align: 'left',
        freeze: null,
        cell: (row) => <ReceiptBadge summary={row.receiptSummary} />,
      },
      {
        id: 'reminder',
        header: 'Reminder',
        align: 'left',
        freeze: null,
        cell: () => <ReminderCell />,
      },
    ],
  }

  const financeColumn = (column: FinanceColumn, cells: 'actualCells' | 'scheduledCells'): GridColumn => ({
    id: column.key,
    header: <FinanceHeading column={column} />,
    align: column.valueKind === 'money' ? 'right' : 'left',
    freeze: null,
    cell: (row) => <Money cell={row[cells][column.key] ?? BLANK_MONEY} />,
  })

  const actual: GridGroup = {
    id: 'actual',
    label: 'Actual fee structure (as recorded)',
    freeze: null,
    columns: input.historical.map((column) => financeColumn(column, 'actualCells')),
  }

  const installments: GridGroup = {
    id: 'scheduled',
    label: 'Installment fee structure (scheduled)',
    freeze: null,
    columns: input.scheduled.map((column) => financeColumn(column, 'scheduledCells')),
  }

  const actions: GridGroup = {
    id: 'actions',
    label: 'Actions',
    freeze: null,
    columns: [
      {
        id: 'actions',
        header: 'Actions',
        align: 'left',
        freeze: null,
        cell: (row) => (
          <div className="flex items-center gap-1 whitespace-nowrap">
            <button
              type="button"
              onClick={() => input.onOpenDetails(row)}
              className="rounded border border-zinc-300 px-1.5 py-0.5 text-[11px] text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Details
            </button>
            {/*
              Disabled, not wired to a no-op: a button that looks live and does
              nothing is worse than one that says why it cannot act yet. They
              sit here so the future workflows land where staff will look.
            */}
            <button
              type="button"
              disabled
              title="Available in a later workflow: receipt generation and sending."
              className="cursor-not-allowed rounded border border-dashed border-zinc-300 px-1.5 py-0.5 text-[11px] text-zinc-400 dark:border-zinc-700 dark:text-zinc-600"
            >
              Receipt
            </button>
            <button
              type="button"
              disabled
              title="Available in a later workflow: reminder sending."
              className="cursor-not-allowed rounded border border-dashed border-zinc-300 px-1.5 py-0.5 text-[11px] text-zinc-400 dark:border-zinc-700 dark:text-zinc-600"
            >
              Reminder
            </button>
          </div>
        ),
      },
    ],
  }

  // A group with no columns is omitted entirely rather than rendered as an
  // empty banner. Two views reach this: an ECEA intake, which has no scheduled
  // installments at all, and the unassigned records, which have no batch sheet
  // behind them and so no ACTUAL section either. In both cases an empty banner
  // would imply the columns exist and failed to load.
  return [
    student,
    status,
    history,
    ...(actual.columns.length > 0 ? [actual] : []),
    ...(installments.columns.length > 0 ? [installments] : []),
    actions,
  ]
}
