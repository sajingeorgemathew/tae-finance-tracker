import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ContactImportRow } from '../finance-contact/canonical.mts'

import { assessContact, assessContacts, type ContactAssessment } from './contacts.mts'
import { conserveCohorts } from './conservation.mts'
import { cutoverWorkbook } from './fixtures.mts'
import { hostedFixture, IDS } from './hosted-fixtures.mts'
import { parseCutoverWorkbook } from './parse.mts'
import { assessCollections, assessReceipts, mapBatchSchedules, mapScheduleMonths, monthNumberOf, receiptIneligibility, receiptNumberingByProgram } from './readiness.mts'
import { buildTargetDataset } from './target.mts'

/**
 * FINANCE-CUTOVER-05A — contact enrichment, financial conservation, and the
 * collection-mode and receipt readiness analysis.
 */

function masterRow(studentNumber: string | null, overrides: Partial<ContactImportRow> = {}): ContactImportRow {
  return {
    stagedRowId: `PSW:sheet:${Math.random()}`,
    sourceWorkbook: 'master.xlsx',
    sourceSheet: 'sheet',
    sourceTable: null,
    sourceRow: 1,
    programCode: 'PSW',
    studentNumber,
    studentNumberRaw: studentNumber,
    firstName: 'Fixture',
    middleName: null,
    lastName: 'Person',
    displayName: 'Fixture Person',
    emailRaw: 'a@example.com',
    emailNormalized: 'a@example.com',
    emailStatus: 'valid',
    phoneRaw: '4165550100',
    phoneNormalized: '+14165550100',
    phoneStatus: 'valid_nanp',
    intakeLabel: null,
    intakeDate: null,
    session: null,
    sourceStartDate: null,
    sourceStatus: null,
    inOperationalScope: true,
    exclusionReason: null,
    ...overrides,
  }
}

const parsed = parseCutoverWorkbook(cutoverWorkbook())
const hosted = hostedFixture()
const target = buildTargetDataset({ parsed, workbook: { fileName: 'fixture.xlsx', sha256: 'a'.repeat(64) }, hosted })

describe('contact enrichment — exact student number only', () => {
  const rows = new Map([
    ['999901', [masterRow('999901')]],
    ['999902', [masterRow('999902', { emailNormalized: 'shared@example.com', emailRaw: 'shared@example.com' })]],
    ['999904', [masterRow('999904', { emailStatus: 'invalid', emailNormalized: null, emailRaw: 'not-an-email' })]],
    ['999905', [masterRow('999905', { emailNormalized: 'x@example.com' }), masterRow('999905', { emailNormalized: 'y@example.com' })]],
    ['999906', [masterRow('999906', { emailStatus: 'missing', emailNormalized: null, emailRaw: null })]],
  ])
  const shared = new Set(['shared@example.com'])
  const status = (number: string | null): string => assessContact({ studentId: 's', studentNumber: number }, rows, shared, new Set()).status

  it('classifies each case', () => {
    assert.equal(status('999901'), 'CONTACT_READY')
    assert.equal(status('999902'), 'CONTACT_SHARED_REVIEW')
    assert.equal(status('999904'), 'CONTACT_INVALID')
    assert.equal(status('999905'), 'CONTACT_AMBIGUOUS')
    assert.equal(status('999906'), 'CONTACT_MISSING')
    assert.equal(status('999999'), 'CONTACT_MISSING')
    assert.equal(status(null), 'MISSING_STUDENT_NUMBER')
  })

  it('does no fuzzy matching: same name, different or near-identical number → no contact', () => {
    const named = [masterRow('999901', { firstName: 'Asha', lastName: 'Fixture' })]
    const result = assessContacts(
      [
        { studentId: 'a', studentNumber: '0999901' },
        { studentId: 'b', studentNumber: '999901 ' },
        { studentId: 'c', studentNumber: '99990' },
      ],
      named,
      [],
    )
    assert.deepEqual(result.map((entry) => entry.status), ['CONTACT_MISSING', 'CONTACT_MISSING', 'CONTACT_MISSING'])
  })

  it('never looks up a student with no number, whatever the masters hold', () => {
    const result = assessContacts([{ studentId: 'x', studentNumber: null }], [masterRow(null)], [])
    assert.equal(result[0].status, 'MISSING_STUDENT_NUMBER')
    assert.equal(result[0].masterRows, 0)
  })
})

describe('financial conservation', () => {
  const conservation = conserveCohorts({ parsedTables: parsed.tables, target, hosted })
  const of = (id: string) => conservation.find((entry) => entry.cohortId === id)

  it('makes payments equal the money-received cells for every workbook cohort', () => {
    for (const entry of conservation.filter((candidate) => candidate.source === 'workbook')) {
      assert.equal(entry.paymentAmount, entry.paymentCellsAmount, entry.cohortId)
    }
    assert.equal(of('PSW-2026-04')?.paymentAmount, 865 + 900 + 865 + 900 + 900 + 100 + 865 + 900)
  })

  it('explains a totals row that includes a placeholder seat', () => {
    assert.ok(of('PSW-2026-06')?.inconsistencies.some((item) => item.code === 'TOTALS_INCLUDE_PLACEHOLDER_SEATS'))
  })

  it('flags a totals row whose Total Paid leaves out a money column (French "oct")', () => {
    const french = of('FRENCH-CURRENT')
    assert.ok(french?.inconsistencies.some((item) => item.code === 'TOTALS_ROW_MISSING_PAYMENT_COLUMN'))
    assert.ok(french?.inconsistencies.some((item) => item.code === 'TOTAL_PAID_TOTAL_OMITS_PAYMENT_COLUMN'))
    assert.equal(french?.paymentAmount, 1650)
    assert.equal(french?.sheetTotalsRowTotalPaid, 1525)
  })

  it('compares March against the hosted rows it is preserved from', () => {
    const march = of('PSW-2026-03')
    assert.equal(march?.studentRecords, 1)
    assert.equal(march?.paymentAmount, 1765)
  })
})

describe('schedule month mapping', () => {
  it('reads month labels', () => {
    assert.equal(monthNumberOf('September'), 9)
    assert.equal(monthNumberOf('Sept'), 9)
    assert.equal(monthNumberOf('Enroll. Fee'), null)
  })

  it('places months on or after the start month and rolls the year forward in column order', () => {
    assert.deepEqual(mapScheduleMonths('2026-04', [9, 10, 11, 12, 1]).months, ['2026-09', '2026-10', '2026-11', '2026-12', '2027-01'])
    assert.deepEqual(mapScheduleMonths('2026-03', [12, 1, 2]).months, ['2026-12', '2027-01', '2027-02'])
    assert.deepEqual(mapScheduleMonths('2026-09', [9, 10]).months, ['2026-09', '2026-10'])
  })

  it('refuses a mapping that is not deterministic', () => {
    assert.equal(mapScheduleMonths(null, [9]).deterministic, false)
    assert.equal(mapScheduleMonths('2026-04', [9, null]).deterministic, false)
    assert.equal(mapScheduleMonths('2026-04', [9, 9]).deterministic, false)
    assert.equal(mapScheduleMonths('2026-05', [5, 4, 6]).deterministic, false, 'ends more than twelve months after the start')
  })

  it('maps every schedule column of every installment batch, and only those', () => {
    const mappings = mapBatchSchedules(target, hosted)
    assert.ok(mappings.every((mapping) => mapping.cohortId.startsWith('PSW-2026-') && mapping.cohortId !== 'PSW-2026-03'))
    const april = mappings.find((mapping) => mapping.batchName === '27th April 2026 - Morning')
    assert.equal(april?.deterministic, true)
    assert.deepEqual(april?.columns.map((column) => [column.header, column.yearMonth]), [['Enroll. Fee', '2026-04'], ['September', '2026-09'], ['October', '2026-10']])
  })
})

describe('collection readiness by mode', () => {
  const contacts = (notReady: readonly string[] = []): ContactAssessment[] =>
    [...new Set(target.links.map((link) => link.studentId))].map((studentId) => ({
      studentId,
      studentNumber: null,
      status: notReady.includes(studentId) ? 'MISSING_STUDENT_NUMBER' : 'CONTACT_READY',
      reason: '',
      masterRows: 1,
      masterPrograms: ['PSW'],
      phone: 'valid',
      email: null,
      phoneNormalized: null,
    }))
  const run = (asOf: string, notReady: readonly string[] = []) =>
    assessCollections({ target, hosted, contacts: contacts(notReady), asOf, mappings: mapBatchSchedules(target, hosted) })
  const of = (entries: ReturnType<typeof run>, number: string | null, cohort: string) => {
    const link = target.links.find((candidate) => candidate.studentNumber === number && candidate.cohortId === cohort)
    return entries.find((entry) => entry.financeRecordId === link?.financeRecordId)
  }
  const october = run('2026-10-21')

  it('normal mode: scheduled through the current month minus paid, never remaining tuition', () => {
    const asha = of(october, '999901', 'PSW-2026-04')
    assert.equal(asha?.mode, 'installment')
    assert.equal(asha?.throughMonth, '2026-10')
    assert.equal(asha?.scheduledThroughMonth, 865 + 900 + 900)
    assert.equal(asha?.amountDue, 900)
    assert.equal(asha?.status, 'AMOUNT_DUE_THROUGH_MONTH')
    assert.equal(asha?.reminderKind, 'AMOUNT_DUE_THROUGH_MONTH')
  })

  it('normal mode: a late fee paid is real money but does not pay the schedule', () => {
    const bo = of(october, '999902', 'PSW-2026-04')
    assert.equal(bo?.lateFeesPaid, 100)
    assert.equal(bo?.paidApplied, 2665)
    assert.equal(bo?.status, 'CURRENT')
    assert.deepEqual(bo?.flags, ['LATE_FEES_PAID_NOT_APPLIED'])
  })

  it('normal mode: paid beyond the schedule so far is credit/ahead', () => {
    assert.equal(of(run('2026-08-15'), '999901', 'PSW-2026-04')?.status, 'CREDIT_AHEAD')
  })

  it('normal mode: a row with no schedule cannot be determined', () => {
    const cy = of(october, '999903', 'PSW-2026-04')
    assert.equal(cy?.status, 'CANNOT_DETERMINE')
    assert.equal(cy?.calculable, false)
  })

  it('legacy mode (March): the preserved balance snapshot, never the incomplete ledger', () => {
    const march = october.find((entry) => entry.cohortId === 'PSW-2026-03')
    assert.equal(march?.mode, 'legacy_balance')
    assert.equal(march?.balanceOutstanding, 3600, 'legacy_balance −3600 (paid − fee) is 3600 owed')
    assert.equal(march?.reminderKind, 'LEGACY_BALANCE_REMINDER')
    assert.deepEqual(march?.flags, ['LEGACY_LEDGER_INCOMPLETE'])
  })

  it('balance mode (ECEA): stated fee minus recorded payments; no fee, no figure', () => {
    const ecea = october.filter((entry) => entry.cohortId === 'ECEA-CURRENT')
    assert.ok(ecea.every((entry) => entry.mode === 'balance'))
    assert.deepEqual(ecea.map((entry) => entry.status).sort(), ['BALANCE_OUTSTANDING', 'BALANCE_SETTLED', 'CANNOT_DETERMINE'])
    assert.equal(ecea.find((entry) => entry.status === 'BALANCE_OUTSTANDING')?.balanceOutstanding, 1130)
  })

  it('French: blocked/manual, configuration and contact incomplete, never a reminder', () => {
    const frenchStudents = target.links.filter((link) => link.cohortId === 'FRENCH-CURRENT').map((link) => link.studentId)
    const french = run('2026-10-21', frenchStudents).filter((entry) => entry.cohortId === 'FRENCH-CURRENT')
    assert.equal(french.length, 2)
    for (const entry of french) {
      assert.equal(entry.status, 'BLOCKED_MANUAL')
      assert.equal(entry.reminderKind, null)
      assert.deepEqual(entry.flags, ['FINANCE_CONFIGURATION_INCOMPLETE', 'CONTACT_INCOMPLETE'])
    }
  })

  it('carries the cohort mode on every target record', () => {
    assert.deepEqual([...new Set(target.links.map((link) => link.collectionMode))].sort(), ['balance', 'configuration_incomplete', 'installment', 'legacy_balance'])
  })
})

describe('receipt eligibility', () => {
  const receipts = assessReceipts({ target, hosted })
  const psw = { student_number_prefix: '125', receipt_course_code: '12500', receipt_course_suffix: '25' }

  it('makes no payment the cutover carries eligible: no retroactive receipts', () => {
    assert.ok(receipts.length > 0)
    assert.ok(receipts.every((receipt) => !receipt.eligible && receipt.ineligibility.join() === 'HISTORICAL_PAYMENT'))
  })

  it('records why a historical payment could never have had a receipt anyway', () => {
    const march = receipts.find((receipt) => receipt.paymentId === IDS.marchPayment)
    assert.deepEqual(march?.historicalGaps, ['LEGACY_LEDGER_INCOMPLETE'])
    const workbook = receipts.filter((receipt) => receipt.paymentId !== IDS.marchPayment)
    assert.ok(workbook.every((receipt) => receipt.historicalGaps.includes('NO_PAYMENT_DATE') && receipt.historicalGaps.includes('NO_PAYMENT_METHOD')))
  })

  it('lets a new dated payment be eligible without a method, and refuses one without a date or numbering', () => {
    const fresh = { source: 'manual', amount: 900, payment_date: '2026-11-02' }
    assert.deepEqual(receiptIneligibility({ payment: fresh, hasStudent: true, hasFinanceRecord: true, program: psw }), [])
    assert.deepEqual(receiptIneligibility({ payment: { ...fresh, payment_date: null }, hasStudent: true, hasFinanceRecord: true, program: psw }), ['MISSING_PAYMENT_DATE'])
    assert.deepEqual(
      receiptIneligibility({ payment: fresh, hasStudent: true, hasFinanceRecord: true, program: { student_number_prefix: null, receipt_course_code: null, receipt_course_suffix: null } }),
      ['MISSING_PROGRAM_RECEIPT_NUMBERING'],
    )
  })

  it('reports which programs have receipt numbering', () => {
    assert.deepEqual(receiptNumberingByProgram(target, hosted), [
      { shortCode: 'ECEA', configured: true },
      { shortCode: 'FRENCH', configured: false },
      { shortCode: 'PSW', configured: true },
    ])
  })
})
