/**
 * The plan's internal consistency checks.
 *
 * These guard properties no single planner can guarantee alone — they only hold
 * once everything has been assembled. Getting one wrong would surface as a
 * foreign-key violation partway through a real import, which is the worst place
 * to find out.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { assessReadiness, validatePlanInvariants } from './plan.mts'

import type { PlannedFinanceRecord } from './finance-records.mts'
import type { PlannedImportException } from './exceptions.mts'
import type { PlannedInstallment } from './installments.mts'
import type { PlannedPayment } from './payments.mts'
import type { PlannedStudent } from './students.mts'

function student(sourceKey: string): PlannedStudent {
  return {
    sourceKey,
    studentNumber: '125001',
    legacyDisplayName: 'A Student',
    displayNameSource: 'fixture',
    firstName: null,
    middleName: null,
    lastName: null,
    legacySource: 'fixture',
    nameVariants: [],
    hasNameConflict: false,
    conflictWithinOneSheet: false,
    unresolved: false,
    unresolvedOrigin: null,
    observations: [],
    legacyRawJson: {},
  }
}

function record(sourceKey: string, studentSourceKey: string): PlannedFinanceRecord {
  const blank = {
    value: null,
    sourceColumnLetter: null,
    sourceHeader: null,
    rawValue: null,
    formula: null,
    note: null,
  }
  return {
    sourceKey,
    studentSourceKey,
    studentNumber: '125001',
    programShortCode: 'PSW',
    batchSourceKey: 'batch',
    legacyTotalFee: blank,
    legacyTotalPaid: blank,
    legacyBalance: blank,
    legacySourceSheet: 'Dec 2025',
    legacySourceRow: 3,
    legacyRawJson: {},
    kind: 'batch',
  }
}

function payment(
  sourceKey: string,
  financeRecordSourceKey: string | null,
  amount: number | null,
  unresolved: PlannedPayment['unresolved'] = null,
): PlannedPayment {
  return {
    sourceKey,
    financeRecordSourceKey,
    plansPayment: unresolved === null,
    studentSourceKey: 'student',
    studentNumber: '125001',
    programShortCode: 'PSW',
    sourceProgramLabel: 'PSW',
    programInferred: false,
    amount,
    paymentDate: null,
    paymentMethod: null,
    payerName: null,
    reference: null,
    note: null,
    source: 'legacy_import',
    legacySourceSheet: 'Tracker Master',
    legacySourceRow: 2,
    legacyRawJson: {},
    routing: 'unique_batch',
    routingNote: '',
    unresolved,
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
    defaultNote: 'May installment',
    legacyColumnName: 'May',
    legacyValueText: '100',
    sequenceNumber: 1,
    legacySourceSheet: 'Dec 2025',
    legacySourceRow: 3,
    section: 'INSTALLMENT FEE STRUCTURE',
    legacyRawJson: {},
  }
}

function exception(sourceKey: string, row: number): PlannedImportException {
  return {
    sourceKey,
    sourceFilename: 'finance-tracker.xlsx.xlsx',
    sourceSheet: 'Tracker Master',
    sourceRow: row,
    sourceColumn: null,
    entityType: 'payment',
    reason: 'missing_amount',
    legacyRawJson: { row },
  }
}

const consistent = {
  students: [student('student')],
  unresolvedStudents: [],
  financeRecords: [record('record', 'student')],
  payments: [payment('payment', 'record', 500)],
  installments: [installment('installment', 'record')],
  importExceptions: [],
}

describe('a consistent plan reports no violations', () => {
  it('accepts a plan whose references all resolve', () => {
    assert.deepEqual(validatePlanInvariants(consistent), [])
  })

  it('accepts an unresolved payment preserved as an import exception', () => {
    // The row plans no payment, but it has a destination, so nothing is lost.
    const violations = validatePlanInvariants({
      ...consistent,
      payments: [payment('payment', null, null, 'missing_amount')],
      importExceptions: [exception('exception', 2)],
    })
    assert.deepEqual(violations, [])
  })
})

describe('violations an apply would otherwise discover mid-import', () => {
  it('catches a planned payment with no amount', () => {
    const violations = validatePlanInvariants({
      ...consistent,
      payments: [payment('payment', 'record', null)],
    })
    assert.match(violations.join('\n'), /carry no amount/)
  })

  it('catches a payment pointing at a record that was never planned', () => {
    const violations = validatePlanInvariants({
      ...consistent,
      payments: [payment('payment', 'missing-record', 500)],
    })
    assert.match(violations.join('\n'), /reference no planned finance record/)
  })

  it('catches an installment pointing at a record that was never planned', () => {
    const violations = validatePlanInvariants({
      ...consistent,
      installments: [installment('installment', 'missing-record')],
    })
    assert.match(violations.join('\n'), /installment\(s\) reference no planned finance record/)
  })

  it('catches a record pointing at a student that was never planned', () => {
    const violations = validatePlanInvariants({
      ...consistent,
      financeRecords: [record('record', 'missing-student')],
    })
    assert.match(violations.join('\n'), /reference no planned student/)
  })

  it('catches a transaction row that becomes neither a payment nor an exception', () => {
    // The "no silent dropping" rule, checked rather than assumed.
    const violations = validatePlanInvariants({
      ...consistent,
      payments: [payment('payment', null, null, 'missing_amount')],
      importExceptions: [],
    })
    assert.match(violations.join(' '), /neither a payment nor an import exception/)
  })

  it('catches a duplicate exception source key', () => {
    const violations = validatePlanInvariants({
      ...consistent,
      payments: [payment('payment', null, null, 'missing_amount')],
      importExceptions: [exception('same', 2), exception('same', 3)],
    })
    assert.match(violations.join(' '), /duplicate source key\(s\) among import exceptions/)
  })

  it('catches a duplicate source key, which would break idempotency', () => {
    // Two rows sharing a key means a re-run skips one it never imported.
    const violations = validatePlanInvariants({
      ...consistent,
      payments: [payment('same', 'record', 500), payment('same', 'record', 300)],
    })
    assert.match(violations.join('\n'), /duplicate source key/)
  })
})

describe('readiness', () => {
  const counts = { frenchRowsDeferred: 0 } as never

  it('is false whenever an invariant is violated', () => {
    const readiness = assessReadiness(counts, [], [], ['1 planned payment(s) carry no amount'])
    assert.equal(readiness.ready, false)
    assert.match(readiness.blockers.join('\n'), /internally inconsistent/)
  })

  it('is false when a PSW/ECEA row has no destination at all', () => {
    const readiness = assessReadiness(
      counts,
      [
        {
          category: 'batch_row_without_resolvable_student',
          sheetName: 'Dec 2025',
          row: 12,
          programShortCode: 'PSW',
          note: '',
          preservedAs: null,
          blocking: true,
        },
      ],
      [],
    )
    assert.equal(readiness.ready, false)
  })

  it('is true when an unsafe row is deliberately preserved as an exception', () => {
    // A row with a destination is not a silent drop, so it does not block.
    const readiness = assessReadiness(
      counts,
      [
        {
          category: 'missing_amount',
          sheetName: 'Tracker Master',
          row: 1015,
          programShortCode: 'PSW',
          note: 'preserved as an import exception',
          preservedAs: 'import_exception',
          blocking: false,
        },
      ],
      [],
    )

    assert.equal(readiness.ready, true)
    assert.match(readiness.notes.join(' '), /preserved as import exceptions/)
  })

  it('is not made false by a deferral under an approved rule', () => {
    const readiness = assessReadiness({ frenchRowsDeferred: 3 } as never, [], [])
    assert.equal(readiness.ready, true)
    assert.match(readiness.notes.join('\n'), /French/)
  })

  it('is false when two batches of one program would share a name', () => {
    const readiness = assessReadiness(counts, [], [{ name: 'December - Evening' }])
    assert.equal(readiness.ready, false)
    assert.match(readiness.blockers.join('\n'), /batches_program_name_key/)
  })
})
