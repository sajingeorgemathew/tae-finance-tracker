import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { reconcileDatedPayments } from './dated-payments.mts'
import { cutoverWorkbook, eceaSheet, frenchSheet, pswSheet, student, workbookFromSheets } from './fixtures.mts'
import { fingerprintOf, hostedFixture, IDS, payment, type HostedFixture } from './hosted-fixtures.mts'
import { parseCutoverWorkbook } from './parse.mts'
import { buildCutoverPlan } from './plan.mts'
import { renderApplySql } from './sql.mts'
import { buildTargetDataset, targetHash } from './target.mts'

/**
 * FINANCE-CUTOVER-05A — reconciling the dated hosted payments of students who
 * stay in the target, and the generic collection_mode the cutover writes.
 */

const parsed = parseCutoverWorkbook(cutoverWorkbook())
const WORKBOOK = { fileName: 'fixture.xlsx', sha256: 'a'.repeat(64) }
const PRIOR_RECORD = '00000000-0000-4000-8000-0000000000d9'
const PRIOR_PAYMENT = '00000000-0000-4000-8000-0000000000f9'

/** The fixture workbook with the re-used student in April only (August holds someone else). */
const aprilOnly = parseCutoverWorkbook(
  workbookFromSheets({
    '27 April 26': pswSheet('27th April 2026', [student('999901', 'Asha', 'Fixture'), student('999902', 'Bo', 'Fixture')], [student('999903', 'Cy', 'Fixture')]),
    'Aug 2026': pswSheet('29th JULY, 2026', [student('999905', 'Fa', 'Fixture')], [student('999908', 'Ivo', 'Fixture')]),
    'ELCE 25 & 26': eceaSheet(),
    French: frenchSheet(),
  }),
)

function reconcile(hosted: HostedFixture, workbook = parsed) {
  const target = buildTargetDataset({ parsed: workbook, workbook: WORKBOOK, hosted })
  const plan = buildCutoverPlan({
    hosted,
    fingerprint: fingerprintOf(hosted),
    backup: { file: 'b.json', sha256: 'b'.repeat(64) },
    restore: { file: 'r.json', sha256: 'e'.repeat(64) },
    target,
    targetHash: targetHash(target),
    receiptNumbered: new Set(['PSW', 'ECEA']),
  })
  const entries = reconcileDatedPayments({ target, hosted, deletedPaymentIds: plan.deletes.payments, receiptNumbered: new Set(['PSW', 'ECEA']) })
  return { target, plan, entries, byId: new Map(entries.map((entry) => [entry.paymentId, entry])) }
}

/** The re-used student also had a 2025 enrollment, with one payment to it. */
function withPriorEnrollment(amount: number, tracker: Parameters<typeof payment>[5]): HostedFixture {
  const hosted = hostedFixture()
  hosted.student_finance_records.push({ ...hosted.student_finance_records.find((row) => row.id === IDS.historicalRecord), id: PRIOR_RECORD, student_id: IDS.reusedStudent } as never)
  hosted.payments.push(payment(PRIOR_PAYMENT, PRIOR_RECORD, amount, '2025-04-01', 'Etransfer', tracker))
  return hosted
}

describe('dated hosted payments of target students', () => {
  it('reconciles only payments the cutover removes from a student who stays', () => {
    const { entries } = reconcile(hostedFixture())
    assert.deepEqual(entries.map((entry) => entry.paymentId).sort(), [IDS.oldPayment, IDS.unassignedPayment].sort())
  })

  it('REPRESENTED: routed to the target sheet and equal to the cell at its payment position', () => {
    const entry = reconcile(hostedFixture()).byId.get(IDS.oldPayment)
    assert.equal(entry?.class, 'REPRESENTED_IN_NEW_WORKBOOK')
    assert.equal(entry?.targetCohortId, 'PSW-2026-04', 'tied to the April record, not the same student\'s August record')
    assert.match(entry?.evidence.join(' ') ?? '', /money cell #1/)
  })

  it('REPRESENTED: fits its cell and the enrollment total when the amounts are not equal', () => {
    const entry = reconcile(hostedFixture()).byId.get(IDS.unassignedPayment)
    assert.equal(entry?.class, 'REPRESENTED_IN_NEW_WORKBOOK')
    assert.equal(entry?.preserve, false)
  })

  it('PRIOR ENROLLMENT: money of a retired cohort is not attached to the target, even when an amount happens to match a cell', () => {
    const { byId, plan } = reconcile(withPriorEnrollment(865, { paymentNo: '1', routing: 'ambiguous_batch', batchMonth: '2025-03' }))
    const entry = byId.get(PRIOR_PAYMENT)
    assert.equal(entry?.class, 'PRIOR_ENROLLMENT_NOT_TARGET_MONEY')
    assert.equal(entry?.enrollment, '17th March 2025 - Morning')
    assert.deepEqual(plan.invariantViolations, [])
  })

  it('REPRESENTED via net fee: the stated total fee minus the target fee is exactly the prior deposit', () => {
    const hosted = withPriorEnrollment(865, { paymentNo: '1', routing: 'ambiguous_batch', batchMonth: '2025-03' })
    hosted.student_finance_records = hosted.student_finance_records.map((row) => (row.id === IDS.unassignedRecord ? { ...row, legacy_total_fee: 5365 + 865 } : row))
    const entry = reconcile(hosted, aprilOnly).byId.get(PRIOR_PAYMENT)
    assert.equal(entry?.class, 'REPRESENTED_IN_NEW_WORKBOOK')
    assert.match(entry?.evidence.join(' ') ?? '', /net of it/)
    // With the student in two cohorts of equal fee the identity does not single one out: no claim is made.
    assert.equal(reconcile(hosted).byId.get(PRIOR_PAYMENT)?.class, 'PRIOR_ENROLLMENT_NOT_TARGET_MONEY')
  })

  it('NOT REPRESENTED: target-enrollment money beyond the record\'s ACTUAL total must survive, and blocks until preserved', () => {
    const hosted = hostedFixture()
    hosted.payments.push(payment('00000000-0000-4000-8000-0000000000fa', IDS.oldAprilRecord, 5000, '2026-05-02', 'Etransfer', { paymentNo: '3', routing: 'unique_batch', batchMonth: '2026-04' }))
    const { byId, plan } = reconcile(hosted)
    const entry = byId.get('00000000-0000-4000-8000-0000000000fa')
    assert.equal(entry?.class, 'NOT_REPRESENTED_IN_NEW_WORKBOOK')
    assert.equal(entry?.preserve, true)
    assert.equal(entry?.historicalReceiptCapable, true, 'number, amount, date and PSW numbering are all present')
    assert.ok(plan.invariantViolations.some((violation) => violation.includes('money the target would lose')))
  })

  it('AMBIGUOUS: no routing, no batch month, several enrollments — stops the plan', () => {
    const { byId, plan } = reconcile(withPriorEnrollment(300, { paymentNo: '9' }))
    assert.equal(byId.get(PRIOR_PAYMENT)?.class, 'AMBIGUOUS')
    assert.ok(plan.invariantViolations.some((violation) => violation.includes('cannot be reconciled')))
  })
})

describe('collection_mode', () => {
  const { target, plan } = reconcile(hostedFixture())

  it('is written on every inserted finance record with the generic value of its cohort', () => {
    assert.ok(target.inserts.student_finance_records.every((row) => ['installment', 'balance', 'configuration_incomplete'].includes(String(row.collection_mode))))
    const french = target.inserts.student_finance_records.filter((row) => row.collection_mode === 'configuration_incomplete')
    assert.equal(french.length, 2)
  })

  it('is set on the retained March records by the apply, and checked afterwards', () => {
    assert.deepEqual(plan.collectionModeUpdates, [{ mode: 'legacy_balance', ids: [IDS.marchRecord] }])
    const total = Object.values(plan.expectedCollectionModes).reduce((sum, value) => sum + value, 0)
    assert.equal(total, plan.counts.target.student_finance_records)
    const sql = renderApplySql(plan, 'c'.repeat(64), target)
    assert.match(sql, /update public\.student_finance_records set collection_mode = 'legacy_balance'\n {4}where collection_mode is null and id in/)
    assert.ok(sql.indexOf('COLLECTION_MODE_UPDATE') > sql.lastIndexOf('insert into public.student_finance_records'))
    assert.ok(sql.includes('POST_STATE_COLLECTION_MODE'))
  })
})
