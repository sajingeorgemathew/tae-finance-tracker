/**
 * Building the Finance Grid view model.
 *
 * Pure by design: it takes plain row shapes in and gives the view model out, so
 * the rules below are testable without a database and cannot drift towards
 * whatever a query happens to return.
 *
 * ## The rule that governs everything here
 *
 * For a batch row, **the workbook's own snapshot wins**. Total Fee, Total Paid,
 * Balance and every ACTUAL-section cell come from what was imported from that
 * batch sheet, and are never recalculated because the normalized payments add
 * up differently. They usually will add up differently: Tracker Master routes a
 * payment to a batch record only when the student appears in exactly one batch
 * table for that program, so a batch row can legitimately show a Total Paid
 * with no payments behind it in this system.
 *
 * Normalized payments remain the canonical transaction history and are shown as
 * exactly that — a separate, separately-labelled figure in the drawer. They do
 * not overwrite the historical presentation, and Tracker Master's own
 * `Balance Fees` (a row-local formula, never a student balance) is not used at
 * all.
 *
 * ## What is derived
 *
 * Only things that are *about* the data rather than a restatement of it: which
 * columns a batch has, whether its balances follow a consistent convention,
 * what the workbook recorded about receipts, and which rows carry a legacy
 * inconsistency worth a quiet marker.
 */

import {
  balanceStateOf,
  resolveBalanceConvention,
  type BalanceConventionResult,
} from './balance.ts'
import {
  historicalCellsForRecord,
  resolveHistoricalColumns,
  rowHasErrorCell,
  type LegacyColumn,
} from './legacy-cells.ts'
import {
  BLANK_MONEY,
  moneyFromNumeric,
  sumMoney,
  type MoneyCell,
} from './money.ts'
import { summarizeLegacyReceipts } from './receipt-status.ts'
import { resolveStudentName, type NamedStudent } from './student-name.ts'
import type {
  FinanceGridRow,
  LegacyFlag,
  PaymentEntry,
  ScheduledColumn,
  SummaryTotals,
} from './types.ts'

// -----------------------------------------------------------------------------
// Input shapes — the columns the loader actually selects
// -----------------------------------------------------------------------------

export interface RawStudent extends NamedStudent {
  id: string
}

export interface RawFinanceRecord {
  id: string
  student_id: string
  batch_id: string | null
  legacy_total_fee: string | null
  legacy_total_paid: string | null
  legacy_balance: string | null
  legacy_source_row: number | null
  /** The preserved workbook row. Read here; never forwarded to the browser. */
  legacy_raw_json: unknown
  student: RawStudent | null
}

export interface RawInstallment {
  id: string
  student_finance_record_id: string
  sequence_number: number | null
  scheduled_amount: string | null
  legacy_column_name: string | null
  default_note: string | null
  custom_note: string | null
}

export interface RawPayment {
  id: string
  student_finance_record_id: string
  amount: string | null
  payment_date: string | null
  payment_method: string | null
  note: string | null
  voided_at: string | null
  /**
   * `legacy_raw_json ->> 'receipt_sent'`, extracted by the query so the rest of
   * the payment's provenance never leaves the database.
   */
  legacy_receipt_sent: string | null
}

export interface BuildGridInput {
  records: readonly RawFinanceRecord[]
  installments: readonly RawInstallment[]
  payments: readonly RawPayment[]
  programShortCode: string
  batchName: string | null
}

export interface BuiltGrid {
  columns: LegacyColumn[]
  scheduledColumns: ScheduledColumn[]
  rows: FinanceGridRow[]
  totals: SummaryTotals
  balanceConvention: BalanceConventionResult
}

// -----------------------------------------------------------------------------
// Scheduled installment columns
// -----------------------------------------------------------------------------

/**
 * The batch's scheduled columns, from normalized installments only.
 *
 * A batch with no installments — every ECEA record — gets an empty list and the
 * grid renders no INSTALLMENT group at all. That is the ticket's rule: the ECEA
 * sheet's plan is ordinal, not monthly, and no schedule is manufactured for it.
 * Its ordinal fee columns are historical ACTUAL columns instead, which is where
 * the workbook put them.
 *
 * Ordering is `sequence_number`, which the importer assigned by walking the
 * INSTALLMENT FEE STRUCTURE section left to right — so it is the source order,
 * not an alphabetical or calendar one. A month name is never turned into a
 * date: the workbook states no year.
 */
export function resolveScheduledColumns(
  installments: readonly RawInstallment[],
): ScheduledColumn[] {
  const byKey = new Map<string, ScheduledColumn>()

  for (const installment of installments) {
    const sequence = installment.sequence_number ?? Number.MAX_SAFE_INTEGER
    const label = scheduledLabel(installment)
    const key = `sched:${sequence}:${label}`

    if (!byKey.has(key)) byKey.set(key, { key, label, sequence })
  }

  return [...byKey.values()].sort(
    (a, b) => a.sequence - b.sequence || a.label.localeCompare(b.label),
  )
}

/**
 * The heading for a scheduled column.
 *
 * `legacy_column_name` is the workbook's own heading and is preferred. A staff
 * override (`custom_note`) comes next, then the system default note. The
 * fallback names the position rather than inventing a month.
 */
function scheduledLabel(installment: RawInstallment): string {
  const legacy = installment.legacy_column_name?.trim()
  if (legacy) return legacy

  const custom = installment.custom_note?.trim()
  if (custom) return custom

  const fallback = installment.default_note?.trim()
  if (fallback) return fallback

  return installment.sequence_number === null
    ? 'Scheduled'
    : `Scheduled ${installment.sequence_number}`
}

// -----------------------------------------------------------------------------
// Payments
// -----------------------------------------------------------------------------

/**
 * One payment, reduced to what a staff member reads.
 *
 * The amount is the stored `NUMERIC`, which may be negative for an adjustment;
 * it is shown as recorded. The method keeps the workbook's own spelling — the
 * import normalised none of them, and doing it here would hide that.
 */
function toPaymentEntry(payment: RawPayment): PaymentEntry {
  return {
    id: payment.id,
    date: payment.payment_date,
    amount: moneyFromNumeric(payment.amount),
    method: payment.payment_method?.trim() || null,
    legacyReceiptSent: payment.legacy_receipt_sent?.trim() || null,
    note: payment.note?.trim() || null,
    voided: payment.voided_at !== null,
  }
}

/**
 * Newest first, and rows with no readable date last.
 *
 * Some Tracker Master dates could not be parsed. Those payments are real and
 * are shown; they simply cannot be placed in the sequence, so they sit at the
 * end rather than being assigned a date.
 */
function byDateDescending(a: PaymentEntry, b: PaymentEntry): number {
  if (a.date === b.date) return 0
  if (a.date === null) return 1
  if (b.date === null) return -1
  return a.date < b.date ? 1 : -1
}

// -----------------------------------------------------------------------------
// Rows
// -----------------------------------------------------------------------------

/**
 * Which columns the batch as a whole ever fills in.
 *
 * A marker on every row is not a marker. The ECEA roster records no balance for
 * any of its fifty students, so flagging each one for a missing balance would
 * decorate the entire batch and teach staff to ignore the symbol — while the
 * fact itself is already stated once, properly, in the summary strip.
 */
interface BatchFieldPresence {
  anyFee: boolean
  anyPaid: boolean
  anyBalance: boolean
}

/**
 * Which legacy inconsistencies a row carries.
 *
 * These drive one quiet marker, never a red error. Nothing in this list says a
 * value is wrong — each entry says something was not recorded, or that a row
 * does not follow the rest of its batch. The distinction matters: the workbook
 * is the historical record, and this screen is not entitled to overrule it.
 *
 * A missing figure is only worth marking when the batch around it records that
 * figure, because then the row genuinely stands out. Where the whole batch
 * leaves a column empty, that is the shape of the sheet rather than a fact
 * about any one student, and it is reported at batch level instead.
 */
function legacyFlagsFor(input: {
  studentNumber: string | null
  fee: MoneyCell
  paid: MoneyCell
  balance: MoneyCell
  hasErrorCell: boolean
  balanceDisagrees: boolean
  presence: BatchFieldPresence
}): LegacyFlag[] {
  const flags: LegacyFlag[] = []

  if (input.studentNumber === null) flags.push('no_student_number')
  if (input.hasErrorCell) flags.push('error_cell')
  if (input.balance.kind === 'blank' && input.presence.anyBalance) {
    flags.push('balance_not_recorded')
  }
  if (
    (input.fee.kind === 'blank' && input.presence.anyFee) ||
    (input.paid.kind === 'blank' && input.presence.anyPaid)
  ) {
    flags.push('fee_or_paid_not_recorded')
  }
  if (input.balanceDisagrees) flags.push('balance_differs_from_batch_convention')

  return flags
}

const EPSILON = 0.005

/** Whether this row's own arithmetic differs from `paid − fee`. */
function balanceDisagreesWithConvention(
  fee: MoneyCell,
  paid: MoneyCell,
  balance: MoneyCell,
): boolean {
  if (fee.kind !== 'amount' || paid.kind !== 'amount' || balance.kind !== 'amount') {
    return false
  }
  return Math.abs(paid.amount - fee.amount - balance.amount) > EPSILON
}

/**
 * Builds the whole grid for one batch.
 *
 * Row order is the workbook's own: `legacy_source_row`, so the screen reads
 * down the sheet the way staff remember it. Records with no source row (the
 * unassigned ones, which have no batch sheet behind them) fall to the end and
 * are ordered by name so the list is stable between renders.
 */
export function buildFinanceGrid(input: BuildGridInput): BuiltGrid {
  const columns = resolveHistoricalColumns(input.records.map((record) => record.legacy_raw_json))
  const scheduledColumns = resolveScheduledColumns(input.installments)

  const installmentsByRecord = groupBy(input.installments, (item) => item.student_finance_record_id)
  const paymentsByRecord = groupBy(input.payments, (item) => item.student_finance_record_id)

  // The convention is resolved from the batch's own snapshots before any row is
  // built, because a row's balance state is meaningless until the batch has
  // agreed on what a sign means.
  const figures = input.records.map((record) => ({
    fee: moneyFromNumeric(record.legacy_total_fee),
    paid: moneyFromNumeric(record.legacy_total_paid),
    balance: moneyFromNumeric(record.legacy_balance),
  }))
  const balanceConvention = resolveBalanceConvention(figures)

  const presence: BatchFieldPresence = {
    anyFee: figures.some((figure) => figure.fee.kind === 'amount'),
    anyPaid: figures.some((figure) => figure.paid.kind === 'amount'),
    anyBalance: figures.some((figure) => figure.balance.kind === 'amount'),
  }

  const rows: FinanceGridRow[] = input.records.map((record, index) => {
    const { fee, paid, balance } = figures[index]
    const student = record.student

    const payments = (paymentsByRecord.get(record.id) ?? [])
      .map(toPaymentEntry)
      .sort(byDateDescending)

    const scheduledCells: Record<string, MoneyCell> = {}
    for (const column of scheduledColumns) scheduledCells[column.key] = BLANK_MONEY
    for (const installment of installmentsByRecord.get(record.id) ?? []) {
      const sequence = installment.sequence_number ?? Number.MAX_SAFE_INTEGER
      const key = `sched:${sequence}:${scheduledLabel(installment)}`
      // A blank source cell produced no installment row at all, so an absent
      // key stays blank here. It is never filled in as $0.00.
      if (key in scheduledCells) {
        scheduledCells[key] = moneyFromNumeric(installment.scheduled_amount)
      }
    }

    const receiptSummary = summarizeLegacyReceipts(
      payments.map((payment) => payment.legacyReceiptSent),
    )

    const disagrees = balanceDisagreesWithConvention(fee, paid, balance)

    return {
      financeRecordId: record.id,
      studentId: record.student_id,
      studentNumber: student?.student_number?.trim() || null,
      studentName: student ? resolveStudentName(student) : 'Unnamed student',
      programShortCode: input.programShortCode,
      batchName: input.batchName,

      legacyTotalFee: fee,
      legacyTotalPaid: paid,
      legacyBalance: balance,

      actualCells: historicalCellsForRecord(record.legacy_raw_json, columns),
      scheduledCells,

      payments,
      paymentCount: payments.length,
      paymentTotal: sumMoney(payments.map((payment) => payment.amount)).total,
      lastPaymentDate: payments.find((payment) => payment.date !== null)?.date ?? null,

      receiptStatus: receiptSummary.status,
      receiptSummary,

      balanceState: balanceStateOf(balance, balanceConvention.convention),
      legacyFlags: legacyFlagsFor({
        studentNumber: student?.student_number?.trim() || null,
        fee,
        paid,
        balance,
        hasErrorCell: rowHasErrorCell(record.legacy_raw_json),
        balanceDisagrees: disagrees,
        presence,
      }),
    }
  })

  rows.sort(compareBySourceRow(input.records))

  return {
    columns,
    scheduledColumns,
    rows,
    totals: summarize(rows),
    balanceConvention,
  }
}

/** Orders rows the way the workbook does, with a stable fallback. */
function compareBySourceRow(records: readonly RawFinanceRecord[]) {
  const sourceRowById = new Map(records.map((record) => [record.id, record.legacy_source_row]))

  return (a: FinanceGridRow, b: FinanceGridRow): number => {
    const rowA = sourceRowById.get(a.financeRecordId) ?? null
    const rowB = sourceRowById.get(b.financeRecordId) ?? null

    if (rowA !== null && rowB !== null && rowA !== rowB) return rowA - rowB
    if (rowA !== null && rowB === null) return -1
    if (rowA === null && rowB !== null) return 1

    return a.studentName.localeCompare(b.studentName) || a.financeRecordId.localeCompare(b.financeRecordId)
  }
}

/**
 * Batch totals, summed only from this batch's own imported snapshots.
 *
 * Normalized payments are deliberately not added in. Tracker Master's
 * transactions and the batch sheet's Total Paid are two views of the same
 * historical money, and combining them would double it — which is exactly why
 * the import refused to write the batch sheets' ACTUAL cells as payments.
 *
 * The `*Missing` counts are what let the summary strip say a total is based on
 * the figures that exist rather than implying it covers everyone.
 */
export function summarize(rows: readonly FinanceGridRow[]): SummaryTotals {
  const fees = sumMoney(rows.map((row) => row.legacyTotalFee))
  const paid = sumMoney(rows.map((row) => row.legacyTotalPaid))
  const balance = sumMoney(rows.map((row) => row.legacyBalance))

  return {
    students: rows.length,
    totalFees: fees.total,
    totalPaid: paid.total,
    balance: balance.total,
    feesMissing: fees.missing,
    paidMissing: paid.missing,
    balanceMissing: balance.missing,
  }
}

function groupBy<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>()
  for (const item of items) {
    const group = out.get(key(item))
    if (group) group.push(item)
    else out.set(key(item), [item])
  }
  return out
}
