/**
 * The dry-run plan: everything an apply would do, and nothing it would do.
 *
 * This module reads the workbook and produces a complete description of the
 * rows that *would* be inserted. It holds no database client, imports none, and
 * has no code path that writes anything anywhere. That is a property of the
 * module, not a flag on it.
 *
 * The plan's accounting rule is that every source row is accounted for. A row
 * either has a deterministic planned import path or appears in `unresolved`
 * with a reason. Nothing falls off the end quietly, which is what makes
 * READY_FOR_APPLY mean something.
 */

import * as XLSX from 'xlsx'

import { buildBatchCandidate, findBatchNameCollisions } from './batches.mts'
import { buildImportException, tallyExceptionReasons } from './exceptions.mts'
import { classifySheet } from '../lib/classify.mts'
import { findBlocks } from '../lib/blocks.mts'
import {
  planBatchFinanceRecords,
  planUnassignedFinanceRecord,
  resolveUnassignedTotalFee,
} from './finance-records.mts'
import { planInstallments } from './installments.mts'
import { planPayments, resolveTrackerColumns } from './payments.mts'
import { planStudents } from './students.mts'
import { resolveProgramLabel, resolveSheetProgram } from './programs.mts'
import { buildSourceTable } from './source-tables.mts'
import { openWorkbook } from '../lib/workbook-source.mts'
import { usesDate1904 } from '../lib/excel-values.mts'

import type { BatchCandidate } from './batches.mts'
import type { PlannedImportException } from './exceptions.mts'
import type { PlannedFinanceRecord } from './finance-records.mts'
import type { PlannedInstallment } from './installments.mts'
import type { PlannedPayment, RoutingCandidate } from './payments.mts'
import type { PlannedStudent, StudentObservation } from './students.mts'
import type { SourceRow, SourceTable } from './source-tables.mts'
import type { WorkbookFingerprint } from '../lib/workbook-source.mts'

/** A source row that cannot be imported, with the reason it cannot. */
export interface UnresolvedRow {
  category: string
  sheetName: string
  row: number
  programShortCode: string | null
  note: string
  /**
   * Where the row goes instead of a normalized entity.
   *
   * A row preserved as an import exception has a destination, so it is not a
   * silent drop and does not block an apply. `null` means it has none, which
   * does.
   */
  preservedAs: 'import_exception' | null
  /** True when this row blocks a safe apply of PSW/ECEA data. */
  blocking: boolean
}

export interface DeferredSheet {
  sheetName: string
  reason: string
  meaningfulRows: number
  rowsWithStudentNumber: number
}

export interface TablePlan {
  sheetName: string
  tableKey: string
  title: string | null
  session: 'Morning' | 'Evening' | null
  programShortCode: string
  sourceProgramLabel: string
  batchSourceKey: string
  rowCount: number
  studentRowCount: number
  totalsRowCount: number
  otherRowCount: number
  financeRecordCount: number
  installmentCount: number
  summaryColumnEvidence: string[]
  excludedScheduleColumns: { letter: string; header: string | null; reason: string }[]
}

export interface ErrorCellRecord {
  sheetName: string
  ref: string
  row: number
  error: string
  formula: string | null
  disposition: string
}

export interface DryRunPlan {
  fingerprint: WorkbookFingerprint
  date1904: boolean
  /** Sheet names exactly as `workbook.SheetNames` gives them. */
  sheetNames: string[]
  programs: {
    shortCode: string
    sourceLabels: string[]
    aliased: boolean
  }[]
  batches: BatchCandidate[]
  batchNameCollisions: ReturnType<typeof findBatchNameCollisions>
  students: PlannedStudent[]
  unresolvedStudents: PlannedStudent[]
  nameConflicts: ReturnType<typeof planStudents>['nameConflicts']
  financeRecords: PlannedFinanceRecord[]
  installments: PlannedInstallment[]
  payments: PlannedPayment[]
  tables: TablePlan[]
  deferred: DeferredSheet[]
  unresolved: UnresolvedRow[]
  errorCells: ErrorCellRecord[]
  preservedDuplicateCandidates: { signature: string; rows: number[] }[]
  totalsRowsExcluded: { sheetName: string; row: number; tableKey: string }[]
  notImportedSheets: { sheetName: string; reason: string }[]
  /** Source rows preserved verbatim instead of becoming normalized records. */
  importExceptions: PlannedImportException[]
  /** Batch rows that named a student without numbering them. */
  batchRowsWithoutStudentNumber: {
    sheetName: string
    row: number
    tableKey: string
    programShortCode: string
  }[]
  /** Internal consistency failures. Expected to be empty; blocking if not. */
  invariantViolations: string[]
  counts: DryRunCounts
  readiness: ApplyReadiness
}

export interface DryRunCounts {
  batches: number
  batchesByProgram: Record<string, number>
  students: number
  unresolvedStudents: number
  /** Of those, the ones from a batch table rather than Tracker Master. */
  unresolvedBatchStudents: number
  unresolvedTrackerStudents: number
  financeRecords: number
  financeRecordsBatchSpecific: number
  financeRecordsUnassigned: number
  financeRecordsByProgram: Record<string, number>
  installments: number
  installmentsByProgram: Record<string, number>
  payments: number
  paymentsPlanned: number
  paymentsUnresolved: number
  paymentRouting: {
    uniqueBatch: number
    ambiguousBatch: number
    batchNotFound: number
    missingStudentId: number
  }
  programInferredPayments: number
  totalsRowsExcluded: number
  otherRowsExcluded: number
  nameConflicts: number
  /** Of those, the ones where a single sheet spells one number two ways. */
  nameConflictsWithinOneSheet: number
  duplicateCandidateGroups: number
  duplicateCandidateRows: number
  errorCellsPreserved: number
  frenchRowsDeferred: number
  importExceptions: number
  importExceptionsByReason: Record<string, number>
  missingAmountExceptions: number
}

export interface ApplyReadiness {
  ready: boolean
  /** Reasons the plan is not ready. Empty when it is. */
  blockers: string[]
  /** Things a reviewer should see that do not block PSW/ECEA. */
  notes: string[]
}

/** Sheets whose rows are reference-only and produce no inserts at all. */
const NOT_IMPORTED = new Map<string, string>([
  [
    'summary',
    'derived pivot output: stored totals with no formulas, duplicating money already recorded per transaction',
  ],
])

interface PreparedTable {
  table: SourceTable
  programShortCode: string
  sourceProgramLabel: string
  batch: BatchCandidate
}

/**
 * Builds the complete dry-run plan from the workbook on disk.
 *
 * Opens the workbook read-only from a buffer. Performs no I/O other than that
 * read.
 */
export function buildDryRunPlan(repoRoot: string, now: Date): DryRunPlan {
  const { fingerprint, workbook } = openWorkbook(repoRoot, now)
  const date1904 = usesDate1904(workbook)
  const hash = fingerprint.sha256

  const prepared: PreparedTable[] = []
  const deferred: DeferredSheet[] = []
  const notImportedSheets: { sheetName: string; reason: string }[] = []
  const errorCells: ErrorCellRecord[] = []
  const unresolved: UnresolvedRow[] = []
  let trackerTable: SourceTable | null = null

  // --- 1. Read every sheet, and decide what each one is ----------------------
  workbook.SheetNames.forEach((sheetName) => {
    const sheet = workbook.Sheets[sheetName]
    const ref = sheet['!ref']
    const blocks = ref ? findBlocks(sheet, XLSX.utils.decode_range(ref)) : []
    const { classification } = classifySheet(sheetName, blocks)

    const notImported = NOT_IMPORTED.get(classification)
    if (notImported !== undefined) {
      notImportedSheets.push({ sheetName, reason: notImported })
      return
    }

    if (classification === 'transaction_master') {
      trackerTable = buildSourceTable(sheetName, sheet, blocks[0], 'transaction_master')
      return
    }

    if (classification !== 'psw_batch' && classification !== 'other_program_batch') {
      notImportedSheets.push({
        sheetName,
        reason: `sheet classified as ${classification}; no mapping is defined for it`,
      })
      return
    }

    const kind = classification === 'psw_batch' ? 'psw_batch' : 'cohort_roster'

    for (const block of blocks) {
      const table = buildSourceTable(sheetName, sheet, block, kind)
      const program = resolveSheetProgram(sheetName, block.title)

      for (const row of table.rows) {
        for (const cell of row.errorCells) {
          errorCells.push({
            sheetName,
            ref: cell.ref,
            row: cell.row,
            error: cell.error,
            formula: cell.formula,
            disposition:
              'preserved as-is; not repaired, not coerced to zero, and barred from becoming a student number',
          })
        }
      }

      if (program.status === 'deferred') {
        deferred.push({
          sheetName,
          reason: program.reason,
          meaningfulRows: table.rows.filter((row) => row.kind !== 'other').length,
          rowsWithStudentNumber: table.rows.filter((row) => row.studentNumber !== null).length,
        })
        continue
      }

      if (program.status !== 'mapped') {
        notImportedSheets.push({
          sheetName,
          reason: `no canonical program could be resolved for this sheet (${program.status})`,
        })
        continue
      }

      prepared.push({
        table,
        programShortCode: program.shortCode,
        sourceProgramLabel: program.sourceLabel,
        batch: buildBatchCandidate(hash, table, program.shortCode, program.sourceLabel),
      })
    }
  })

  const tracker = trackerTable as SourceTable | null
  if (tracker === null) {
    throw new Error('No transaction master sheet was found in the workbook.')
  }

  const trackerColumns = resolveTrackerColumns(tracker)

  // --- 2. Student identity, from every supported source ---------------------
  const observations: StudentObservation[] = []

  prepared.forEach(({ table }, index) => {
    for (const row of table.rows) {
      if (row.kind !== 'student') continue
      observations.push({
        origin: 'batch_table',
        sheetName: table.sheetName,
        tableKey: table.key,
        row: row.row,
        // Batch sheets rank after Tracker Master, which takes rank 0.
        order: index + 1,
        studentNumber: row.studentNumber,
        firstName: row.firstName,
        middleName: row.middleName,
        lastName: row.lastName,
        fullName: row.fullName,
      })
    }
  })

  for (const row of tracker.rows) {
    if (row.cells.every((cell) => cell.isBlank)) continue
    observations.push({
      origin: 'tracker_master',
      sheetName: tracker.sheetName,
      tableKey: null,
      row: row.row,
      order: 0,
      studentNumber: row.studentNumber,
      firstName: null,
      middleName: null,
      lastName: null,
      fullName: row.fullName,
    })
  }

  // Every row that names a student becomes one, numbered or not. A batch-sheet
  // row with a name and no number gets an unresolved student keyed on that exact
  // source row, so its finance snapshot survives and it is never matched to
  // another row by name.
  const studentPlan = planStudents(hash, observations)

  const studentKeyByNumber = new Map(
    studentPlan.students.map((student) => [student.studentNumber as string, student.sourceKey]),
  )

  // Unresolved students are keyed by where they came from, because two
  // number-less rows on one sheet are two different people.
  const unresolvedKeyOf = (sheetName: string, tableKey: string | null, row: number): string =>
    JSON.stringify([sheetName, tableKey, row])

  const unresolvedStudentKeyByRow = new Map(
    studentPlan.unresolvedStudents.map((student) => [
      unresolvedKeyOf(
        student.observations[0].sheetName,
        student.observations[0].tableKey,
        student.observations[0].row,
      ),
      student.sourceKey,
    ]),
  )

  const studentKeyFor = (studentNumber: string): string | null =>
    studentKeyByNumber.get(studentNumber) ?? null

  /** Resolves any batch-table row to its planned student, numbered or not. */
  const batchStudentKeyFor = (table: SourceTable) => (row: SourceRow): string | null =>
    row.studentNumber === null
      ? (unresolvedStudentKeyByRow.get(unresolvedKeyOf(table.sheetName, table.key, row.row)) ?? null)
      : studentKeyFor(row.studentNumber)

  // --- 3. Batch finance records and installments ---------------------------
  const financeRecords: PlannedFinanceRecord[] = []
  const installments: PlannedInstallment[] = []
  const tables: TablePlan[] = []
  const totalsRowsExcluded: DryRunPlan['totalsRowsExcluded'] = []
  let otherRowsExcluded = 0

  const routingIndex = new Map<string, RoutingCandidate[]>()
  const importExceptions: PlannedImportException[] = []
  const batchRowsWithoutStudentNumber: {
    sheetName: string
    row: number
    tableKey: string
    programShortCode: string
  }[] = []

  for (const entry of prepared) {
    const { table, programShortCode, sourceProgramLabel, batch } = entry

    const recordResult = planBatchFinanceRecords(
      hash,
      table,
      programShortCode,
      batch.sourceKey,
      batchStudentKeyFor(table),
    )

    const recordKeyByRow = new Map(
      recordResult.records.map((record) => [record.legacySourceRow as number, record.sourceKey]),
    )

    const installmentResult = planInstallments(
      hash,
      table,
      (row) => recordKeyByRow.get(row) ?? null,
    )

    financeRecords.push(...recordResult.records)
    installments.push(...installmentResult.installments)
    totalsRowsExcluded.push(...recordResult.totalsRowsExcluded)
    otherRowsExcluded += recordResult.otherRowsExcluded.length

    for (const record of recordResult.records) {
      if (record.studentNumber === null) continue
      const candidates = routingIndex.get(record.studentNumber) ?? []
      candidates.push({
        financeRecordSourceKey: record.sourceKey,
        batchSourceKey: batch.sourceKey,
        programShortCode,
        sheetName: table.sheetName,
        tableKey: table.key,
      })
      routingIndex.set(record.studentNumber, candidates)
    }

    // Rows that name a student without numbering them now get an unresolved
    // student and a batch-specific record, so they have a destination. They are
    // still surfaced, because a reviewer should see how many there are.
    batchRowsWithoutStudentNumber.push(
      ...recordResult.rowsWithoutStudentNumber.map((row) => ({
        sheetName: row.sheetName,
        row: row.row,
        tableKey: row.tableKey,
        programShortCode,
      })),
    )

    // A row that could not be resolved to any student at all has no destination
    // and would be dropped. That blocks a safe apply.
    for (const row of recordResult.rowsWithNoResolvableStudent) {
      unresolved.push({
        category: 'batch_row_without_resolvable_student',
        sheetName: row.sheetName,
        row: row.row,
        programShortCode,
        note: `${row.reason}; no finance record is planned for this row`,
        preservedAs: null,
        blocking: true,
      })
    }

    // A schedule cell holding a spreadsheet error has a value the workbook
    // cannot state. It is preserved rather than dropped or read as zero.
    for (const skipped of installmentResult.errorCellsSkipped) {
      const exception = buildImportException({
        workbookHash: hash,
        sourceFilename: fingerprint.fileName,
        sourceSheet: skipped.sheetName,
        sourceRow: skipped.row,
        sourceColumn: skipped.letter,
        entityType: 'installment',
        reason: 'installment_error_cell',
        note: `schedule cell ${skipped.letter} holds ${skipped.error}; no installment planned`,
        legacyRawJson: { error: skipped.error, column: skipped.letter },
      })
      importExceptions.push(exception)

      unresolved.push({
        category: 'installment_error_cell',
        sheetName: skipped.sheetName,
        row: skipped.row,
        programShortCode,
        note: `schedule cell ${skipped.letter} holds ${skipped.error}; preserved as an import exception`,
        preservedAs: 'import_exception',
        blocking: false,
      })
    }

    tables.push({
      sheetName: table.sheetName,
      tableKey: table.key,
      title: table.title,
      session: table.session,
      programShortCode,
      sourceProgramLabel,
      batchSourceKey: batch.sourceKey,
      rowCount: table.rows.length,
      studentRowCount: table.rows.filter((row) => row.kind === 'student').length,
      totalsRowCount: recordResult.totalsRowsExcluded.length,
      otherRowCount: recordResult.otherRowsExcluded.length,
      financeRecordCount: recordResult.records.length,
      installmentCount: installmentResult.installments.length,
      summaryColumnEvidence: recordResult.summaryColumnEvidence,
      excludedScheduleColumns: installmentResult.excludedColumns,
    })
  }

  // --- 4. Enrollment Total Fees seen per student, for unassigned records ----
  const feesByStudent = new Map<string, { row: number; value: number }[]>()
  if (trackerColumns.enrollmentTotalFee !== null) {
    const column = trackerColumns.enrollmentTotalFee.column
    for (const row of tracker.rows) {
      if (row.studentNumber === null) continue
      const cell = row.cellByColumn.get(column)
      if (!cell || cell.isBlank || cell.numeric === null) continue
      const existing = feesByStudent.get(row.studentNumber) ?? []
      existing.push({ row: row.row, value: cell.numeric })
      feesByStudent.set(row.studentNumber, existing)
    }
  }

  // --- 5. Payments, and the unassigned records they fall back to ------------
  const unassignedRecords = new Map<string, PlannedFinanceRecord>()

  const unassignedRecordFor = (
    studentSourceKey: string,
    studentNumber: string | null,
    programShortCode: string,
    reason: string,
  ): string => {
    const key = `${studentSourceKey}\u0000${programShortCode}`
    const existing = unassignedRecords.get(key)
    if (existing) return existing.sourceKey

    const record = planUnassignedFinanceRecord(
      hash,
      studentSourceKey,
      studentNumber,
      programShortCode,
      resolveUnassignedTotalFee(
        studentNumber === null ? [] : (feesByStudent.get(studentNumber) ?? []),
      ),
      reason,
    )
    unassignedRecords.set(key, record)
    return record.sourceKey
  }

  const paymentResult = planPayments({
    workbookHash: hash,
    table: tracker,
    columns: trackerColumns,
    date1904,
    candidatesFor: (studentNumber) => routingIndex.get(studentNumber) ?? [],
    resolveProgram: (label) => {
      const resolved = resolveProgramLabel(label)
      return {
        shortCode: resolved.status === 'mapped' ? resolved.shortCode : null,
        sourceLabel:
          resolved.status === 'blank' ? null : (resolved as { sourceLabel: string }).sourceLabel,
        deferred: resolved.status === 'deferred',
      }
    },
    studentKeyFor,
    unresolvedStudentKeyFor: (row) =>
      unresolvedStudentKeyByRow.get(unresolvedKeyOf(tracker.sheetName, null, row)) ?? null,
    unassignedRecordFor,
  })

  financeRecords.push(...unassignedRecords.values())

  // A transaction row that cannot become a payment is preserved verbatim rather
  // than dropped or forced into a value the workbook never held. The single
  // amount-less row is the case this exists for: payments.amount is NOT NULL and
  // no zero may be invented, so the row is kept as an exception and the money is
  // simply not asserted.
  for (const payment of paymentResult.payments) {
    if (payment.unresolved === null) continue

    const exception = buildImportException({
      workbookHash: hash,
      sourceFilename: fingerprint.fileName,
      sourceSheet: payment.legacySourceSheet,
      sourceRow: payment.legacySourceRow,
      entityType: 'payment',
      reason: payment.unresolved,
      note: payment.unresolvedNote ?? 'no reason recorded',
      wouldBeEntitySourceKey: payment.sourceKey,
      legacyRawJson: payment.legacyRawJson,
    })
    importExceptions.push(exception)

    unresolved.push({
      category: payment.unresolved,
      sheetName: payment.legacySourceSheet,
      row: payment.legacySourceRow,
      programShortCode: payment.programShortCode,
      note: `${payment.unresolvedNote ?? 'no reason recorded'}; preserved as an import exception`,
      preservedAs: 'import_exception',
      // Preserved, not dropped, so it no longer blocks an apply.
      blocking: false,
    })
  }

  // --- 6. Counts ------------------------------------------------------------
  const byProgram = <T extends { programShortCode: string | null }>(
    items: readonly T[],
  ): Record<string, number> => {
    const counts: Record<string, number> = {}
    for (const item of items) {
      if (item.programShortCode === null) continue
      counts[item.programShortCode] = (counts[item.programShortCode] ?? 0) + 1
    }
    return counts
  }

  // An installment always hangs off a batch-specific finance record, so its
  // program is that record's. Indexed rather than scanned: there are ~1,900
  // installments against ~390 records.
  const programByRecordKey = new Map(
    financeRecords.map((record) => [record.sourceKey, record.programShortCode]),
  )
  const installmentsByProgram: Record<string, number> = {}
  for (const installment of installments) {
    const program = programByRecordKey.get(installment.financeRecordSourceKey) ?? 'unknown'
    installmentsByProgram[program] = (installmentsByProgram[program] ?? 0) + 1
  }

  const batchCandidates = prepared.map((entry) => entry.batch)

  const counts: DryRunCounts = {
    batches: batchCandidates.length,
    batchesByProgram: byProgram(batchCandidates),
    students: studentPlan.students.length,
    unresolvedStudents: studentPlan.unresolvedStudents.length,
    unresolvedBatchStudents: studentPlan.unresolvedStudents.filter(
      (student) => student.unresolvedOrigin === 'batch_table',
    ).length,
    unresolvedTrackerStudents: studentPlan.unresolvedStudents.filter(
      (student) => student.unresolvedOrigin === 'tracker_master',
    ).length,
    financeRecords: financeRecords.length,
    financeRecordsBatchSpecific: financeRecords.filter((record) => record.kind === 'batch').length,
    financeRecordsUnassigned: financeRecords.filter((record) => record.kind === 'unassigned').length,
    financeRecordsByProgram: byProgram(financeRecords),
    installments: installments.length,
    installmentsByProgram,
    payments: paymentResult.counts.total,
    paymentsPlanned: paymentResult.payments.filter((payment) => payment.unresolved === null).length,
    paymentsUnresolved: paymentResult.payments.filter((payment) => payment.unresolved !== null)
      .length,
    paymentRouting: {
      uniqueBatch: paymentResult.counts.uniqueBatch,
      ambiguousBatch: paymentResult.counts.ambiguousBatch,
      batchNotFound: paymentResult.counts.batchNotFound,
      missingStudentId: paymentResult.counts.missingStudentId,
    },
    programInferredPayments: paymentResult.counts.programInferred,
    totalsRowsExcluded: totalsRowsExcluded.length,
    otherRowsExcluded,
    nameConflicts: studentPlan.nameConflicts.length,
    nameConflictsWithinOneSheet: studentPlan.nameConflicts.filter(
      (conflict) => conflict.withinOneSheet,
    ).length,
    duplicateCandidateGroups: paymentResult.preservedDuplicateCandidates.length,
    duplicateCandidateRows: paymentResult.preservedDuplicateCandidates.reduce(
      (sum, group) => sum + group.rows.length,
      0,
    ),
    errorCellsPreserved: errorCells.length,
    frenchRowsDeferred: deferred.reduce((sum, sheet) => sum + sheet.meaningfulRows, 0),
    importExceptions: importExceptions.length,
    importExceptionsByReason: tallyExceptionReasons(importExceptions),
    missingAmountExceptions: importExceptions.filter(
      (exception) => exception.reason === 'missing_amount',
    ).length,
  }

  // --- 7. Programs actually used -------------------------------------------
  const programLabels = new Map<string, Set<string>>()
  for (const entry of prepared) {
    const labels = programLabels.get(entry.programShortCode) ?? new Set<string>()
    labels.add(entry.sourceProgramLabel)
    programLabels.set(entry.programShortCode, labels)
  }
  for (const payment of paymentResult.payments) {
    if (payment.programShortCode === null || payment.sourceProgramLabel === null) continue
    const labels = programLabels.get(payment.programShortCode) ?? new Set<string>()
    labels.add(payment.sourceProgramLabel)
    programLabels.set(payment.programShortCode, labels)
  }

  const programs = [...programLabels.entries()]
    .map(([shortCode, labels]) => ({
      shortCode,
      sourceLabels: [...labels].sort((a, b) => a.localeCompare(b)),
      aliased: [...labels].some((label) => label.trim().toUpperCase() !== shortCode),
    }))
    .sort((a, b) => a.shortCode.localeCompare(b.shortCode))

  const batchNameCollisions = findBatchNameCollisions(batchCandidates)

  const invariantViolations = validatePlanInvariants({
    payments: paymentResult.payments,
    financeRecords,
    installments,
    students: studentPlan.students,
    unresolvedStudents: studentPlan.unresolvedStudents,
    importExceptions,
  })

  return {
    fingerprint,
    date1904,
    sheetNames: [...workbook.SheetNames],
    programs,
    batches: batchCandidates,
    batchNameCollisions,
    students: studentPlan.students,
    unresolvedStudents: studentPlan.unresolvedStudents,
    nameConflicts: studentPlan.nameConflicts,
    financeRecords,
    installments,
    payments: paymentResult.payments,
    tables,
    deferred,
    unresolved,
    errorCells,
    preservedDuplicateCandidates: paymentResult.preservedDuplicateCandidates,
    totalsRowsExcluded,
    notImportedSheets,
    importExceptions,
    batchRowsWithoutStudentNumber,
    counts,
    invariantViolations,
    readiness: assessReadiness(counts, unresolved, batchNameCollisions, invariantViolations),
  }
}

/**
 * Internal consistency checks on the finished plan.
 *
 * These are properties an apply depends on and which no single planner can
 * guarantee on its own: they only hold once everything has been assembled. They
 * are checked here rather than trusted, because the failure mode they guard
 * against — a payment planned against a finance record that was never planned —
 * would surface as a foreign-key violation partway through a real import.
 *
 * Returns the violations found. An empty array is the expected result.
 */
export function validatePlanInvariants(plan: {
  payments: readonly PlannedPayment[]
  financeRecords: readonly PlannedFinanceRecord[]
  installments: readonly PlannedInstallment[]
  students: readonly PlannedStudent[]
  unresolvedStudents: readonly PlannedStudent[]
  importExceptions?: readonly PlannedImportException[]
}): string[] {
  const violations: string[] = []

  const recordKeys = new Set(plan.financeRecords.map((record) => record.sourceKey))
  const studentKeys = new Set(
    [...plan.students, ...plan.unresolvedStudents].map((student) => student.sourceKey),
  )

  const planned = plan.payments.filter((payment) => payment.unresolved === null)

  // payments.amount is NOT NULL, so a planned payment without one would fail.
  const withoutAmount = planned.filter((payment) => typeof payment.amount !== 'number').length
  if (withoutAmount > 0) {
    violations.push(`${withoutAmount} planned payment(s) carry no amount`)
  }

  // payments.student_finance_record_id is NOT NULL and must reference a record
  // this same plan creates.
  const danglingPayments = planned.filter(
    (payment) =>
      payment.financeRecordSourceKey === null || !recordKeys.has(payment.financeRecordSourceKey),
  ).length
  if (danglingPayments > 0) {
    violations.push(`${danglingPayments} planned payment(s) reference no planned finance record`)
  }

  const danglingInstallments = plan.installments.filter(
    (installment) => !recordKeys.has(installment.financeRecordSourceKey),
  ).length
  if (danglingInstallments > 0) {
    violations.push(
      `${danglingInstallments} planned installment(s) reference no planned finance record`,
    )
  }

  const danglingRecords = plan.financeRecords.filter(
    (record) => !studentKeys.has(record.studentSourceKey),
  ).length
  if (danglingRecords > 0) {
    violations.push(`${danglingRecords} planned finance record(s) reference no planned student`)
  }

  // Source keys are the idempotency primitive. A collision would make a re-run
  // silently skip a row it had not actually imported.
  const duplicateKeys = (items: readonly { sourceKey: string }[], what: string): void => {
    const keys = new Set(items.map((item) => item.sourceKey))
    if (keys.size !== items.length) {
      violations.push(`${items.length - keys.size} duplicate source key(s) among ${what}`)
    }
  }

  duplicateKeys(plan.payments, 'payments')
  duplicateKeys(plan.financeRecords, 'finance records')
  duplicateKeys(plan.installments, 'installments')
  duplicateKeys([...plan.students, ...plan.unresolvedStudents], 'students')
  duplicateKeys(plan.importExceptions ?? [], 'import exceptions')

  // Every transaction row must end up somewhere: a payment or an exception.
  // This is the "no silent dropping" rule, checked rather than assumed.
  const unplanned = plan.payments.filter((payment) => payment.unresolved !== null)
  const exceptionRows = new Set(
    (plan.importExceptions ?? [])
      .filter((exception) => exception.entityType === 'payment')
      .map((exception) => `${exception.sourceSheet}:${exception.sourceRow}`),
  )
  const dropped = unplanned.filter(
    (payment) => !exceptionRows.has(`${payment.legacySourceSheet}:${payment.legacySourceRow}`),
  ).length
  if (dropped > 0) {
    violations.push(
      `${dropped} transaction row(s) become neither a payment nor an import exception`,
    )
  }

  return violations
}

/**
 * Decides whether the plan could safely be applied.
 *
 * Deliberately strict. A deferred sheet is reported separately and does not
 * make PSW/ECEA unsafe, but any PSW/ECEA row without a planned path does — that
 * is the whole point of the rule, and a dry run that shrugs at it is worse than
 * no dry run.
 */
export function assessReadiness(
  counts: DryRunCounts,
  unresolved: readonly UnresolvedRow[],
  batchNameCollisions: readonly { name: string }[],
  invariantViolations: readonly string[] = [],
): ApplyReadiness {
  const blockers: string[] = []
  const notes: string[] = []

  for (const violation of invariantViolations) {
    blockers.push(`plan is internally inconsistent: ${violation}`)
  }

  const blocking = unresolved.filter((row) => row.blocking)
  if (blocking.length > 0) {
    const byCategory = new Map<string, number>()
    for (const row of blocking) byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + 1)
    for (const [category, count] of byCategory) {
      blockers.push(`${count} PSW/ECEA source row(s) unresolved: ${category}`)
    }
  }

  if (batchNameCollisions.length > 0) {
    blockers.push(
      `${batchNameCollisions.length} batch name collision(s) would violate batches_program_name_key`,
    )
  }

  const nonBlocking = unresolved.filter((row) => !row.blocking)
  if (nonBlocking.length > 0) {
    const byCategory = new Map<string, number>()
    for (const row of nonBlocking) {
      byCategory.set(row.category, (byCategory.get(row.category) ?? 0) + 1)
    }
    for (const [category, count] of byCategory) {
      const preserved = nonBlocking.filter(
        (row) => row.category === category && row.preservedAs !== null,
      ).length
      notes.push(
        preserved === count
          ? `${count} row(s) preserved as import exceptions: ${category}`
          : `${count} row(s) reported and not imported: ${category}`,
      )
    }
  }

  if (counts.frenchRowsDeferred > 0) {
    notes.push(
      `${counts.frenchRowsDeferred} French row(s) deferred by an approved rule; reported separately`,
    )
  }

  return { ready: blockers.length === 0, blockers, notes }
}
