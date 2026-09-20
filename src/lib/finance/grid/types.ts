/**
 * The Finance Grid view model — the only finance shape a browser ever sees.
 *
 * Everything in this file is deliberately *derived*. No database row reaches a
 * Client Component: `legacy_raw_json` is read on the server and turned into
 * labelled columns and formatted money here, so the browser receives the
 * historical batch table and nothing else. A payment contributes its date,
 * amount, method, recorded receipt value and staff remark; its source keys,
 * routing notes, workbook formulas, row numbers and balance-formula cells stay
 * on the server.
 *
 * That is a privacy boundary as much as a tidiness one — the raw JSON carries
 * per-row provenance that staff have no reason to read and that should not sit
 * in a page's serialised props.
 */

import type { BalanceConventionResult, BalanceState } from './balance.ts'
import type { LegacyColumn } from './legacy-cells.ts'
import type { MoneyCell } from './money.ts'
import type { LegacyReceiptStatus, LegacyReceiptSummary } from './receipt-status.ts'

/** A program, as the selector shows it. */
export interface ProgramOption {
  id: string
  name: string
  shortCode: string
}

/** A batch, as the selector shows it. */
export interface BatchOption {
  id: string
  programId: string
  programShortCode: string
  name: string
  /** Null for the six batches whose title never stated a full date. */
  startDate: string | null
  /** Students with a finance record in this batch. */
  studentCount: number
}

/**
 * One scheduled installment column, from normalized `installments`.
 *
 * Never derived from the ACTUAL section: a scheduled figure and a payment of
 * the same name are different facts, and the import kept them apart on purpose.
 */
export interface ScheduledColumn {
  key: string
  /** `legacy_column_name` as the workbook spelled it, else the default note. */
  label: string
  /** Source order within the batch's INSTALLMENT FEE STRUCTURE section. */
  sequence: number
}

/** One imported transaction, as the details drawer shows it. */
export interface PaymentEntry {
  id: string
  /** `YYYY-MM-DD`, or null where the workbook's date could not be read. */
  date: string | null
  amount: MoneyCell
  /** Exactly as the workbook spells it. Never normalised. */
  method: string | null
  /** The workbook's own `Receipt Sent` text, or null. Never a receipt. */
  legacyReceiptSent: string | null
  /** Staff remarks carried over by the import. */
  note: string | null
  /** Payments are voided, never deleted, so a voided one is still shown. */
  voided: boolean
}

/** Why a row carries the subtle legacy indicator. Generic, never accusatory. */
export type LegacyFlag =
  | 'no_student_number'
  | 'error_cell'
  | 'balance_not_recorded'
  | 'fee_or_paid_not_recorded'
  | 'balance_differs_from_batch_convention'

export interface FinanceGridRow {
  financeRecordId: string
  studentId: string
  /** Null for the unresolved historical students. Never manufactured. */
  studentNumber: string | null
  studentName: string
  programShortCode: string
  batchName: string | null

  /** Snapshot fields, exactly as imported. Never recomputed. */
  legacyTotalFee: MoneyCell
  legacyTotalPaid: MoneyCell
  legacyBalance: MoneyCell

  /** Historical ACTUAL-section cells, keyed by `LegacyColumn.key`. */
  actualCells: Record<string, MoneyCell>
  /** Normalized scheduled amounts, keyed by `ScheduledColumn.key`. */
  scheduledCells: Record<string, MoneyCell>

  payments: PaymentEntry[]
  paymentCount: number
  /** Sum of the imported payments. Labelled as such; never the batch snapshot. */
  paymentTotal: MoneyCell
  lastPaymentDate: string | null

  receiptStatus: LegacyReceiptStatus
  receiptSummary: LegacyReceiptSummary

  balanceState: BalanceState
  legacyFlags: LegacyFlag[]
}

/** Batch-level historical totals, summed only from this batch's snapshots. */
export interface SummaryTotals {
  students: number
  totalFees: MoneyCell
  totalPaid: MoneyCell
  balance: MoneyCell
  /** Students whose fee figure was never recorded, and so are not in the sum. */
  feesMissing: number
  paidMissing: number
  balanceMissing: number
}

/** Everything one render of `/finance` needs. */
export interface FinanceGridView {
  programs: ProgramOption[]
  batches: BatchOption[]
  selectedProgram: ProgramOption | null
  selectedBatch: BatchOption | null
  /** True when the view is the deliberately unassigned records, not a batch. */
  unassigned: boolean
  /**
   * Finance records in the selected program that the import left with no batch.
   *
   * These are real records holding real payments — the import refused to guess
   * which of two batch tables a student's money belonged to. Offering them as a
   * selectable view is the only thing that keeps them visible to staff; the
   * alternative is 22 records that exist and can never be reached.
   */
  unassignedCount: number
  /** How the default batch was reached, shown to staff and logged. */
  batchSelectionNote: string

  columns: LegacyColumn[]
  scheduledColumns: ScheduledColumn[]
  rows: FinanceGridRow[]
  totals: SummaryTotals
  balanceConvention: BalanceConventionResult

  /** True when a query hit its row cap and the view may be incomplete. */
  truncated: boolean
}
