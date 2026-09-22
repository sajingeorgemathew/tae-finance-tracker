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
 *
 * Since FINANCE-GRID-03C the unit a staff member selects is an *intake* — a
 * UI-level grouping of a Morning and an Evening batch (`intake.ts`). The rows
 * of a combined intake still carry the real `batchId` they belong to, because
 * the batches are still two real database entities and every future write
 * workflow will need to know which one a row is in.
 */

import type { BalanceConventionResult, BalanceState } from './balance.ts'
import type { FinanceIntake, IntakeBatch, Session } from './intake.ts'
import type { MoneyCell } from './money.ts'
import type { PaymentStatus, PaymentStatusCounts } from './payment-status.ts'
import type { LegacyReceiptStatus, LegacyReceiptSummary } from './receipt-status.ts'

/** A program, as the selector shows it. */
export interface ProgramOption {
  id: string
  name: string
  shortCode: string
}

/** A batch, as the loader reads it and the intake selector groups it. */
export type BatchOption = IntakeBatch

/** The two finance groups of the grid, as `batch_finance_columns.section` names them. */
export type FinanceColumnSection = 'actual' | 'installment'

/**
 * Semantic role of a column. Metadata only — the label is always the source
 * heading, verbatim, and is never rewritten from the role. `other` is a
 * legitimate value: an unheaded reconciliation column, or a heading such as
 * "Marc" the import did not recognise and this screen will not guess at.
 */
export type FinanceColumnRole =
  | 'student_number'
  | 'student_name'
  | 'enrollment'
  | 'month'
  | 'late_fees'
  | 'total_fee'
  | 'total_paid'
  | 'balance'
  | 'discount'
  | 'installment'
  | 'remarks'
  | 'payer'
  | 'other'

/** How a cell in the column is read. Text is never formatted as currency. */
export type FinanceColumnValueKind = 'money' | 'text'

/**
 * One finance column of the grid — the browser-safe view of a
 * `batch_finance_columns` row, or of a column derived from row data where a
 * batch has no manifest.
 *
 * Column *existence*, order, label, section and kind come from here. The
 * *value* in any cell comes from the student's own record or installment, and
 * a column with no value for a student renders blank, never `$0.00`.
 *
 * Deliberately not here: the source column letter, the workbook hash, the
 * sheet name and table key, and the visibility flags. The builder uses them
 * and drops them; they are not the browser's business.
 */
export interface FinanceColumn {
  /** Stable key for React and for the per-row cell map, e.g. `actual:G`. */
  key: string
  /** The source heading, trimmed. `Column Q` when the workbook never headed it. */
  label: string
  section: FinanceColumnSection
  role: FinanceColumnRole
  valueKind: FinanceColumnValueKind
  /** Position within the section. For installment columns, the sequence number. */
  order: number
  /** True when the workbook never headed this column. */
  unheaded: boolean
  /**
   * `manifest` when the column comes from `batch_finance_columns`; `derived`
   * when it was rebuilt from row data because no manifest row described it.
   */
  origin: 'manifest' | 'derived'
  /**
   * In a combined intake, which sessions' batches have this column. A row
   * from a batch that lacks it renders blank there — the workbook had no such
   * cell for that student, and "no cell" is not `$0.00`. Empty for a
   * single-batch or unsessioned view.
   */
  sessions: Session[]
  /**
   * In a combined intake, the verbatim headings the *other* cohort's table
   * gives the same source position — "Marc" beside "Mar". Both columns are
   * kept, unrenamed, and this is what lets the heading say why two similar
   * columns sit side by side. Empty for every other column.
   */
  conflictingHeadings: string[]
}

/**
 * Where the displayed column layout came from.
 *
 * `manifest` — the batch's `batch_finance_columns` rows, which is every
 * imported batch. `derived` — the union of cells across the rows, which is
 * the fallback for a batch with no manifest and for the unassigned view, and
 * which cannot show a column every student left blank. `none` — no columns.
 */
export type LayoutSource = 'manifest' | 'derived' | 'none'

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
  /** The real batch this record belongs to. Null only for the unassigned records. */
  batchId: string | null
  batchName: string | null
  /** The cohort the underlying batch's name states. Null for ECEA and unassigned. */
  session: Session | null

  /** Snapshot fields, exactly as imported. Never recomputed. */
  legacyTotalFee: MoneyCell
  legacyTotalPaid: MoneyCell
  legacyBalance: MoneyCell

  /** Historical ACTUAL-section cells, keyed by `FinanceColumn.key`. */
  actualCells: Record<string, MoneyCell>
  /** Normalized scheduled amounts, keyed by `FinanceColumn.key`. */
  scheduledCells: Record<string, MoneyCell>

  payments: PaymentEntry[]
  paymentCount: number
  /** Sum of the imported payments. Labelled as such; never the batch snapshot. */
  paymentTotal: MoneyCell
  lastPaymentDate: string | null

  receiptStatus: LegacyReceiptStatus
  receiptSummary: LegacyReceiptSummary

  balanceState: BalanceState
  /**
   * The operational status the badge shows and the quick filter reads. Derived
   * once, from `legacyBalance` under the batch's verified convention — see
   * `payment-status.ts`. Never from payments, never from `fee − paid`.
   */
  paymentStatus: PaymentStatus
  legacyFlags: LegacyFlag[]
}

/** Intake-level historical totals, summed only from the underlying batches' snapshots. */
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

/**
 * One underlying batch's balance convention, as GRID-03 verifies it.
 *
 * A combined intake carries one of these per real batch, because a sheet's
 * convention is verified per table and one table's result says nothing about
 * the other's.
 */
export interface BatchConventionSummary {
  batchId: string
  batchName: string
  session: Session | null
  students: number
  result: BalanceConventionResult
}

/** Everything one render of `/finance` needs. */
export interface FinanceGridView {
  programs: ProgramOption[]
  /** The selected program's intakes, most recent first. */
  intakes: FinanceIntake[]
  /** The selected program's batches — the real rows the intakes are built over. */
  batches: BatchOption[]
  selectedProgram: ProgramOption | null
  selectedIntake: FinanceIntake | null
  /** True when the view is the deliberately unassigned records, not an intake. */
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
  /** How the default intake was reached, shown to staff and logged. */
  selectionNote: string
  /**
   * Set when the request used an old `?batch=<uuid>` link. The page redirects
   * to the intake that now shows that batch, narrowed to its session, so the
   * old link lands on exactly the rows it used to.
   */
  legacyBatchRedirect: { intakeKey: string; session: Session | null } | null

  /** The ACTUAL group, in display order. Only grid-visible columns. */
  columns: FinanceColumn[]
  /** The INSTALLMENT group, in sequence order. Only grid-visible columns. */
  scheduledColumns: FinanceColumn[]
  layoutSource: LayoutSource
  /**
   * Columns the layout lists that no student in this view has a value in.
   * They are shown blank — the workbook showed them blank — and this count is
   * what lets the summary strip say so, once, instead of a marker per cell.
   */
  blankStructuralColumns: number
  rows: FinanceGridRow[]
  totals: SummaryTotals
  /** The intake-level reading of the conventions below. */
  balanceConvention: BalanceConventionResult
  /** One entry per underlying batch. */
  batchConventions: BatchConventionSummary[]
  statusCounts: PaymentStatusCounts
  sessionCounts: Record<Session, number>

  /** True when a query hit its row cap and the view may be incomplete. */
  truncated: boolean
}
