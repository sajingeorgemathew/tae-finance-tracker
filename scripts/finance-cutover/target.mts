/**
 * The proposed operational dataset after the cutover.
 *
 *   March 2026 (hosted, preserved by id, unchanged)
 *   + April / June / August / September 2026 PSW, ECEA, French (workbook)
 *
 * Built deterministically from three inputs only — the parsed workbook, the
 * private hosted backup and the cutover config — so the same inputs always
 * give the same dataset and the same hash.
 *
 * Rules that shape it:
 *
 *  * **March is preserved, not rebuilt.** Its batches, finance records,
 *    installments, payments, column layout and students keep their hosted ids
 *    and every value. Nothing about March is recalculated from any source.
 *  * **One person per exact student number.** A workbook row whose number
 *    matches exactly one hosted student re-uses that student's row and id
 *    (names and contacts untouched). No match by name, email or phone, ever.
 *    A number-less row gets its own student, keyed on its exact source row.
 *    A number held by two hosted students stops the plan.
 *  * **Workbook cohorts are rebuilt from the workbook.** New batch, finance
 *    record, installment and column-layout rows carry deterministic v5 ids
 *    over the new workbook's hash, exactly as FINANCE-IMPORT-02 keyed its own.
 *  * **Payments come from the ACTUAL money cells.** The replacement workbook
 *    has no Tracker Master, so the per-month cells a row's own Total Paid sums
 *    are the only record of money received. Each non-blank cell becomes one
 *    payment with no date and no method — the workbook states neither — and
 *    the cell itself in `legacy_raw_json`. Nothing is double counted: there
 *    is no second payment source in this workbook.
 *  * **Nothing is manufactured.** Blank stays null, an installment month
 *    stays null (no year is stated), French's receipt configuration stays
 *    null, and a sensitive column (a date of birth) is left out of
 *    provenance by name.
 */

import { createHash } from 'node:crypto'

import { entityId } from '../finance-import/importer/deterministic-ids.mts'
import { planBatchFinanceRecords } from '../finance-import/importer/finance-records.mts'
import { planInstallments } from '../finance-import/importer/installments.mts'
import { planTableManifest } from '../finance-import/importer/column-manifest.mts'
import {
  batchSourceKey,
  importExceptionSourceKey,
  sourceKey,
  studentSourceKey,
  unresolvedStudentSourceKey,
} from '../finance-import/importer/source-keys.mts'
import { planStudents, type PlannedStudent, type StudentObservation } from '../finance-import/importer/students.mts'
import type { SourceRow, SourceTable } from '../finance-import/importer/source-tables.mts'
import { nameComparisonForm } from '../finance-import/lib/student-ids.mts'
import { canonicalJson } from '../finance-contact/apply-plan.mts'

import {
  FRENCH_PROGRAM,
  IMPORT_TYPE,
  SUPERSEDED_WORKBOOK_SHA256,
  TARGET_COHORTS,
  TICKET,
  type BackupTable,
  type CollectionMode,
  type TargetScope,
} from './config.mts'
import { cohortMonthOf, FLAT_MONEY_ROLES, studentRows, type ClassifiedRow, type ParsedTable, type ParsedWorkbook } from './parse.mts'

import type { BackupRow } from './hosted.mts'

export type Row = Record<string, unknown> & { id: string }

/** The tables a cutover inserts into, in dependency order. */
export const INSERT_TABLES = [
  'programs',
  'batches',
  'students',
  'student_finance_records',
  'installments',
  'payments',
  'batch_finance_columns',
  'import_batches',
  'import_exceptions',
] as const

export type InsertTable = (typeof INSERT_TABLES)[number]

export type StudentResolution =
  /** A March student, kept as hosted. */
  | 'hosted_march'
  /** A workbook row whose exact number matches one hosted student: that row is re-used. */
  | 'hosted_by_number'
  /** A numbered workbook student with no hosted match: a new row. */
  | 'new_numbered'
  /** A workbook row with no student number: a new row keyed on its source row. */
  | 'new_unnumbered'

export interface TargetRecordLink {
  financeRecordId: string
  studentId: string
  studentNumber: string | null
  cohortId: string
  programShortCode: string
  batchId: string
  origin: 'hosted' | 'workbook'
  sheet: string | null
  row: number | null
  named: boolean
  resolution: StudentResolution
  /** The approved collection strategy of the record's cohort. */
  collectionMode: CollectionMode
}

export interface TargetIssue {
  code: string
  blocking: boolean
  detail: string
  count: number
}

export interface TargetDataset {
  ticket: string
  workbook: { fileName: string; sha256: string }
  supersededWorkbookSha256: string
  /** Rows that exist on hosted and are kept exactly as they are, by id. */
  retained: Record<BackupTable, string[]>
  /** Rows the cutover inserts, as the exact column values to write. */
  inserts: Record<InsertTable, Row[]>
  cohorts: { id: string; label: string; source: 'hosted' | 'workbook'; programShortCode: string; batchIds: string[] }[]
  links: TargetRecordLink[]
  issues: TargetIssue[]
}

export interface BuildTargetInput {
  parsed: ParsedWorkbook
  workbook: { fileName: string; sha256: string }
  hosted: Record<BackupTable, BackupRow[]>
  /**
   * Optional narrowed launch scope. Absent: the full cutover (every cohort in
   * `TARGET_COHORTS`, everything else removed). Present: only the listed
   * cohorts are built from the workbook, the hosted batches of those same
   * cohorts (program + cohort month) are the only rows replaced, and every
   * other hosted row — students included — is retained by id.
   */
  scope?: TargetScope
}

/** Hosted batches that belong to a declared cohort: same program, same cohort month. */
export function hostedBatchesOfCohort(hosted: Record<BackupTable, BackupRow[]>, cohort: { programShortCode: string; yearMonth: string | null }): BackupRow[] {
  if (cohort.yearMonth === null) return []
  const programId = hosted.programs.find((program) => String(program.short_code) === cohort.programShortCode)?.id
  return hosted.batches.filter(
    (batch) => batch.program_id === programId && cohortMonthOf(String(batch.legacy_sheet_name ?? batch.name), null).yearMonth === cohort.yearMonth,
  )
}

/** The French program's id: stable across workbooks, so a later re-import finds the same row. */
export function frenchProgramId(): string {
  return entityId(sourceKey(TICKET, 'program', FRENCH_PROGRAM.shortCode))
}

/** A copy of the table holding only the rows the cutover classified as students. */
function studentOnlyTable(parsedTable: ParsedTable): SourceTable {
  const keep = new Set(studentRows(parsedTable).map((row) => row.row))
  return {
    ...parsedTable.table,
    rows: parsedTable.table.rows
      .filter((row) => keep.has(row.row))
      .map((row): SourceRow => ({ ...row, kind: 'student' })),
  }
}

function classifiedByRow(parsedTable: ParsedTable): Map<number, ClassifiedRow> {
  return new Map(parsedTable.rows.map((row) => [row.row, row]))
}

/** Columns whose cells are money received, by the table's own shape. */
export function paymentColumnsOf(table: SourceTable): SourceTable['columns'] {
  const split = table.columns.some((column) => column.section === 'actual' || column.section === 'installment')
  const receivedRoles = split ? new Set(['enrollment_fee', 'month', 'late_fees']) : new Set(['enrollment_fee', 'installment_ordinal', 'late_fees', 'month'])
  return table.columns.filter((column) => {
    if (column.header === null) return false
    if (split ? column.section !== 'actual' : column.section !== 'flat') return false
    return receivedRoles.has(column.role) && (split || FLAT_MONEY_ROLES.has(column.role))
  })
}

export interface PlannedCellPayment {
  row: Row
  /** Why a non-blank money cell did not become a payment, when it did not. */
  skipped: { sheet: string; row: number; letter: string; reason: string } | null
}

/**
 * One payment per non-blank money-received cell of one student row.
 *
 * A cell with no plain number (text, an error) or a number that is zero or
 * negative is not a receipt of money and is reported instead — never coerced.
 */
export function planCellPayments(
  workbookHash: string,
  parsedTable: ParsedTable,
  source: SourceRow,
  financeRecordId: string,
): PlannedCellPayment[] {
  const { table } = parsedTable
  const out: PlannedCellPayment[] = []
  for (const column of paymentColumnsOf(table)) {
    const cell = source.cellByColumn.get(column.column)
    if (!cell || cell.isBlank) continue
    const skip = (reason: string): void => {
      out.push({ row: { id: '' }, skipped: { sheet: table.sheetName, row: source.row, letter: cell.letter, reason } })
    }
    if (cell.isError) {
      skip(`cell holds ${cell.text ?? 'an error'}`)
      continue
    }
    if (cell.numeric === null) {
      skip('cell is not a plain number')
      continue
    }
    if (cell.numeric <= 0) {
      skip(`cell holds ${cell.numeric}, which is not money received`)
      continue
    }
    const key = sourceKey(workbookHash, 'payment-cell', table.sheetName, source.row, table.key, cell.letter)
    out.push({
      skipped: null,
      row: {
        id: entityId(key),
        student_finance_record_id: financeRecordId,
        installment_id: null,
        amount: cell.numeric,
        payment_date: null,
        payment_method: null,
        payer_name: null,
        reference: null,
        note: null,
        source: 'legacy_import',
        legacy_source_sheet: table.sheetName,
        legacy_source_row: source.row,
        legacy_raw_json: {
          source_key: key,
          ticket: TICKET,
          origin: 'actual_section_cell',
          sheet: table.sheetName,
          block_title: table.title,
          table_key: table.key,
          section: column.section,
          row: source.row,
          column: cell.letter,
          header: column.header,
          column_role: column.role,
          month_number: column.month,
          cell_type: cell.cellType,
          raw_value: cell.rawValue,
          formatted_text: cell.text,
          formula: cell.formula,
          payment_date_note:
            'the workbook states the column the money sits under, not the day it arrived; payment_date and payment_method are null',
        },
      },
    })
  }
  return out
}

function emptyRecord<K extends string>(keys: readonly K[]): Record<K, never[]> {
  return Object.fromEntries(keys.map((key) => [key, []])) as unknown as Record<K, never[]>
}

/** Builds the whole target. Throws only on a programming error; data problems become issues. */
export function buildTargetDataset(input: BuildTargetInput): TargetDataset {
  const { parsed, workbook, hosted } = input
  const hash = workbook.sha256
  const scope = input.scope ?? null
  const inScope = (cohortId: string): boolean => scope === null || scope.cohortIds.includes(cohortId)
  const scopedTables = parsed.tables.filter((parsedTable) => scope === null || (parsedTable.cohort !== null && inScope(parsedTable.cohort.id)))
  const issues: TargetIssue[] = []
  const issue = (code: string, blocking: boolean, detail: string, count = 1): void => {
    const existing = issues.find((entry) => entry.code === code && entry.detail === detail)
    if (existing) existing.count += count
    else issues.push({ code, blocking, detail, count })
  }

  const retained = emptyRecord<BackupTable>([
    'programs',
    'batches',
    'students',
    'student_finance_records',
    'installments',
    'payments',
    'receipts',
    'receipt_deliveries',
    'reminder_deliveries',
    'import_batches',
    'import_exceptions',
    'batch_finance_columns',
    'audit_log',
  ]) as unknown as Record<BackupTable, string[]>
  const inserts = emptyRecord<InsertTable>(INSERT_TABLES) as unknown as Record<InsertTable, Row[]>
  const links: TargetRecordLink[] = []
  const cohorts: TargetDataset['cohorts'] = []

  // --- Programs ---------------------------------------------------------------
  const programByCode = new Map(hosted.programs.map((program) => [String(program.short_code), program]))
  const programId = (code: string): string => {
    const existing = programByCode.get(code)
    if (existing) return existing.id
    if (code === FRENCH_PROGRAM.shortCode) return frenchProgramId()
    throw new Error(`no program configured for ${code}`)
  }
  for (const program of hosted.programs) retained.programs.push(program.id)
  if (!programByCode.has(FRENCH_PROGRAM.shortCode) && inScope('FRENCH-CURRENT')) {
    inserts.programs.push({
      id: frenchProgramId(),
      name: FRENCH_PROGRAM.name,
      short_code: FRENCH_PROGRAM.shortCode,
      student_number_prefix: FRENCH_PROGRAM.studentNumberPrefix,
      receipt_course_code: FRENCH_PROGRAM.receiptCourseCode,
      receipt_course_suffix: FRENCH_PROGRAM.receiptCourseSuffix,
      active: true,
    })
  }

  // --- Audit history is retained whole ---------------------------------------
  // Import runs, their exceptions and the audit trail are history, not
  // operational cohort data. They stay, ids and all.
  retained.import_batches.push(...hosted.import_batches.map((row) => row.id))
  retained.import_exceptions.push(...hosted.import_exceptions.map((row) => row.id))
  retained.audit_log.push(...hosted.audit_log.map((row) => row.id))
  retained.receipts.push(...hosted.receipts.map((row) => row.id))
  retained.receipt_deliveries.push(...hosted.receipt_deliveries.map((row) => row.id))
  retained.reminder_deliveries.push(...hosted.reminder_deliveries.map((row) => row.id))

  // --- March: preserved from hosted ---------------------------------------
  const pswId = programByCode.get('PSW')?.id ?? null
  const hostedCohorts = TARGET_COHORTS.filter((cohort) => cohort.source === 'hosted' && inScope(cohort.id))
  for (const cohort of hostedCohorts) {
    const batches = hosted.batches.filter(
      (batch) =>
        batch.program_id === programByCode.get(cohort.programShortCode)?.id &&
        cohortMonthOf(String(batch.legacy_sheet_name ?? batch.name), null).yearMonth === cohort.yearMonth,
    )
    if (batches.length === 0) issue('HOSTED_COHORT_NOT_FOUND', true, `${cohort.label}: no hosted batch found`)
    const batchIds = new Set(batches.map((batch) => batch.id))
    const records = hosted.student_finance_records.filter((record) => batchIds.has(String(record.batch_id)))
    const recordIds = new Set(records.map((record) => record.id))
    retained.batches.push(...batches.map((batch) => batch.id))
    retained.student_finance_records.push(...records.map((record) => record.id))
    retained.installments.push(...hosted.installments.filter((row) => recordIds.has(String(row.student_finance_record_id))).map((row) => row.id))
    retained.payments.push(...hosted.payments.filter((row) => recordIds.has(String(row.student_finance_record_id))).map((row) => row.id))
    retained.batch_finance_columns.push(...hosted.batch_finance_columns.filter((row) => batchIds.has(String(row.batch_id))).map((row) => row.id))
    const studentIds = new Set(records.map((record) => String(record.student_id)))
    retained.students.push(...studentIds)
    const studentById = new Map(hosted.students.map((student) => [student.id, student]))
    for (const record of records) {
      const student = studentById.get(String(record.student_id))
      links.push({
        financeRecordId: record.id,
        studentId: String(record.student_id),
        studentNumber: (student?.student_number as string | null) ?? null,
        cohortId: cohort.id,
        programShortCode: cohort.programShortCode,
        batchId: String(record.batch_id),
        origin: 'hosted',
        sheet: (record.legacy_source_sheet as string | null) ?? null,
        row: (record.legacy_source_row as number | null) ?? null,
        named: true,
        resolution: 'hosted_march',
        collectionMode: cohort.collectionMode,
      })
    }
    cohorts.push({ id: cohort.id, label: cohort.label, source: 'hosted', programShortCode: cohort.programShortCode, batchIds: batches.map((batch) => batch.id).sort() })
    if (pswId === null) issue('PSW_PROGRAM_MISSING', true, 'hosted has no PSW program row')
  }

  // --- Workbook students: exact number only ---------------------------------
  const observations: StudentObservation[] = []
  scopedTables.forEach((parsedTable, index) => {
    for (const row of studentRows(parsedTable)) {
      observations.push({
        origin: 'batch_table',
        sheetName: parsedTable.sheetName,
        tableKey: parsedTable.table.key,
        row: row.row,
        order: index + 1,
        studentNumber: row.studentNumber,
        firstName: row.firstName,
        middleName: row.middleName,
        lastName: row.lastName,
        fullName: null,
      })
    }
  })
  const studentPlan = planStudents(hash, observations)

  const hostedByNumber = new Map<string, BackupRow[]>()
  for (const student of hosted.students) {
    const number = student.student_number as string | null
    if (number === null) continue
    hostedByNumber.set(number, [...(hostedByNumber.get(number) ?? []), student])
  }

  const studentIdByKey = new Map<string, { id: string; resolution: StudentResolution }>()
  const marchStudentIds = new Set(retained.students)
  const insertStudent = (student: PlannedStudent, resolution: StudentResolution): void => {
    const id = entityId(student.sourceKey)
    studentIdByKey.set(student.sourceKey, { id, resolution })
    inserts.students.push({
      id,
      student_number: student.studentNumber,
      first_name: student.firstName,
      middle_name: student.middleName,
      last_name: student.lastName,
      display_name: student.legacyDisplayName,
      legacy_name: student.legacyDisplayName,
      email: null,
      phone: null,
      active: true,
      legacy_source: student.legacySource,
      legacy_raw_json: { ...student.legacyRawJson, ticket: TICKET, workbook_sha256: hash },
    })
  }

  for (const student of studentPlan.students) {
    const matches = hostedByNumber.get(student.studentNumber as string) ?? []
    if (matches.length > 1) {
      issue('HOSTED_DUPLICATE_STUDENT_NUMBER', true, 'a workbook student number is held by more than one hosted student; refusing to choose')
      continue
    }
    if (matches.length === 1) {
      const hostedStudent = matches[0]
      studentIdByKey.set(student.sourceKey, { id: hostedStudent.id, resolution: 'hosted_by_number' })
      if (!marchStudentIds.has(hostedStudent.id) && !retained.students.includes(hostedStudent.id)) retained.students.push(hostedStudent.id)
      const hostedForm = nameComparisonForm(
        hostedStudent.first_name as string | null,
        hostedStudent.middle_name as string | null,
        hostedStudent.last_name as string | null,
      )
      const sourceForm = nameComparisonForm(student.firstName, student.middleName, student.lastName)
      if (hostedForm !== sourceForm) {
        issue('REUSED_STUDENT_NAME_DIFFERS', false, 'a re-used hosted student is spelled differently in the workbook; the hosted name is kept, the workbook spelling stays in provenance')
      }
      continue
    }
    insertStudent(student, 'new_numbered')
  }
  for (const student of studentPlan.unresolvedStudents) insertStudent(student, 'new_unnumbered')
  for (const conflict of studentPlan.nameConflicts) {
    issue('WORKBOOK_NUMBER_SPELLED_TWO_WAYS', false, `one student number is spelled ${conflict.distinctNames} ways across workbook rows`)
  }

  const studentKeyForRow = (parsedTable: ParsedTable, row: SourceRow): string =>
    row.studentNumber === null
      ? unresolvedStudentSourceKey(hash, parsedTable.sheetName, parsedTable.table.key, row.row)
      : studentSourceKey(hash, row.studentNumber)

  // --- Workbook cohorts -------------------------------------------------------
  const importBatchId = entityId(sourceKey(hash, 'cutover-import-batch', TICKET))
  let rowsSeen = 0
  let rowsImported = 0
  const exceptions: Row[] = []
  const addException = (
    parsedTable: ParsedTable,
    row: number,
    column: string | null,
    entityType: string,
    reason: string,
    raw: Record<string, unknown>,
  ): void => {
    const key = importExceptionSourceKey(hash, `${entityType}:${reason}`, parsedTable.sheetName, row, column)
    exceptions.push({
      id: entityId(key),
      import_batch_id: importBatchId,
      source_filename: workbook.fileName,
      source_sheet: parsedTable.sheetName,
      source_row: row,
      source_column: column,
      entity_type: entityType,
      reason,
      source_key: key,
      legacy_raw_json: { ticket: TICKET, workbook_sha256: hash, table_key: parsedTable.table.key, block_title: parsedTable.table.title, ...raw },
    })
  }

  const cohortBatches = new Map<string, string[]>()
  for (const parsedTable of scopedTables) {
    const cohort = parsedTable.cohort
    if (cohort === null) continue
    const { table } = parsedTable
    const batchKey = batchSourceKey(hash, table.sheetName, table.key)
    const batchId = entityId(batchKey)
    cohortBatches.set(cohort.id, [...(cohortBatches.get(cohort.id) ?? []), batchId])

    inserts.batches.push({
      id: batchId,
      program_id: programId(parsedTable.programShortCode),
      name: parsedTable.batchName,
      code: `${table.sheetName}!${table.key}`,
      start_date: parsedTable.startDate,
      end_date: null,
      active: true,
      legacy_sheet_name: table.sheetName,
    })

    const filtered = studentOnlyTable(parsedTable)
    const classified = classifiedByRow(parsedTable)
    const redacted = new Set(parsedTable.redactedColumns.map((column) => column.letter))

    const recordResult = planBatchFinanceRecords(hash, filtered, parsedTable.programShortCode, batchKey, (row) => studentKeyForRow(parsedTable, row))
    const recordIdByRow = new Map<number, string>()

    for (const record of recordResult.records) {
      const row = record.legacySourceRow as number
      const resolved = studentIdByKey.get(record.studentSourceKey)
      if (!resolved) {
        issue('ROW_WITHOUT_RESOLVED_STUDENT', true, `${table.sheetName} row ${row}: no student resolved`)
        continue
      }
      const id = entityId(record.sourceKey)
      recordIdByRow.set(row, id)
      const classifiedRow = classified.get(row) as ClassifiedRow
      const raw = record.legacyRawJson as Record<string, unknown> & { cells: Record<string, unknown> }
      const cells = Object.fromEntries(Object.entries(raw.cells).filter(([letter]) => !redacted.has(letter)))

      inserts.student_finance_records.push({
        id,
        student_id: resolved.id,
        program_id: programId(parsedTable.programShortCode),
        batch_id: batchId,
        legacy_total_fee: record.legacyTotalFee.value,
        legacy_total_paid: record.legacyTotalPaid.value,
        legacy_balance: record.legacyBalance.value,
        current_total_fee: null,
        currency: 'CAD',
        status: 'active',
        collection_mode: cohort.collectionMode,
        legacy_source_sheet: record.legacySourceSheet,
        legacy_source_row: record.legacySourceRow,
        legacy_raw_json: {
          ...raw,
          cells,
          program_source_label: parsedTable.sourceProgramLabel,
          ticket: TICKET,
          workbook_sha256: hash,
          cohort_id: cohort.id,
          redacted_columns: parsedTable.redactedColumns.map((column) => ({
            letter: column.letter,
            header: column.header,
            reason: 'heading names a value the finance system must never hold; left out by name',
          })),
          ...(classifiedRow.offTableCells.length > 0 ? { off_table_cells: classifiedRow.offTableCells } : {}),
          ...(classifiedRow.misplaced.length > 0 ? { misplaced_values: classifiedRow.misplaced } : {}),
          legacy_figures: {
            total_fee: record.legacyTotalFee,
            total_paid: record.legacyTotalPaid,
            balance: record.legacyBalance,
          },
        },
      })

      links.push({
        financeRecordId: id,
        studentId: resolved.id,
        studentNumber: record.studentNumber,
        cohortId: cohort.id,
        programShortCode: parsedTable.programShortCode,
        batchId,
        origin: 'workbook',
        sheet: table.sheetName,
        row,
        named: classifiedRow.named,
        resolution: resolved.resolution,
        collectionMode: cohort.collectionMode,
      })

      for (const payment of planCellPayments(hash, parsedTable, classifiedRow.source, id)) {
        if (payment.skipped) {
          issue('MONEY_CELL_NOT_A_PAYMENT', false, payment.skipped.reason)
          addException(parsedTable, payment.skipped.row, payment.skipped.letter, 'payment', 'money_cell_not_a_payment', { reason: payment.skipped.reason })
          continue
        }
        inserts.payments.push(payment.row)
      }

      for (const value of classifiedRow.misplaced) {
        addException(parsedTable, row, value.letter, 'student', 'misplaced_numeric_value', {
          header: value.header,
          raw_value: value.value,
          note: value.reason,
        })
      }
      for (const cell of classifiedRow.offTableCells) {
        addException(parsedTable, row, cell.letter, 'finance_record', 'cell_outside_table', {
          cell,
          note: 'typed right of the last headed column; preserved, never read as money',
        })
      }
    }

    // The planner carries whatever key it is given; here that is the record id itself.
    const installmentResult = planInstallments(hash, filtered, (row) => recordIdByRow.get(row) ?? null)
    for (const installment of installmentResult.installments) {
      inserts.installments.push({
        id: entityId(installment.sourceKey),
        student_finance_record_id: installment.financeRecordSourceKey,
        sequence_number: installment.sequenceNumber,
        installment_type: installment.installmentType,
        installment_month: null,
        due_date: null,
        scheduled_amount: installment.scheduledAmount,
        default_note: installment.defaultNote,
        custom_note: null,
        legacy_column_name: installment.legacyColumnName,
        legacy_value_text: installment.legacyValueText,
        status: 'scheduled',
        legacy_raw_json: { ...installment.legacyRawJson, ticket: TICKET, workbook_sha256: hash },
      })
    }
    for (const skipped of installmentResult.errorCellsSkipped) {
      addException(parsedTable, skipped.row, skipped.letter, 'installment', 'installment_error_cell', { error: skipped.error })
    }

    for (const column of planTableManifest(hash, { table: filtered, programShortCode: parsedTable.programShortCode, sourceProgramLabel: parsedTable.sourceProgramLabel })) {
      inserts.batch_finance_columns.push({
        id: column.id,
        batch_id: column.batchId,
        section: column.section,
        source_column_letter: column.sourceColumnLetter,
        source_header: column.sourceHeader,
        source_header_inherited: column.sourceHeaderInherited,
        column_key: column.columnKey,
        normalized_role: column.normalizedRole,
        value_kind: column.valueKind,
        display_order: column.displayOrder,
        is_grid_visible: column.isGridVisible,
        display_even_if_blank: column.displayEvenIfBlank,
        origin: column.origin,
        legacy_sheet_name: column.legacySheetName,
        legacy_table_key: column.legacyTableKey,
        source_workbook_hash: column.sourceWorkbookHash,
      })
    }

    // Rows that are not students are preserved when they carry anything.
    for (const row of parsedTable.rows) {
      rowsSeen += 1
      if (row.rowClass === 'student') {
        rowsImported += 1
        continue
      }
      const cells = Object.fromEntries(
        row.source.cells
          .filter((cell) => !cell.isBlank && !redacted.has(cell.letter))
          .map((cell) => [cell.letter, { raw_value: cell.rawValue, formatted_text: cell.text, formula: cell.formula, cell_type: cell.cellType }]),
      )
      if (row.rowClass === 'placeholder_seat') {
        addException(parsedTable, row.row, null, 'finance_record', 'placeholder_seat', { note: row.reason, cells })
      } else if (row.rowClass === 'below_table' && Object.keys(cells).length > 0) {
        addException(parsedTable, row.row, null, 'finance_record', 'below_table_note', { note: row.reason, cells })
      } else if (row.rowClass === 'empty_seat' && row.source.errorCells.length > 0) {
        addException(parsedTable, row.row, null, 'finance_record', 'error_cell_row', { note: row.reason, cells })
      }
    }
  }

  for (const cohort of TARGET_COHORTS.filter((entry) => entry.source === 'workbook' && inScope(entry.id))) {
    const batchIds = cohortBatches.get(cohort.id) ?? []
    if (batchIds.length === 0) issue('WORKBOOK_COHORT_NOT_FOUND', true, `${cohort.label}: no table in the workbook`)
    cohorts.push({ id: cohort.id, label: cohort.label, source: 'workbook', programShortCode: cohort.programShortCode, batchIds: [...batchIds].sort() })
  }

  inserts.import_exceptions.push(...exceptions)
  inserts.import_batches.push({
    id: importBatchId,
    source_filename: workbook.fileName,
    source_file_hash: hash,
    import_type: IMPORT_TYPE,
    status: 'completed',
    rows_seen: rowsSeen,
    rows_imported: rowsImported,
    rows_skipped: rowsSeen - rowsImported,
    notes: scope !== null
      ? `${TICKET} narrowed launch ${scope.id}: ${scope.cohortIds.join(', ')} from this workbook, non-destructive outside those cohorts ` +
        '(only the superseded hosted batch tables of the same cohorts are replaced; every other hosted row and every student is retained). ' +
        'Payments are the ACTUAL-section money cells (no date or method stated). Ids are v5 UUIDs over the importer source keys of this workbook hash.'
      : `${TICKET} active-cohort cutover. Replaces the historical operational dataset (workbook ${SUPERSEDED_WORKBOOK_SHA256}) ` +
      'with the launch cohorts: PSW March 2026 preserved from hosted; PSW April/June/August/September 2026, ECEA and French ' +
      'from this workbook. Payments are the ACTUAL-section money cells (no date or method stated). Ids are v5 UUIDs over the ' +
      'importer source keys of this workbook hash.',
  })

  // --- Narrowed launch: retain everything hosted except the replaced tables -
  if (scope !== null) {
    const replacedBatches = new Set<string>()
    for (const cohort of TARGET_COHORTS.filter((entry) => inScope(entry.id) && entry.source === 'workbook')) {
      for (const batch of hostedBatchesOfCohort(hosted, cohort)) replacedBatches.add(batch.id)
    }
    const replacedRecords = new Set(hosted.student_finance_records.filter((row) => row.batch_id !== null && replacedBatches.has(String(row.batch_id))).map((row) => row.id))
    const replaced: Partial<Record<BackupTable, Set<string>>> = {
      batches: replacedBatches,
      student_finance_records: replacedRecords,
      installments: new Set(hosted.installments.filter((row) => replacedRecords.has(String(row.student_finance_record_id))).map((row) => row.id)),
      payments: new Set(hosted.payments.filter((row) => replacedRecords.has(String(row.student_finance_record_id))).map((row) => row.id)),
      batch_finance_columns: new Set(hosted.batch_finance_columns.filter((row) => replacedBatches.has(String(row.batch_id))).map((row) => row.id)),
    }
    for (const table of Object.keys(retained) as BackupTable[]) {
      const drop = replaced[table] ?? new Set<string>()
      retained[table] = hosted[table].map((row) => row.id).filter((id) => !drop.has(id))
    }
    const targetStudents = new Set(links.map((link) => link.studentId))
    const notCarried = hosted.student_finance_records.filter((row) => replacedRecords.has(row.id) && !targetStudents.has(String(row.student_id)))
    if (notCarried.length > 0) {
      issue(
        'REPLACED_RECORD_STUDENT_NOT_IN_WORKBOOK',
        false,
        'a superseded hosted June/August record belongs to a student with no row in the replacement workbook; the student row is kept, the old record leaves with its table (it stays in the backup)',
        notCarried.length,
      )
    }
  }

  // Deterministic order everywhere, so the hash never depends on traversal order.
  for (const table of INSERT_TABLES) inserts[table].sort((a, b) => a.id.localeCompare(b.id))
  for (const table of Object.keys(retained) as BackupTable[]) retained[table] = [...new Set(retained[table])].sort()
  links.sort((a, b) => a.financeRecordId.localeCompare(b.financeRecordId))
  cohorts.sort((a, b) => a.id.localeCompare(b.id))
  issues.sort((a, b) => a.code.localeCompare(b.code) || a.detail.localeCompare(b.detail))

  const ids = new Set<string>()
  for (const table of INSERT_TABLES) {
    for (const row of inserts[table]) {
      if (ids.has(row.id)) issue('DUPLICATE_INSERT_ID', true, `${table}: duplicate id`)
      ids.add(row.id)
    }
  }

  return {
    ticket: TICKET,
    workbook,
    supersededWorkbookSha256: SUPERSEDED_WORKBOOK_SHA256,
    retained,
    inserts,
    cohorts,
    links,
    issues,
  }
}

/** SHA-256 of the canonical dataset. Equal inputs give an equal hash. */
export function targetHash(target: TargetDataset): string {
  return createHash('sha256').update(canonicalJson(target), 'utf8').digest('hex')
}
