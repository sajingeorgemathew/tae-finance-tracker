'use client'

import type { Session } from '@/lib/finance/grid/intake'
import { displayMoney, type MoneyCell } from '@/lib/finance/grid/money'
import {
  paymentStatusExplanation,
  paymentStatusLabel,
  type PaymentStatus,
} from '@/lib/finance/grid/payment-status'
import {
  legacyReceiptExplanation,
  type LegacyReceiptStatus,
  type LegacyReceiptSummary,
} from '@/lib/finance/grid/receipt-status'
import type { LegacyFlag } from '@/lib/finance/grid/types'
import { cn } from '@/lib/utils'

/**
 * The small, shared pieces of the finance grid.
 *
 * Kept together because the same decisions recur in the grid, the drawer and
 * the summary strip, and they are decisions rather than styling: what a blank
 * looks like, how a legacy inconsistency is signalled, how a payment status is
 * coloured so it can be read without the colour, and how a receipt status is
 * worded so it never reads as a statement about the student.
 *
 * ## The status colour system (FINANCE-GRID-03C)
 *
 * One restrained palette, used the same way everywhere:
 *
 *   Outstanding  amber    something is owed — worth a look
 *   Settled      emerald  nothing is owed
 *   Credit       sky      paid more than the recorded fee
 *   Unknown      zinc     no reliable figure; not a problem with the student
 *   Legacy       amber outline, tiny — historical data needs reading with care
 *
 * Every status also carries a glyph and its word, so the meaning survives
 * greyscale, colour-blindness and a printout. Rows are never coloured as a
 * whole: the figures stay in plain ink.
 */

/**
 * A money figure.
 *
 * Right-aligned and tabular so a column of figures lines up at the decimal
 * point, which is most of what makes a finance grid scannable. A blank is
 * rendered muted rather than absent, so an empty cell is visibly empty rather
 * than looking like a rendering failure.
 */
export function Money({
  cell,
  className,
  emphasis = false,
}: {
  cell: MoneyCell
  className?: string
  /** For the Balance column: a little heavier, so it can be found at a glance. */
  emphasis?: boolean
}) {
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
        emphasis && cell.kind === 'amount' && 'font-medium',
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

/** Glyph per status: a shape, so the meaning does not rest on the colour. */
const STATUS_GLYPH: Record<PaymentStatus, string> = {
  outstanding: '!',
  settled: '✓',
  credit: '+',
  unknown: '?',
}

const STATUS_TONE: Record<PaymentStatus, string> = {
  outstanding:
    'border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/40 dark:text-amber-200',
  settled:
    'border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800/70 dark:bg-emerald-950/40 dark:text-emerald-200',
  credit:
    'border-sky-300 bg-sky-50 text-sky-900 dark:border-sky-800/70 dark:bg-sky-950/40 dark:text-sky-200',
  unknown:
    'border-zinc-300 bg-zinc-100 text-zinc-600 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400',
}

const STATUS_DOT: Record<PaymentStatus, string> = {
  outstanding: 'bg-amber-500',
  settled: 'bg-emerald-500',
  credit: 'bg-sky-500',
  unknown: 'bg-zinc-400',
}

/**
 * The Payment Status pill.
 *
 * Compact, one word, glyph first. Its tooltip names the imported balance as
 * the source, so it reads as a translation of the figure beside it and not as
 * a verdict this system reached on its own.
 */
export function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const explanation = paymentStatusExplanation(status)
  return (
    <span
      title={explanation}
      aria-label={`${paymentStatusLabel(status)}. ${explanation}`}
      data-status={status}
      className={cn(
        'inline-flex cursor-help items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] leading-4 font-medium whitespace-nowrap',
        STATUS_TONE[status],
      )}
    >
      <span aria-hidden="true" className="w-2 text-center text-[10px]">
        {STATUS_GLYPH[status]}
      </span>
      {paymentStatusLabel(status)}
    </span>
  )
}

/** A coloured dot for the summary strip's counts. Always beside its word. */
export function StatusDot({ status }: { status: PaymentStatus }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-2 shrink-0 rounded-full', STATUS_DOT[status])}
    />
  )
}

/**
 * The Session column.
 *
 * Neutral text in a faint outline: it is a fact about which table the row
 * came from, not a status, and it must not compete with the status pill
 * beside it. A row with no session (ECEA, unassigned) shows a muted dash.
 */
export function SessionBadge({ session }: { session: Session | null }) {
  if (session === null) {
    return (
      <span className="text-zinc-300 dark:text-zinc-700" aria-label="No session">
        —
      </span>
    )
  }
  return (
    <span
      data-session={session}
      className="inline-flex items-center rounded border border-zinc-200 bg-white px-1.5 py-0.5 text-[11px] leading-4 whitespace-nowrap text-zinc-700 dark:border-zinc-700 dark:bg-zinc-950 dark:text-zinc-300"
    >
      {session}
    </span>
  )
}

const RECEIPT_LABEL: Record<LegacyReceiptStatus, string> = {
  sent: 'Sent',
  mixed: 'Mixed',
  not_sent: 'Not sent',
  unknown: 'Unknown',
}

const RECEIPT_TONE: Record<LegacyReceiptStatus, string> = {
  sent: 'text-emerald-800 dark:text-emerald-300',
  mixed: 'text-amber-800 dark:text-amber-300',
  not_sent: 'text-zinc-700 dark:text-zinc-300',
  unknown: 'text-zinc-400 dark:text-zinc-500',
}

/**
 * The historical receipt status, compactly.
 *
 * One word, with a small "legacy" mark and a tooltip that opens "Historical
 * workbook status", because the `receipts` table is empty and nothing here
 * describes a receipt this system issued. It says nothing about whether a
 * receipt PDF exists, and a legacy "Sent" will not block the receipt workflow
 * from issuing a real one later. "Unknown" is an absence of information, not
 * a problem with the student.
 */
export function ReceiptBadge({ summary }: { summary: LegacyReceiptSummary }) {
  const explanation = `Historical workbook status. ${legacyReceiptExplanation(summary)} No receipt has been issued by this system.`

  return (
    <span
      title={explanation}
      aria-label={`Legacy receipt: ${RECEIPT_LABEL[summary.status]}. ${explanation}`}
      data-receipt={summary.status}
      className={cn(
        'inline-flex cursor-help items-baseline gap-1 text-[12px] whitespace-nowrap',
        RECEIPT_TONE[summary.status],
      )}
    >
      {RECEIPT_LABEL[summary.status]}
      <span
        aria-hidden="true"
        className="rounded border border-zinc-200 px-0.5 text-[9px] leading-3 tracking-wide text-zinc-400 uppercase dark:border-zinc-700 dark:text-zinc-500"
      >
        legacy
      </span>
    </span>
  )
}

/**
 * The reminder column.
 *
 * There are no `reminder_deliveries` rows in the system. This states that fact
 * neutrally: nothing here is overdue, because nothing has been attempted and
 * no due-date rule exists yet. The wording is "Never sent", not "needed".
 */
export function ReminderCell() {
  return (
    <span
      className="text-[12px] whitespace-nowrap text-zinc-400 dark:text-zinc-600"
      title="No reminder has been sent from this system. Reminder sending arrives in a later workflow; nothing is claimed to be overdue."
    >
      Never sent
    </span>
  )
}
