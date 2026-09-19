/**
 * Fixtures for the two committed reports' privacy guards.
 *
 * One plan, deliberately stuffed with values that identify a person, shared by
 * the dry-run report's test and the apply report's test. Both reports go into
 * Git and both are rendered from the same plan shape, so they are held to the
 * same rule by the same fixture: if a new field ever starts carrying a name or
 * an amount into a report, one fixture makes both tests notice.
 *
 * Not a test file: the `*.test.mts` glob does not pick it up.
 */

import type { DryRunPlan } from './plan.mts'
import type { CountResult, PriorImportCheck } from './supabase-readonly.mts'

export const HASH = '62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2'

/** Values that identify a person. None may appear in the rendered report. */
export const SECRETS = {
  studentNumber: '125213',
  name: 'Ramanpreet Kaur',
  altName: 'Ramanpreet Kuar',
  payer: 'Sukhwinder Singh',
  remark: 'paid half in cash at the front desk',
  amount: '4237.55',
}

export function emptyCounts(): CountResult {
  return {
    availability: { available: false, keyKind: null, reason: 'not connected' },
    counts: { programs: null, students: null },
    errors: {},
  }
}

export function priorImport(): PriorImportCheck {
  return { checked: false, alreadyImported: false, statuses: {}, note: 'not checked' }
}

export function planWithSecrets(): DryRunPlan {
  return {
    fingerprint: {
      relativePath: 'reference/finance-tracker.xlsx.xlsx',
      fileName: 'finance-tracker.xlsx.xlsx',
      sizeBytes: 268_547,
      sha256: HASH,
      modifiedAt: '2026-09-17T17:39:50.013Z',
      analyzedAt: '2026-09-18T18:18:56.465Z',
    },
    date1904: false,
    sheetNames: ['Tracker Master', 'Aug 2026', 'ELCE 25 & 26', 'French'],
    programs: [{ shortCode: 'ECEA', sourceLabels: ['ELCE'], aliased: true }],
    batches: [
      {
        sourceKey: 'k',
        programShortCode: 'PSW',
        sourceProgramLabel: 'PSW',
        name: '29th JULY, 2026 - Morning',
        code: 'Aug 2026!title@3',
        legacySheetName: 'Aug 2026',
        startDate: '2026-07-29',
        startDateReason: 'day, month and four-digit year all read from the title',
        sourceTitle: 'PSW Morning Batch - 29th JULY, 2026',
        sourceTitleRow: 3,
        sourceHeaderRow: 4,
        sourceFirstDataRow: 5,
        sourceLastDataRow: 12,
        sourceTableKey: 'title@3',
        session: 'Morning',
        sessionEvidence: 'the table title names the Morning session',
      },
    ],
    batchNameCollisions: [],
    students: [
      {
        sourceKey: 'student-key',
        studentNumber: SECRETS.studentNumber,
        legacyDisplayName: SECRETS.name,
        displayNameSource: 'Tracker Master row 42',
        firstName: 'Ramanpreet',
        middleName: null,
        lastName: 'Kaur',
        legacySource: 'Tracker Master',
        nameVariants: [
          { value: SECRETS.altName, origin: 'batch_table', sheetName: 'Aug 2026', row: 7 },
        ],
        hasNameConflict: true,
        conflictWithinOneSheet: true,
        unresolved: false,
        unresolvedOrigin: null,
        observations: [],
        legacyRawJson: { canonical_display_name: SECRETS.name },
      },
    ],
    unresolvedStudents: [],
    nameConflicts: [
      {
        studentNumber: SECRETS.studentNumber,
        distinctNames: 2,
        withinOneSheet: true,
        variants: [
          { value: SECRETS.altName, origin: 'batch_table', sheetName: 'Aug 2026', row: 7 },
        ],
      },
    ],
    financeRecords: [],
    installments: [
      {
        sourceKey: 'i',
        financeRecordSourceKey: 'r',
        installmentType: 'monthly',
        installmentMonth: null,
        monthNumber: 9,
        scheduledAmount: Number(SECRETS.amount),
        defaultNote: 'September installment',
        legacyColumnName: 'Sept',
        legacyValueText: SECRETS.amount,
        sequenceNumber: 2,
        legacySourceSheet: 'Aug 2026',
        legacySourceRow: 7,
        section: 'INSTALLMENT FEE STRUCTURE',
        legacyRawJson: {},
      },
    ],
    payments: [],
    tables: [],
    deferred: [
      {
        sheetName: 'French',
        reason: 'deferred_program_configuration',
        meaningfulRows: 3,
        rowsWithStudentNumber: 0,
      },
    ],
    unresolved: [
      {
        category: 'missing_amount',
        sheetName: 'Tracker Master',
        row: 1015,
        programShortCode: 'PSW',
        note: `no amount for ${SECRETS.name}`,
        preservedAs: 'import_exception',
        blocking: false,
      },
    ],
    errorCells: [
      {
        sheetName: 'Aug 2026',
        ref: 'A11',
        row: 11,
        error: '#REF!',
        formula: '#REF!+1',
        disposition: 'preserved as-is',
      },
    ],
    preservedDuplicateCandidates: [{ signature: `${SECRETS.studentNumber}x`, rows: [42, 43] }],
    totalsRowsExcluded: [{ sheetName: 'Aug 2026', row: 13, tableKey: 'title@3' }],
    notImportedSheets: [],
    importExceptions: [
      {
        sourceKey: 'exception-key',
        sourceFilename: 'finance-tracker.xlsx.xlsx',
        sourceSheet: 'Tracker Master',
        sourceRow: 1015,
        sourceColumn: null,
        entityType: 'payment',
        reason: 'missing_amount',
        legacyRawJson: { student_name: SECRETS.name, remarks: SECRETS.remark },
      },
    ],
    batchRowsWithoutStudentNumber: [
      { sheetName: 'Aug 2026', row: 10, tableKey: 'title@3', programShortCode: 'PSW' },
    ],
    invariantViolations: [],
    counts: {
      batches: 23,
      batchesByProgram: { PSW: 22, ECEA: 1 },
      students: 378,
      unresolvedStudents: 3,
      financeRecords: 392,
      financeRecordsBatchSpecific: 371,
      financeRecordsUnassigned: 21,
      financeRecordsByProgram: { PSW: 344, ECEA: 48 },
      installments: 1883,
      installmentsByProgram: { PSW: 1813, ECEA: 70 },
      payments: 1014,
      paymentsPlanned: 1013,
      paymentsUnresolved: 1,
      paymentRouting: {
        uniqueBatch: 972,
        ambiguousBatch: 19,
        batchNotFound: 20,
        missingStudentId: 3,
      },
      programInferredPayments: 2,
      totalsRowsExcluded: 35,
      otherRowsExcluded: 13,
      nameConflicts: 189,
      nameConflictsWithinOneSheet: 5,
      unresolvedBatchStudents: 4,
      unresolvedTrackerStudents: 3,
      importExceptions: 1,
      importExceptionsByReason: { missing_amount: 1 },
      missingAmountExceptions: 1,
      duplicateCandidateGroups: 7,
      duplicateCandidateRows: 14,
      errorCellsPreserved: 1,
      frenchRowsDeferred: 3,
    },
    readiness: {
      ready: false,
      blockers: ['1 PSW/ECEA source row(s) unresolved: missing_amount'],
      notes: [],
    },
  }
}
