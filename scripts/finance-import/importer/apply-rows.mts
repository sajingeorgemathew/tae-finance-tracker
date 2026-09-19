/**
 * The plan, turned into database rows.
 *
 * Pure: no client, no I/O, no clock. Given a `DryRunPlan` and the program IDs
 * read from the database, it returns exactly the rows the apply will insert,
 * with their deterministic primary keys and their foreign keys already
 * resolved. Keeping it separate from the writing means the mapping can be
 * tested without a database, and the writing has no mapping decisions left in
 * it to get wrong.
 *
 * Two rules the whole module obeys:
 *
 *   * **Nothing is computed.** Every value written comes from the plan, which
 *     took it from the workbook. No balance is recalculated, no blank is filled
 *     with a zero, no payment method string is normalized, no date is inferred.
 *     `null` in, `null` out.
 *
 *   * **Every ID is derived.** Primary keys and foreign keys alike come from
 *     `entityId(sourceKey)`, so the whole graph is built here, in memory,
 *     before anything is sent.
 */

import { entityId } from './deterministic-ids.mts'

import type { DryRunPlan } from './plan.mts'
import type { PlannedStudent } from './students.mts'

/** Program short code -> `programs.id`, read from the database. */
export type ProgramIds = ReadonlyMap<string, string>

export class PlanMappingError extends Error {}

function programId(programs: ProgramIds, shortCode: string): string {
  const id = programs.get(shortCode)
  if (id === undefined) {
    throw new PlanMappingError(
      `no program row for short code ${shortCode}; the apply will not create one`,
    )
  }
  return id
}

export interface ApplyRows {
  batches: Record<string, unknown>[]
  students: Record<string, unknown>[]
  financeRecords: Record<string, unknown>[]
  installments: Record<string, unknown>[]
  payments: Record<string, unknown>[]
  importExceptions: Record<string, unknown>[]
}

/**
 * One student row.
 *
 * `student_number` is whatever the plan holds — `null` for the seven unresolved
 * students, and never manufactured. `legacy_name` is the source spelling
 * verbatim; the alternate spellings that lost the display-name tie-break
 * survive in `legacy_raw_json`, which is the only place they exist.
 */
function studentRow(student: PlannedStudent): Record<string, unknown> {
  return {
    id: entityId(student.sourceKey),
    student_number: student.studentNumber,
    first_name: student.firstName,
    middle_name: student.middleName,
    last_name: student.lastName,
    display_name: student.legacyDisplayName,
    legacy_name: student.legacyDisplayName,
    legacy_source: student.legacySource,
    legacy_raw_json: student.legacyRawJson,
  }
}

/**
 * Builds every row class from the plan.
 *
 * `importBatchId` is stamped onto the import exceptions so a row preserved
 * instead of normalized is attributable to the run that preserved it.
 */
export function buildApplyRows(
  plan: DryRunPlan,
  programs: ProgramIds,
  importBatchId: string,
): ApplyRows {
  const batches = plan.batches.map((batch) => ({
    id: entityId(batch.sourceKey),
    program_id: programId(programs, batch.programShortCode),
    name: batch.name,
    code: batch.code,
    // Only where Phase B1 read a real date off the title. Never inferred.
    start_date: batch.startDate,
    legacy_sheet_name: batch.legacySheetName,
  }))

  // The numbered students and the seven unresolved ones are one table. They are
  // separate lists in the plan precisely so unresolved rows can never be merged
  // into a numbered student by name; here they are simply both inserted.
  const students = [...plan.students, ...plan.unresolvedStudents].map(studentRow)

  const financeRecords = plan.financeRecords.map((record) => ({
    id: entityId(record.sourceKey),
    student_id: entityId(record.studentSourceKey),
    program_id: programId(programs, record.programShortCode),
    // null for the 22 approved unassigned records. Not a failure: the student
    // could not be tied to exactly one batch table, and guessing is worse.
    batch_id: record.batchSourceKey === null ? null : entityId(record.batchSourceKey),
    legacy_total_fee: record.legacyTotalFee.value,
    legacy_total_paid: record.legacyTotalPaid.value,
    legacy_balance: record.legacyBalance.value,
    legacy_source_sheet: record.legacySourceSheet,
    legacy_source_row: record.legacySourceRow,
    legacy_raw_json: record.legacyRawJson,
  }))

  const installments = plan.installments.map((installment) => ({
    id: entityId(installment.sourceKey),
    student_finance_record_id: entityId(installment.financeRecordSourceKey),
    sequence_number: installment.sequenceNumber,
    installment_type: installment.installmentType,
    // The PSW schedule names ordinal installments, not calendar months, so
    // there is no month and no due date to state. Absent, not zero, not guessed.
    installment_month: installment.installmentMonth,
    scheduled_amount: installment.scheduledAmount,
    default_note: installment.defaultNote,
    legacy_column_name: installment.legacyColumnName,
    legacy_value_text: installment.legacyValueText,
    legacy_raw_json: installment.legacyRawJson,
  }))

  // Only the rows the plan marks as producing a payment. The one row without an
  // amount is not here; it is an import exception, below.
  const payments = plan.payments
    .filter((payment) => payment.plansPayment)
    .map((payment) => {
      if (payment.financeRecordSourceKey === null) {
        throw new PlanMappingError(
          `a planned payment has no finance record to attach to (${payment.legacySourceSheet} row ${payment.legacySourceRow})`,
        )
      }
      return {
        id: entityId(payment.sourceKey),
        student_finance_record_id: entityId(payment.financeRecordSourceKey),
        amount: payment.amount,
        payment_date: payment.paymentDate,
        // Historical spelling, exactly as the workbook has it. Never normalized.
        payment_method: payment.paymentMethod,
        payer_name: payment.payerName,
        reference: payment.reference,
        note: payment.note,
        source: 'legacy_import',
        legacy_source_sheet: payment.legacySourceSheet,
        legacy_source_row: payment.legacySourceRow,
        legacy_raw_json: payment.legacyRawJson,
      }
    })

  const importExceptions = plan.importExceptions.map((exception) => ({
    id: entityId(exception.sourceKey),
    import_batch_id: importBatchId,
    source_filename: exception.sourceFilename,
    source_sheet: exception.sourceSheet,
    source_row: exception.sourceRow,
    source_column: exception.sourceColumn,
    entity_type: exception.entityType,
    reason: exception.reason,
    source_key: exception.sourceKey,
    legacy_raw_json: exception.legacyRawJson,
  }))

  return { batches, students, financeRecords, installments, payments, importExceptions }
}

/** Every `id` in a row class, in insertion order. */
export function idsOf(rows: readonly Record<string, unknown>[]): string[] {
  return rows.map((row) => String(row.id))
}

/**
 * Duplicate ids within one row class.
 *
 * A duplicate would mean two source entities derived the same key, which is an
 * identity bug rather than a transport problem: the upsert would silently keep
 * one and drop the other, and the count check would then fail with no
 * explanation. Detecting it here names the cause.
 */
export function findDuplicateIds(rows: readonly Record<string, unknown>[]): string[] {
  const seen = new Set<string>()
  const duplicates = new Set<string>()
  for (const row of rows) {
    const id = String(row.id)
    if (seen.has(id)) duplicates.add(id)
    seen.add(id)
  }
  return [...duplicates]
}
