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
 * ## Structure and values are two different things
 *
 * Which columns a batch *has* comes from its column manifest
 * (`batch_finance_columns`, FINANCE-COLUMN-MANIFEST-03A): existence, order,
 * label, section, money-or-text. Which *value* a student has in a column comes
 * from the student's own record and installments. The two are combined here
 * and only here, and the rule where they meet is fixed: a column the manifest
 * lists and a student has no value in is blank. It is never `$0.00`, and no
 * placeholder is ever written back to make the shape come out.
 *
 * Where a batch has no manifest — the unassigned view, or a batch created some
 * other way — the columns are derived from the union of cells across its rows,
 * which is the older approach and cannot show a column every student left
 * empty. The view model says which of the two it used.
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
  resolveManifestColumns,
  toFinanceColumn,
  type RawManifestColumn,
  type ResolvedColumn,
} from './manifest.ts'
import {
  BLANK_MONEY,
  moneyFromNumeric,
  sumMoney,
  type MoneyCell,
} from './money.ts'
import type { Session } from './intake.ts'
import { paymentStatusFromBalanceState } from './payment-status.ts'
import { summarizeLegacyReceipts } from './receipt-status.ts'
import { resolveStudentName, type NamedStudent } from './student-name.ts'
import { unassignedReasonOf } from './unassigned.ts'
import type {
  FinanceColumn,
  FinanceGridRow,
  LayoutSource,
  LegacyFlag,
  PaymentEntry,
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
  /**
   * `legacy_raw_json -> 'batch' ->> 'formatted_text'`: the Tracker Master
   * Batch cell as Excel displayed it, e.g. `Aug-25`. Extracted the same way.
   */
  legacy_batch_hint: string | null
}

export interface BuildGridInput {
  records: readonly RawFinanceRecord[]
  installments: readonly RawInstallment[]
  payments: readonly RawPayment[]
  /** The selected batch's `batch_finance_columns` rows. Empty when it has none. */
  manifest?: readonly RawManifestColumn[]
  programShortCode: string
  batchName: string | null
  /** The real batch the rows belong to. Null for the unassigned view. */
  batchId?: string | null
  /** The cohort the batch's name states. Null for ECEA and the unassigned view. */
  session?: Session | null
}

export interface BuiltGrid {
  columns: FinanceColumn[]
  scheduledColumns: FinanceColumn[]
  layoutSource: LayoutSource
  blankStructuralColumns: number
  rows: FinanceGridRow[]
  totals: SummaryTotals
  balanceConvention: BalanceConventionResult
}

// -----------------------------------------------------------------------------
// Scheduled installment columns (derived fallback)
// -----------------------------------------------------------------------------

/** A scheduled column derived from normalized installments alone. */
export interface ScheduledColumn {
  key: string
  /** `legacy_column_name` as the workbook spelled it, else the default note. */
  label: string
  /** Source order within the batch's INSTALLMENT FEE STRUCTURE section. */
  sequence: number
}

/**
 * The batch's scheduled columns, from normalized installments only.
 *
 * The fallback for a batch with no installment manifest. A batch with no
 * installments — every ECEA record — gets an empty list and the grid renders
 * no INSTALLMENT group at all. That is the ticket's rule: the ECEA sheet's
 * plan is ordinal, not monthly, and no schedule is manufactured for it. Its
 * ordinal fee columns are historical ACTUAL columns instead, which is where
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
    const key = derivedScheduledKey(sequence, label)

    if (!byKey.has(key)) byKey.set(key, { key, label, sequence })
  }

  return [...byKey.values()].sort(
    (a, b) => a.sequence - b.sequence || a.label.localeCompare(b.label),
  )
}

function derivedScheduledKey(sequence: number, label: string): string {
  return `sched:${sequence}:${label}`
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
// Column layout — manifest first, derived where the manifest is silent
// -----------------------------------------------------------------------------

function derivedActualColumn(column: LegacyColumn): ResolvedColumn {
  return {
    key: column.key,
    label: column.label,
    section: 'actual',
    role: 'other',
    valueKind: 'money',
    order: column.index,
    unheaded: column.unheaded,
    origin: 'derived',
    sessions: [],
    conflictingHeadings: [],
    letter: column.letter,
    visible: true,
    displayEvenIfBlank: true,
  }
}

function derivedScheduledColumn(column: ScheduledColumn): ResolvedColumn {
  return {
    key: column.key,
    label: column.label,
    section: 'installment',
    role: 'other',
    valueKind: 'money',
    order: column.sequence,
    unheaded: false,
    origin: 'derived',
    sessions: [],
    conflictingHeadings: [],
    letter: null,
    visible: true,
    displayEvenIfBlank: true,
  }
}

/**
 * The ACTUAL columns of the batch.
 *
 * The manifest, when it has any ACTUAL rows, defines the group: every column
 * it lists (hidden ones included, so their letters are accounted for), in its
 * order. Then, as a safety net rather than a source, any letter present in a
 * row's preserved cells that the manifest does not mention is appended as a
 * derived column — so a value can never be silently hidden by a manifest that
 * happens not to describe it. With this workbook that never happens; the test
 * is what makes it a guarantee rather than a hope.
 *
 * With no manifest rows, the group is the older union-of-cells derivation.
 */
function resolveActualColumns(
  manifest: readonly ResolvedColumn[],
  rawJsonByRecord: readonly unknown[],
): ResolvedColumn[] {
  const derived = resolveHistoricalColumns(rawJsonByRecord).map(derivedActualColumn)
  if (manifest.length === 0) return derived

  const known = new Set(manifest.map((column) => column.letter).filter((letter) => letter !== null))
  const extra = derived.filter((column) => column.letter !== null && !known.has(column.letter))

  return [...manifest, ...extra]
}

/**
 * Maps one installment to a manifest column, or to nothing.
 *
 * The importer assigned `sequence_number` by walking the schedule section left
 * to right, and the manifest's `display_order` for that section is the same
 * walk, so the sequence is the join. The heading is checked as well: if the
 * installment's own `legacy_column_name` disagrees with the manifest heading
 * at that position, the installment is *not* placed under a column that may
 * describe something else — it gets a derived column of its own instead, and
 * nothing is hidden or mislabelled.
 */
function manifestColumnForInstallment(
  installment: RawInstallment,
  byOrder: ReadonlyMap<number, ResolvedColumn>,
): ResolvedColumn | null {
  if (installment.sequence_number === null) return null
  const column = byOrder.get(installment.sequence_number)
  if (!column) return null

  const heading = installment.legacy_column_name?.trim()
  if (heading && heading !== column.label) return null

  return column
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
    legacyBatchHint: payment.legacy_batch_hint?.trim() || null,
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
  const manifest = resolveManifestColumns(input.manifest ?? [])
  const rawJsonByRecord = input.records.map((record) => record.legacy_raw_json)

  // --- Columns: the manifest defines the layout; row data never adds to it
  // except as the documented safety net ---------------------------------------
  const actualColumns = resolveActualColumns(manifest.actual, rawJsonByRecord)

  const scheduledByOrder = new Map(manifest.installment.map((column) => [column.order, column]))
  const scheduledColumns: ResolvedColumn[] = [...manifest.installment]
  const derivedScheduled = new Map<string, ResolvedColumn>()
  if (manifest.installment.length === 0) {
    for (const column of resolveScheduledColumns(input.installments)) {
      scheduledColumns.push(derivedScheduledColumn(column))
    }
  } else {
    // Installments the manifest does not place get a derived column each, so
    // a scheduled figure is never dropped because its position is undescribed.
    for (const installment of input.installments) {
      if (manifestColumnForInstallment(installment, scheduledByOrder) !== null) continue
      const sequence = installment.sequence_number ?? Number.MAX_SAFE_INTEGER
      const key = derivedScheduledKey(sequence, scheduledLabel(installment))
      if (!derivedScheduled.has(key)) {
        derivedScheduled.set(
          key,
          derivedScheduledColumn({ key, label: scheduledLabel(installment), sequence }),
        )
      }
    }
    scheduledColumns.push(
      ...[...derivedScheduled.values()].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key)),
    )
  }

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

    // Every column starts blank. A blank source cell produced no installment
    // row at all, so a key nothing fills stays blank here — the manifest says
    // the column exists, the record says the student has nothing in it, and
    // "nothing" is not $0.00.
    const scheduledCells: Record<string, MoneyCell> = {}
    for (const column of scheduledColumns) scheduledCells[column.key] = BLANK_MONEY
    for (const installment of installmentsByRecord.get(record.id) ?? []) {
      const column =
        manifest.installment.length > 0
          ? manifestColumnForInstallment(installment, scheduledByOrder)
          : null
      const key =
        column?.key ??
        derivedScheduledKey(
          installment.sequence_number ?? Number.MAX_SAFE_INTEGER,
          scheduledLabel(installment),
        )
      if (key in scheduledCells) {
        scheduledCells[key] = moneyFromNumeric(installment.scheduled_amount)
      }
    }

    const receiptSummary = summarizeLegacyReceipts(
      payments.map((payment) => payment.legacyReceiptSent),
    )

    const disagrees = balanceDisagreesWithConvention(fee, paid, balance)
    const balanceState = balanceStateOf(balance, balanceConvention.convention)

    return {
      financeRecordId: record.id,
      studentId: record.student_id,
      studentNumber: student?.student_number?.trim() || null,
      studentName: student ? resolveStudentName(student) : 'Unnamed student',
      programShortCode: input.programShortCode,
      batchId: input.batchId ?? null,
      batchName: input.batchName,
      session: input.session ?? null,
      // The reason is a fact about an unassigned record only. A batch record's
      // raw JSON is a workbook row, and is not asked.
      unassignedReason: record.batch_id === null ? unassignedReasonOf(record.legacy_raw_json) : null,
      sourceBatchHints: [
        ...new Set(
          payments
            .map((payment) => payment.legacyBatchHint)
            .filter((hint): hint is string => hint !== null),
        ),
      ],

      legacyTotalFee: fee,
      legacyTotalPaid: paid,
      legacyBalance: balance,

      actualCells: historicalCellsForRecord(record.legacy_raw_json, actualColumns),
      scheduledCells,

      payments,
      paymentCount: payments.length,
      paymentTotal: sumMoney(payments.map((payment) => payment.amount)).total,
      lastPaymentDate: payments.find((payment) => payment.date !== null)?.date ?? null,

      receiptStatus: receiptSummary.status,
      receiptSummary,

      balanceState,
      // The one derivation of Payment Status: from the imported balance under
      // this batch's verified convention. The badge and the filter both read
      // the field; neither recomputes it.
      paymentStatus: paymentStatusFromBalanceState(balanceState),
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

  // --- Visibility, decided once the cells are known --------------------------
  const allBlank = (column: ResolvedColumn): boolean =>
    rows.every((row) => {
      const cell =
        column.section === 'actual'
          ? row.actualCells[column.key]
          : row.scheduledCells[column.key]
      return cell === undefined || cell.kind === 'blank'
    })

  const shown = (column: ResolvedColumn): boolean =>
    column.visible && (column.displayEvenIfBlank || !allBlank(column))

  const visibleActual = actualColumns.filter(shown)
  const visibleScheduled = scheduledColumns.filter(shown)

  // Hidden columns must not leak their cells either: the browser gets exactly
  // the keys it has columns for.
  const visibleKeys = new Set([...visibleActual, ...visibleScheduled].map((column) => column.key))
  for (const row of rows) {
    row.actualCells = pick(row.actualCells, visibleKeys)
    row.scheduledCells = pick(row.scheduledCells, visibleKeys)
  }

  const blankStructuralColumns = [...visibleActual, ...visibleScheduled].filter(
    (column) => column.origin === 'manifest' && allBlank(column),
  ).length

  const usedManifest = [...visibleActual, ...visibleScheduled].some(
    (column) => column.origin === 'manifest',
  )
  const layoutSource: LayoutSource =
    usedManifest ? 'manifest' : visibleActual.length + visibleScheduled.length > 0 ? 'derived' : 'none'

  return {
    columns: visibleActual.map(toFinanceColumn),
    scheduledColumns: visibleScheduled.map(toFinanceColumn),
    layoutSource,
    blankStructuralColumns,
    rows,
    totals: summarize(rows),
    balanceConvention,
  }
}

function pick(cells: Record<string, MoneyCell>, keys: ReadonlySet<string>): Record<string, MoneyCell> {
  const out: Record<string, MoneyCell> = {}
  for (const [key, cell] of Object.entries(cells)) {
    if (keys.has(key)) out[key] = cell
  }
  return out
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
 * the figures that exist rather than implying it covers everyone. A column the
 * manifest restores contributes nothing here: structure is not a figure.
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
