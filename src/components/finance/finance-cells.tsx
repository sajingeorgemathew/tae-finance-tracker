'use client'

import { displayMoney, type MoneyCell } from '@/lib/finance/grid/money'
import {
  legacyReceiptExplanation,
  legacyReceiptLabel,
  type LegacyReceiptSummary,
} from '@/lib/finance/grid/receipt-status'
import type { LegacyFlag } from '@/lib/finance/grid/types'
import { cn } from '@/lib/utils'

/**
 * The small, shared pieces of the finance grid.
 *
 * Kept together because the same three decisions recur in the grid, the drawer
 * and the summary strip, and they are decisions rather than styling: what a
 * blank looks like, how a legacy inconsistency is signalled, and how a receipt
 * status is worded so it never reads as a statement about the student.
 */

/**
 * A money figure.
 *
 * Right-aligned and tabular so a column of figures lines up at the decimal
 * point, which is most of what makes a finance grid scannable. A blank is
 * rendered muted rather than absent, so an empty cell is visibly empty rather
 * than looking like a rendering failure.
 */
export function Money({ cell, className }: { cell: MoneyCell; className?: string }) {
  const negative = cell.kind === 'amount' && cell.amount < 0

  return (
    <span
      className={cn(
        'block text-right tabular-nums',
        cell.kind === 'blank' && 'text-zinc-300 dark:text-zinc-700',
        // Errors and free text are not figures; left-aligning them stops them
        // being read as a number that happens to be spelled oddly.
        (cell.kind === 'text' || cell.kind === 'error') && 'text-left text-zinc-500 italic',
        negative && 'text-red-700 dark:text-red-400',
        className,
      )}
      title={cell.kind === 'error' ? 'The workbook itself holds an error in this cell.' : undefined}
    >
      {displayMoney(cell)}
    </span>
  )
}

/** Plain-language wording for each legacy flag. Never says a value is wrong. */
const FLAG_TEXT: Record<LegacyFlag, string> = {
  no_student_number: 'The workbook recorded no student number for this row.',
  error_cell: 'The workbook itself holds a spreadsheet error on this row.',
  balance_not_recorded: 'No balance figure was recorded for this student.',
  fee_or_paid_not_recorded: 'A total fee or total paid figure was not recorded.',
  balance_differs_from_batch_convention:
    'This row’s balance follows different arithmetic from the rest of the batch.',
}

/**
 * The quiet legacy marker.
 *
 * Deliberately not an error: amber, small, and worded as a description of the
 * record rather than a judgement of it. Historical finance data is allowed to
 * be inconsistent — it is the record of what happened, and a screen full of red
 * would train staff to ignore the one row that matters.
 */
export function LegacyBadge({ flags }: { flags: readonly LegacyFlag[] }) {
  if (flags.length === 0) return null

  const detail = [
    'Historical workbook information is displayed as originally recorded.',
    ...flags.map((flag) => FLAG_TEXT[flag]),
  ].join(' ')

  return (
    <span
      title={detail}
      aria-label={detail}
      className="ml-1.5 inline-flex shrink-0 cursor-help items-center rounded border border-amber-300 bg-amber-50 px-1 text-[10px] leading-4 font-medium text-amber-800 dark:border-amber-800/60 dark:bg-amber-950/40 dark:text-amber-300"
    >
      ⚠ Legacy
    </span>
  )
}

/**
 * The historical receipt status.
 *
 * Every variant says "Legacy", because the `receipts` table is empty and
 * nothing here describes a receipt this system issued. "Unknown" is styled the
 * same as the rest on purpose: it is an absence of information, not a problem
 * with the student.
 */
export function ReceiptBadge({ summary }: { summary: LegacyReceiptSummary }) {
  const tone = {
    sent: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300',
    mixed: 'border-amber-300 bg-amber-50 text-amber-800 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-300',
    not_sent: 'border-zinc-300 bg-zinc-100 text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300',
    unknown: 'border-zinc-200 bg-white text-zinc-500 dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-500',
  }[summary.status]

  const explanation = legacyReceiptExplanation(summary)

  return (
    <span
      title={explanation}
      aria-label={explanation}
      className={cn(
        'inline-flex cursor-help items-center rounded border px-1.5 py-0.5 text-[11px] leading-4 whitespace-nowrap',
        tone,
      )}
    >
      {legacyReceiptLabel(summary.status).replace('Legacy receipt: ', '')}
    </span>
  )
}

/**
 * The reminder column.
 *
 * There are no `reminder_deliveries` rows in the system. This states that fact
 * neutrally: nothing here is overdue, because nothing has been attempted.
 */
export function ReminderCell() {
  return (
    <span
      className="text-zinc-400 dark:text-zinc-600"
      title="No reminders have been sent from this system. Reminder sending arrives in a later ticket."
    >
      No reminders sent
    </span>
  )
}
