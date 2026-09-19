/**
 * The mapping from plan to database rows.
 *
 * These tests guard the properties that make the apply safe to run against
 * production: that no value is invented, that relationships are built from
 * derived ids rather than read back, and that the two student lists both land
 * in one table without ever merging.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildApplyRows, findDuplicateIds, idsOf, PlanMappingError } from './apply-rows.mts'
import { entityId, UUID_V5_PATTERN } from './deterministic-ids.mts'

import type { DryRunPlan } from './plan.mts'
import type { PlannedFinanceRecord } from './finance-records.mts'
import type { PlannedImportException } from './exceptions.mts'
import type { PlannedInstallment } from './installments.mts'
import type { PlannedPayment } from './payments.mts'
import type { PlannedStudent } from './students.mts'

const PROGRAMS = new Map([
  ['PSW', '635e3c1c-95f5-4462-87f3-265dc1441870'],
  ['ECEA', 'a21b7c6e-870c-4aca-8908-63210e8e9cca'],
])
const IMPORT_BATCH = '00000000-0000-5000-8000-000000000001'

const blankCell = {
  value: null,
  sourceColumnLetter: null,
  sourceHeader: null,
  rawValue: null,
  formula: null,
  note: null,
}

function student(sourceKey: string, studentNumber: string | null): PlannedStudent {
  return {
    sourceKey,
    studentNumber,
    legacyDisplayName: 'A Student',
    displayNameSource: 'fixture',
    firstName: 'A',
    middleName: null,
    lastName: 'Student',
    legacySource: 'fixture',
    nameVariants: [],
    hasNameConflict: false,
    conflictWithinOneSheet: false,
    unresolved: studentNumber === null,
    unresolvedOrigin: studentNumber === null ? 'tracker_master' : null,
    observations: [],
    legacyRawJson: { source_key: sourceKey },
  }
}

function record(
  sourceKey: string,
  studentSourceKey: string,
  batchSourceKey: string | null,
  programShortCode = 'PSW',
): PlannedFinanceRecord {
  return {
    sourceKey,
    studentSourceKey,
    studentNumber: '125001',
    programShortCode,
    batchSourceKey,
    legacyTotalFee: { ...blankCell, value: 5600 },
    legacyTotalPaid: blankCell,
    legacyBalance: blankCell,
    legacySourceSheet: 'Dec 2025',
    legacySourceRow: 3,
    legacyRawJson: {},
    kind: batchSourceKey === null ? 'unassigned' : 'batch',
  }
}

function payment(
  sourceKey: string,
  financeRecordSourceKey: string | null,
  plansPayment: boolean,
): PlannedPayment {
  return {
    sourceKey,
    financeRecordSourceKey,
    plansPayment,
    studentSourceKey: 'student-a',
    studentNumber: '125001',
    programShortCode: 'PSW',
    sourceProgramLabel: 'PSW',
    programInferred: false,
    amount: plansPayment ? 500 : null,
    paymentDate: '2025-05-07',
    paymentMethod: 'e-transfer ',
    payerName: null,
    reference: '1',
    note: null,
    source: 'legacy_import',
    legacySourceSheet: 'Tracker Master',
    legacySourceRow: 2,
    legacyRawJson: {},
    routing: 'unique_batch',
    routingNote: '',
    unresolved: plansPayment ? null : 'missing_amount',
    unresolvedNote: null,
  }
}

function installment(sourceKey: string, financeRecordSourceKey: string): PlannedInstallment {
  return {
    sourceKey,
    financeRecordSourceKey,
    installmentType: 'monthly',
    installmentMonth: null,
    monthNumber: 5,
    scheduledAmount: 100,
    defaultNote: '5th installment',
    legacyColumnName: '5th Inst.',
    legacyValueText: ' $100 ',
    sequenceNumber: 6,
    legacySourceSheet: 'Dec 2025',
    legacySourceRow: 3,
    section: 'INSTALLMENT FEE STRUCTURE',
    legacyRawJson: {},
  }
}

function exception(sourceKey: string): PlannedImportException {
  return {
    sourceKey,
    sourceFilename: 'finance-tracker.xlsx.xlsx',
    sourceSheet: 'Tracker Master',
    sourceRow: 1015,
    sourceColumn: null,
    entityType: 'payment',
    reason: 'missing_amount',
    legacyRawJson: { row: 1015 },
  }
}

function planOf(overrides: Partial<DryRunPlan>): DryRunPlan {
  return {
    batches: [
      {
        sourceKey: 'batch-a',
        programShortCode: 'PSW',
        sourceProgramLabel: 'PSW',
        name: 'Dec 2025 - Morning',
        code: 'Dec 2025!title@1',
        legacySheetName: 'Dec 2025',
        startDate: '2025-12-01',
        startDateReason: 'fixture',
        sourceTitle: 'PSW Morning Batch',
        sourceTitleRow: 1,
        sourceHeaderRow: 2,
        sourceFirstDataRow: 3,
        sourceLastDataRow: 4,
        sourceTableKey: 'title@1',
        session: 'Morning',
        sessionEvidence: 'fixture',
      },
    ],
    students: [student('student-a', '125001')],
    unresolvedStudents: [student('unresolved-a', null)],
    financeRecords: [record('record-a', 'student-a', 'batch-a')],
    installments: [installment('installment-a', 'record-a')],
    payments: [payment('payment-a', 'record-a', true)],
    importExceptions: [exception('exception-a')],
    ...overrides,
  } as DryRunPlan
}

describe('buildApplyRows', () => {
  it('derives every primary key from the source key', () => {
    const rows = buildApplyRows(planOf({}), PROGRAMS, IMPORT_BATCH)

    assert.equal(rows.batches[0].id, entityId('batch-a'))
    assert.equal(rows.financeRecords[0].id, entityId('record-a'))
    assert.equal(rows.payments[0].id, entityId('payment-a'))
    assert.equal(rows.installments[0].id, entityId('installment-a'))
    assert.equal(rows.importExceptions[0].id, entityId('exception-a'))
  })

  it('builds relationships without reading anything back', () => {
    const rows = buildApplyRows(planOf({}), PROGRAMS, IMPORT_BATCH)

    assert.equal(rows.financeRecords[0].student_id, entityId('student-a'))
    assert.equal(rows.financeRecords[0].batch_id, entityId('batch-a'))
    assert.equal(rows.payments[0].student_finance_record_id, entityId('record-a'))
    assert.equal(rows.installments[0].student_finance_record_id, entityId('record-a'))
  })

  it('is byte-identical across two builds of the same plan', () => {
    const first = buildApplyRows(planOf({}), PROGRAMS, IMPORT_BATCH)
    const second = buildApplyRows(planOf({}), PROGRAMS, IMPORT_BATCH)
    assert.deepEqual(first, second)
  })

  it('puts numbered and unresolved students in one table without merging them', () => {
    const rows = buildApplyRows(planOf({}), PROGRAMS, IMPORT_BATCH)

    assert.equal(rows.students.length, 2)
    assert.equal(rows.students.filter((row) => row.student_number === null).length, 1)
    assert.equal(new Set(idsOf(rows.students)).size, 2)
  })

  it('never manufactures a student number for an unresolved row', () => {
    const rows = buildApplyRows(planOf({}), PROGRAMS, IMPORT_BATCH)
    const unresolved = rows.students.find((row) => row.id === entityId('unresolved-a'))
    assert.equal(unresolved?.student_number, null)
  })

  it('leaves an approved unassigned record without a batch rather than guessing one', () => {
    const plan = planOf({ financeRecords: [record('record-u', 'student-a', null)] })
    const rows = buildApplyRows(plan, PROGRAMS, IMPORT_BATCH)
    assert.equal(rows.financeRecords[0].batch_id, null)
  })

  it('writes the historical payment method spelling untouched', () => {
    const rows = buildApplyRows(planOf({}), PROGRAMS, IMPORT_BATCH)
    assert.equal(rows.payments[0].payment_method, 'e-transfer ')
  })

  it('marks every payment as a legacy import', () => {
    const rows = buildApplyRows(planOf({}), PROGRAMS, IMPORT_BATCH)
    assert.equal(rows.payments[0].source, 'legacy_import')
  })

  it('does not create a payment for a row the plan did not plan one for', () => {
    const plan = planOf({
      payments: [payment('payment-a', 'record-a', true), payment('payment-b', null, false)],
    })
    const rows = buildApplyRows(plan, PROGRAMS, IMPORT_BATCH)

    assert.equal(rows.payments.length, 1)
    assert.equal(rows.payments[0].id, entityId('payment-a'))
  })

  it('never invents a zero amount', () => {
    const plan = planOf({ payments: [payment('payment-b', null, false)] })
    const rows = buildApplyRows(plan, PROGRAMS, IMPORT_BATCH)
    assert.equal(rows.payments.length, 0)
  })

  it('leaves an installment with no calendar month absent rather than zero', () => {
    const rows = buildApplyRows(planOf({}), PROGRAMS, IMPORT_BATCH)
    assert.equal(rows.installments[0].installment_month, null)
  })

  it('stamps the import batch onto every exception', () => {
    const rows = buildApplyRows(planOf({}), PROGRAMS, IMPORT_BATCH)
    assert.equal(rows.importExceptions[0].import_batch_id, IMPORT_BATCH)
    assert.equal(rows.importExceptions[0].source_key, 'exception-a')
  })

  it('refuses to invent a program rather than creating one', () => {
    const plan = planOf({
      financeRecords: [record('record-f', 'student-a', null, 'FRENCH')],
    })
    assert.throws(() => buildApplyRows(plan, PROGRAMS, IMPORT_BATCH), PlanMappingError)
  })

  it('refuses a planned payment with nowhere to attach', () => {
    const plan = planOf({ payments: [payment('payment-c', null, true)] })
    assert.throws(() => buildApplyRows(plan, PROGRAMS, IMPORT_BATCH), PlanMappingError)
  })

  it('gives every row a valid PostgreSQL uuid', () => {
    const rows = buildApplyRows(planOf({}), PROGRAMS, IMPORT_BATCH)
    const all = [
      ...idsOf(rows.batches),
      ...idsOf(rows.students),
      ...idsOf(rows.financeRecords),
      ...idsOf(rows.installments),
      ...idsOf(rows.payments),
      ...idsOf(rows.importExceptions),
    ]
    for (const id of all) assert.match(id, UUID_V5_PATTERN)
  })

  it('keeps ids distinct across every entity class', () => {
    const rows = buildApplyRows(planOf({}), PROGRAMS, IMPORT_BATCH)
    const all = [
      ...idsOf(rows.batches),
      ...idsOf(rows.students),
      ...idsOf(rows.financeRecords),
      ...idsOf(rows.installments),
      ...idsOf(rows.payments),
      ...idsOf(rows.importExceptions),
    ]
    assert.equal(new Set(all).size, all.length)
  })
})

describe('findDuplicateIds', () => {
  it('finds none in a well-formed class', () => {
    assert.deepEqual(findDuplicateIds([{ id: 'a' }, { id: 'b' }]), [])
  })

  it('names a repeated id, because an upsert would hide it', () => {
    assert.deepEqual(findDuplicateIds([{ id: 'a' }, { id: 'b' }, { id: 'a' }]), ['a'])
  })
})
