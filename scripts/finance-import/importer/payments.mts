/**
 * Payments — Tracker Master, and only Tracker Master.
 *
 * The batch sheets also record money received, in their ACTUAL section. Those
 * cells are almost certainly another view of the same historical money, so
 * importing both would count it twice. Tracker Master is the transaction source;
 * the batch-sheet actual cells are preserved inside each finance record's
 * legacy_raw_json instead, where a later legacy-spreadsheet view can render them
 * without any of it being money in its own right.
 *
 * ## Routing
 *
 * `payments.student_finance_record_id` is NOT NULL, so every payment needs a
 * record. A payment is tied to a *batch* record only when the evidence is
 * unambiguous: the student appears in exactly one supported batch table for
 * that program. Two tables, or none, and it goes to an unassigned record with
 * `batch_id` null. Tracker Master's own Batch column is a date serial, and a
 * date cannot tell the Morning cohort from the Evening one, so it is never used
 * to decide — only preserved.
 *
 * ## What is not done here
 *
 * No payment method is normalised, no duplicate is removed, no balance is
 * recalculated, and no receipt is created from a "Receipt Sent" flag.
 */

import { interpretDateCell } from '../lib/excel-values.mts'
import { normalizeHeader } from '../lib/headers.mts'
import { paymentSourceKey } from './source-keys.mts'

import type { SourceCell, SourceColumn, SourceRow, SourceTable } from './source-tables.mts'

/**
 * Tracker Master columns, resolved by exact heading rather than by role.
 *
 * Two columns share the `remarks` role and must stay distinguishable, and
 * "Enrollment Total Fees" and "Balance Fees" would otherwise collide with
 * headings used on the batch sheets.
 */
export interface TrackerColumns {
  paymentNumber: SourceColumn | null
  batch: SourceColumn | null
  studentId: SourceColumn | null
  studentName: SourceColumn | null
  amount: SourceColumn | null
  paidDate: SourceColumn | null
  paymentMethod: SourceColumn | null
  receiptSent: SourceColumn | null
  enrollmentTotalFee: SourceColumn | null
  program: SourceColumn | null
  remarks: SourceColumn | null
  vikasRemarks: SourceColumn | null
  balance: SourceColumn | null
}

export function resolveTrackerColumns(table: SourceTable): TrackerColumns {
  const find = (normalized: string): SourceColumn | null =>
    table.columns.find(
      (column) => column.header !== null && normalizeHeader(column.header) === normalized,
    ) ?? null

  return {
    paymentNumber: find('payment no'),
    batch: find('batch'),
    studentId: find('student id'),
    studentName: find('student name'),
    amount: find('amount paid'),
    paidDate: find('paid date'),
    paymentMethod: find('mode of payment'),
    receiptSent: find('receipt sent'),
    enrollmentTotalFee: find('enrollment total fees'),
    program: find('program'),
    remarks: find('remarks'),
    vikasRemarks: find('vikas remarks'),
    balance: find('balance fees'),
  }
}

/** Text exactly as the workbook shows it, without trimming or case folding. */
function cellText(cell: SourceCell | undefined): string | null {
  if (!cell || cell.isBlank) return null
  if (cell.isError) return cell.text ?? null
  if (typeof cell.rawValue === 'string') return cell.rawValue
  if (cell.text !== null && cell.text.trim() !== '') return cell.text
  return cell.rawValue === null ? null : String(cell.rawValue)
}

/** How a payment was tied — or failed to be tied — to a finance record. */
export type RoutingOutcome =
  /** The student appears in exactly one supported batch table for this program. */
  | 'unique_batch'
  /** More than one candidate. Not guessed: routed to the unassigned record. */
  | 'ambiguous_batch'
  /** No supported batch table holds this student for this program. */
  | 'batch_not_found'
  /** The row carries no student number at all. */
  | 'missing_student_id'

/** Why a payment cannot be planned at all. Reported, never silently dropped. */
export type UnresolvedReason =
  | 'unresolved_program'
  | 'missing_amount'
  | 'deferred_program_configuration'

export interface PlannedPayment {
  sourceKey: string
  /**
   * The record the payment attaches to, or null when none could be resolved.
   *
   * Set even for a row that plans no payment, where the record itself is still
   * planned — a Tracker Master row with no amount still tells us the student
   * exists and belongs to a program, so the student and the finance record are
   * created and only the payment becomes an exception.
   */
  financeRecordSourceKey: string | null
  /** True when this row will be inserted into `payments`. */
  plansPayment: boolean
  studentSourceKey: string | null
  studentNumber: string | null
  /** Canonical program short code, or null when it could not be resolved. */
  programShortCode: string | null
  /** The workbook's own program label, preserved exactly. */
  sourceProgramLabel: string | null
  /** True when the program was inferred from the student's batch tables. */
  programInferred: boolean
  amount: number | null
  paymentDate: string | null
  /** Exact historical spelling. Never normalised to a code list. */
  paymentMethod: string | null
  payerName: string | null
  reference: string | null
  note: string | null
  source: 'legacy_import'
  legacySourceSheet: string
  legacySourceRow: number
  legacyRawJson: Record<string, unknown>
  routing: RoutingOutcome
  routingNote: string
  /** Set when the payment plans no insert. */
  unresolved: UnresolvedReason | null
  unresolvedNote: string | null
}

/** A batch-specific finance record a payment could be routed to. */
export interface RoutingCandidate {
  financeRecordSourceKey: string
  batchSourceKey: string
  programShortCode: string
  sheetName: string
  tableKey: string
}

export interface PaymentPlanInput {
  workbookHash: string
  table: SourceTable
  columns: TrackerColumns
  date1904: boolean
  /** Batch-specific finance records for a student, by exact student number. */
  candidatesFor: (studentNumber: string) => RoutingCandidate[]
  /** Canonical program for a workbook label, or null when it does not map. */
  resolveProgram: (label: string | null) => {
    shortCode: string | null
    sourceLabel: string | null
    deferred: boolean
  }
  /** Planned student source key for an exact student number. */
  studentKeyFor: (studentNumber: string) => string | null
  /** Planned unresolved student source key for a number-less row. */
  unresolvedStudentKeyFor: (row: number) => string | null
  /**
   * Resolves (or creates) the unassigned record for a student and program.
   * Called only when a payment cannot be tied to exactly one batch record.
   */
  unassignedRecordFor: (
    studentSourceKey: string,
    studentNumber: string | null,
    programShortCode: string,
    reason: string,
  ) => string
}

export interface PaymentPlanResult {
  payments: PlannedPayment[]
  counts: {
    total: number
    uniqueBatch: number
    ambiguousBatch: number
    batchNotFound: number
    missingStudentId: number
    unresolvedProgram: number
    missingAmount: number
    programInferred: number
  }
  /**
   * Groups of rows sharing student number, amount and paid date. Every row is
   * kept; the groups are reported so the candidates stay visible.
   */
  preservedDuplicateCandidates: { signature: string; rows: number[] }[]
}

/**
 * Reads the program for one transaction row.
 *
 * A blank Program cell is not filled in from the student's name or from their
 * student-number prefix. It is filled in only when the student's own supported
 * batch tables agree on exactly one program, and that inference is recorded on
 * the payment so it can be reviewed. Anything else stays unresolved.
 */
function resolveRowProgram(
  label: string | null,
  candidates: readonly RoutingCandidate[],
  resolveProgram: PaymentPlanInput['resolveProgram'],
): {
  shortCode: string | null
  sourceLabel: string | null
  inferred: boolean
  deferred: boolean
  note: string
} {
  const resolved = resolveProgram(label)

  if (resolved.deferred) {
    return {
      shortCode: null,
      sourceLabel: resolved.sourceLabel,
      inferred: false,
      deferred: true,
      note: 'program is deferred in this phase',
    }
  }

  if (resolved.shortCode !== null) {
    return {
      shortCode: resolved.shortCode,
      sourceLabel: resolved.sourceLabel,
      inferred: false,
      deferred: false,
      note: `program stated by the row as ${JSON.stringify(resolved.sourceLabel)}`,
    }
  }

  if (label !== null && label.trim() !== '') {
    return {
      shortCode: null,
      sourceLabel: label,
      inferred: false,
      deferred: false,
      note: `program label ${JSON.stringify(label)} matches no configured program`,
    }
  }

  const programs = [...new Set(candidates.map((candidate) => candidate.programShortCode))]
  if (programs.length === 1) {
    return {
      shortCode: programs[0],
      sourceLabel: null,
      inferred: true,
      deferred: false,
      note: `program blank in the source; inferred as ${programs[0]} from the student's only batch program`,
    }
  }

  return {
    shortCode: null,
    sourceLabel: null,
    inferred: false,
    deferred: false,
    note:
      programs.length === 0
        ? 'program blank in the source and the student appears in no supported batch table'
        : `program blank in the source and the student appears under ${programs.length} programs`,
  }
}

/**
 * Plans one payment per Tracker Master transaction row.
 *
 * Every row produces a `PlannedPayment`, including the rows that cannot be
 * inserted: those carry `unresolved` and plan no insert, which is what keeps the
 * accounting complete. Nothing is dropped on the way through.
 */
export function planPayments(input: PaymentPlanInput): PaymentPlanResult {
  const { workbookHash, table, columns, date1904 } = input

  const payments: PlannedPayment[] = []
  const duplicateKeys = new Map<string, number[]>()

  const counts = {
    total: 0,
    uniqueBatch: 0,
    ambiguousBatch: 0,
    batchNotFound: 0,
    missingStudentId: 0,
    unresolvedProgram: 0,
    missingAmount: 0,
    programInferred: 0,
  }

  const at = (row: SourceRow, column: SourceColumn | null): SourceCell | undefined =>
    column === null ? undefined : row.cellByColumn.get(column.column)

  for (const row of table.rows) {
    // A row where every cell is blank is not a transaction. The workbook has
    // none, but a trailing blank must never become a payment of zero.
    if (row.cells.every((cell) => cell.isBlank)) continue

    counts.total += 1

    const studentNumber = row.studentNumber
    const candidates = studentNumber === null ? [] : input.candidatesFor(studentNumber)

    const programCell = at(row, columns.program)
    const program = resolveRowProgram(cellText(programCell), candidates, input.resolveProgram)
    if (program.inferred) counts.programInferred += 1

    const amountCell = at(row, columns.amount)
    const amount = amountCell && !amountCell.isBlank ? amountCell.numeric : null

    const paidDateCell = at(row, columns.paidDate)
    const paidDate = interpretDateCell(
      paidDateCell === undefined
        ? null
        : {
            ref: paidDateCell.ref,
            type: paidDateCell.cellType as never,
            value: paidDateCell.rawValue as never,
          },
      date1904,
    )

    const batchCell = at(row, columns.batch)
    const balanceCell = at(row, columns.balance)
    const feeCell = at(row, columns.enrollmentTotalFee)
    const receiptSent = cellText(at(row, columns.receiptSent))
    const remarks = cellText(at(row, columns.remarks))
    const vikasRemarks = cellText(at(row, columns.vikasRemarks))
    const paymentMethod = cellText(at(row, columns.paymentMethod))
    const paymentNumber = cellText(at(row, columns.paymentNumber))

    // --- Routing ------------------------------------------------------------
    const inProgram =
      program.shortCode === null
        ? []
        : candidates.filter((candidate) => candidate.programShortCode === program.shortCode)

    let routing: RoutingOutcome
    let routingNote: string

    if (studentNumber === null) {
      routing = 'missing_student_id'
      routingNote = 'the row states no student number; no name matching is performed'
    } else if (inProgram.length === 1) {
      routing = 'unique_batch'
      routingNote = `student appears in exactly one supported ${program.shortCode} batch table (${inProgram[0].sheetName})`
    } else if (inProgram.length > 1) {
      routing = 'ambiguous_batch'
      routingNote =
        `student appears in ${inProgram.length} supported ${program.shortCode} batch records; ` +
        'not guessed, routed to the unassigned record'
    } else {
      routing = 'batch_not_found'
      routingNote = `student appears in no supported ${program.shortCode ?? 'canonical'} batch table`
    }

    // --- Can this row be planned at all? ------------------------------------
    let unresolved: UnresolvedReason | null = null
    let unresolvedNote: string | null = null

    if (program.deferred) {
      unresolved = 'deferred_program_configuration'
      unresolvedNote = program.note
    } else if (program.shortCode === null) {
      unresolved = 'unresolved_program'
      unresolvedNote = program.note
    } else if (amount === null) {
      unresolved = 'missing_amount'
      unresolvedNote =
        'payments.amount is NOT NULL and the source states no amount; no value is invented'
    }

    if (unresolved === 'unresolved_program' || unresolved === 'deferred_program_configuration') {
      counts.unresolvedProgram += 1
    }
    if (unresolved === 'missing_amount') counts.missingAmount += 1

    if (routing === 'unique_batch') counts.uniqueBatch += 1
    else if (routing === 'ambiguous_batch') counts.ambiguousBatch += 1
    else if (routing === 'batch_not_found') counts.batchNotFound += 1
    else counts.missingStudentId += 1

    // --- Which record does it attach to? ------------------------------------
    // Resolved whenever a student and a program are known, including for a row
    // that will not become a payment. A row with no amount still establishes
    // that the student exists and which program they are in, so the student and
    // the finance record are planned and only the payment becomes an exception.
    // A row with no resolvable program cannot: student_finance_records.
    // program_id is NOT NULL and no program may be guessed.
    const studentSourceKey =
      studentNumber === null
        ? input.unresolvedStudentKeyFor(row.row)
        : input.studentKeyFor(studentNumber)

    const canResolveRecord =
      studentSourceKey !== null &&
      program.shortCode !== null &&
      unresolved !== 'unresolved_program' &&
      unresolved !== 'deferred_program_configuration'

    let financeRecordSourceKey: string | null = null
    if (canResolveRecord) {
      financeRecordSourceKey =
        routing === 'unique_batch'
          ? inProgram[0].financeRecordSourceKey
          : input.unassignedRecordFor(
              studentSourceKey as string,
              studentNumber,
              program.shortCode as string,
              routing,
            )
    }

    const sourceKey = paymentSourceKey(workbookHash, table.sheetName, row.row)

    const notes = [
      remarks === null ? null : `REMARKS: ${remarks}`,
      vikasRemarks === null ? null : `VIKAS REMARKS: ${vikasRemarks}`,
    ].filter((entry): entry is string => entry !== null)

    payments.push({
      sourceKey,
      financeRecordSourceKey,
      plansPayment: unresolved === null,
      studentSourceKey,
      studentNumber,
      programShortCode: program.shortCode,
      sourceProgramLabel: program.sourceLabel,
      programInferred: program.inferred,
      amount,
      paymentDate: paidDate.iso,
      paymentMethod,
      // Tracker Master has no payer column. Left null rather than filled with
      // the student's name, which would assert something the source never said.
      payerName: null,
      reference: paymentNumber,
      note: notes.length === 0 ? null : notes.join('\n'),
      source: 'legacy_import',
      legacySourceSheet: table.sheetName,
      legacySourceRow: row.row,
      legacyRawJson: {
        source_key: sourceKey,
        sheet: table.sheetName,
        row: row.row,
        payment_no: paymentNumber,
        batch: {
          raw_value: batchCell?.rawValue ?? null,
          formatted_text: batchCell?.text ?? null,
          note: 'a date serial, not a batch name; never used to choose Morning or Evening',
        },
        student_id: {
          raw_value: at(row, columns.studentId)?.rawValue ?? null,
          formatted_text: at(row, columns.studentId)?.text ?? null,
          cell_type: at(row, columns.studentId)?.cellType ?? null,
        },
        student_name: cellText(at(row, columns.studentName)),
        amount_paid: {
          raw_value: amountCell?.rawValue ?? null,
          formula: amountCell?.formula ?? null,
        },
        paid_date: { raw_serial: paidDate.raw, parsed_iso: paidDate.iso, status: paidDate.status },
        mode_of_payment: paymentMethod,
        receipt_sent: receiptSent,
        program: program.sourceLabel,
        program_resolution: program.note,
        remarks,
        vikas_remarks: vikasRemarks,
        enrollment_total_fees: {
          raw_value: feeCell?.rawValue ?? null,
          note: 'per-student figure stated once; never copied onto other payments',
        },
        balance_fees: {
          raw_value: balanceCell?.rawValue ?? null,
          formatted_text: balanceCell?.text ?? null,
          formula: balanceCell?.formula ?? null,
          note: 'row-local formula, not a student balance; preserved, never recalculated, never mapped to legacy_balance',
        },
        legacy_receipt_status: {
          value: receiptSent,
          note: 'historical metadata only; no receipt, receipt number, PDF or delivery is created from it',
        },
        routing: { outcome: routing, note: routingNote },
      },
      routing,
      routingNote,
      unresolved,
      unresolvedNote,
    })

    // Duplicate candidates: student number + amount + paid date, exactly as the
    // analysis defined them. Recorded, never acted on.
    if (studentNumber !== null && amount !== null) {
      const signature = [studentNumber, String(amount), String(paidDate.raw ?? '')].join('\u0000')
      duplicateKeys.set(signature, [...(duplicateKeys.get(signature) ?? []), row.row])
    }
  }

  const preservedDuplicateCandidates = [...duplicateKeys.entries()]
    .filter(([, rows]) => rows.length > 1)
    .map(([signature, rows]) => ({ signature, rows }))
    .sort((a, b) => a.rows[0] - b.rows[0])

  return { payments, counts, preservedDuplicateCandidates }
}
