import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { LAUNCH_SCOPE, TARGET_COHORTS, type TargetScope } from './config.mts'
import { cutoverWorkbook } from './fixtures.mts'
import { evaluateGates } from './gates.mts'
import { fingerprintOf, hostedFixture, IDS, payment } from './hosted-fixtures.mts'
import { parseCutoverWorkbook } from './parse.mts'
import { buildCutoverPlan, cutoverPlanHash } from './plan.mts'
import { buildTargetDataset, hostedBatchesOfCohort, targetHash } from './target.mts'

/**
 * FINANCE-CUTOVER-05A narrowed launch — PSW June, August, September 2026,
 * non-destructive outside those cohorts.
 */

const WORKBOOK = { fileName: 'fixture.xlsx', sha256: 'a'.repeat(64) }
const SCOPE: TargetScope = { id: LAUNCH_SCOPE.id, cohortIds: [...LAUNCH_SCOPE.cohortIds], preserveOutsideScope: true }

const OLD_JUNE = '00000000-0000-4000-8000-0000000001a1'
const OLD_JUNE_RECORD = '00000000-0000-4000-8000-0000000001d1'
const OLD_JUNE_DROPPED_RECORD = '00000000-0000-4000-8000-0000000001d2'
const OLD_JUNE_STUDENT = '00000000-0000-4000-8000-0000000001c1'
const DROPPED_STUDENT = '00000000-0000-4000-8000-0000000001c2'
const OLD_JUNE_INSTALLMENT = '00000000-0000-4000-8000-0000000001e1'
const OLD_JUNE_COLUMN = '00000000-0000-4000-8000-0000000001b9'

/** The base fixture plus a superseded hosted June table (one carried student, one dropped). */
function hostedWithOldJune(extraPayments: ReturnType<typeof payment>[] = []): ReturnType<typeof hostedFixture> {
  const hosted = hostedFixture()
  hosted.batches.push({ id: OLD_JUNE, program_id: IDS.psw, name: '1st June, 2026 - Morning', code: '1st June 2026!title@1', start_date: '2026-06-01', legacy_sheet_name: '1st June 2026' })
  hosted.students.push(
    { ...hosted.students[1], id: OLD_JUNE_STUDENT, student_number: '999904', first_name: 'Di', display_name: 'Di Fixture', legacy_name: 'Di Fixture' },
    { ...hosted.students[1], id: DROPPED_STUDENT, student_number: null, first_name: 'Gone', display_name: 'Gone Fixture', legacy_name: 'Gone Fixture' },
  )
  const base = hosted.student_finance_records[1]
  hosted.student_finance_records.push(
    { ...base, id: OLD_JUNE_RECORD, student_id: OLD_JUNE_STUDENT, batch_id: OLD_JUNE },
    { ...base, id: OLD_JUNE_DROPPED_RECORD, student_id: DROPPED_STUDENT, batch_id: OLD_JUNE },
  )
  hosted.installments.push({ ...hosted.installments[1], id: OLD_JUNE_INSTALLMENT, student_finance_record_id: OLD_JUNE_RECORD })
  hosted.batch_finance_columns.push({ id: OLD_JUNE_COLUMN, batch_id: OLD_JUNE })
  hosted.payments.push(...extraPayments)
  for (const record of hosted.student_finance_records) record.collection_mode = null
  return hosted
}

function scoped(hosted = hostedWithOldJune()) {
  const target = buildTargetDataset({ parsed: parseCutoverWorkbook(cutoverWorkbook()), workbook: WORKBOOK, hosted, scope: SCOPE })
  const plan = buildCutoverPlan({
    hosted,
    fingerprint: fingerprintOf(hosted),
    backup: { file: 'b.json', sha256: 'b'.repeat(64) },
    restore: { file: 'r.json', sha256: 'c'.repeat(64) },
    target,
    targetHash: targetHash(target),
    receiptNumbered: new Set(['PSW', 'ECEA']),
    scope: SCOPE,
  })
  return { hosted, target, plan }
}

describe('narrowed launch scope', () => {
  it('builds only June, August and September from the workbook, Morning and Evening as separate batches', () => {
    const { target } = scoped()
    assert.deepEqual(target.cohorts.map((cohort) => cohort.id), ['PSW-2026-06', 'PSW-2026-08', 'PSW-2026-09'])
    assert.ok(target.cohorts.every((cohort) => cohort.batchIds.length === 2))
    assert.equal(target.inserts.programs.length, 0, 'French is out of scope: no program row')
    assert.ok(target.links.every((link) => link.collectionMode === 'installment'))
    assert.ok(target.inserts.student_finance_records.every((row) => row.collection_mode === 'installment'))
  })

  it('finds the superseded hosted table of an in-scope cohort by program and month, never another year', () => {
    const hosted = hostedWithOldJune()
    const june = TARGET_COHORTS.find((cohort) => cohort.id === 'PSW-2026-06')!
    assert.deepEqual(hostedBatchesOfCohort(hosted, june).map((batch) => batch.id), [OLD_JUNE])
    const march2026 = TARGET_COHORTS.find((cohort) => cohort.id === 'PSW-2026-03')!
    assert.ok(!hostedBatchesOfCohort(hosted, march2026).some((batch) => batch.id === IDS.old2025), '17th March 2025 is not March 2026')
  })

  it('deletes only the superseded June table: its batch, records, installments and column layout', () => {
    const { plan } = scoped()
    assert.deepEqual(plan.deletes.batches, [OLD_JUNE])
    assert.deepEqual(plan.deletes.student_finance_records, [OLD_JUNE_RECORD, OLD_JUNE_DROPPED_RECORD].sort())
    assert.deepEqual(plan.deletes.installments, [OLD_JUNE_INSTALLMENT])
    assert.deepEqual(plan.deletes.batch_finance_columns, [OLD_JUNE_COLUMN])
    assert.deepEqual(plan.deletes.payments, [])
    assert.deepEqual(plan.deletes.students, [], 'no student is ever deleted by the narrowed launch')
    assert.deepEqual(plan.invariantViolations, [])
  })

  it('retains every unrelated hosted row by id: March, April, 2025, ECEA, unassigned', () => {
    const { target, hosted } = scoped()
    for (const id of [IDS.marchMorning, IDS.marchEvening, IDS.oldApril, IDS.old2025, IDS.oldEcea]) assert.ok(target.retained.batches.includes(id))
    for (const id of [IDS.marchRecord, IDS.oldAprilRecord, IDS.historicalRecord, IDS.unassignedRecord]) assert.ok(target.retained.student_finance_records.includes(id))
    for (const id of [IDS.marchPayment, IDS.oldPayment, IDS.unassignedPayment]) assert.ok(target.retained.payments.includes(id))
    assert.equal(target.retained.students.length, hosted.students.length)
  })

  it('re-uses the hosted student by exact number and keeps a dropped student row, flagged', () => {
    const { target } = scoped()
    const di = target.links.find((link) => link.studentNumber === '999904')
    assert.equal(di?.studentId, OLD_JUNE_STUDENT)
    assert.ok(target.issues.some((issue) => issue.code === 'REPLACED_RECORD_STUDENT_NOT_IN_WORKBOOK' && !issue.blocking && issue.count === 1))
    assert.ok(target.retained.students.includes(DROPPED_STUDENT))
  })

  it('expects installment on the launch records and the untouched NULL everywhere else', () => {
    const { plan, target, hosted } = scoped()
    const remaining = hosted.student_finance_records.length - plan.deletes.student_finance_records.length
    assert.deepEqual(plan.expectedCollectionModes, { NULL: remaining, installment: target.links.length })
    assert.deepEqual(plan.collectionModeUpdates, [])
    assert.deepEqual(plan.scope, SCOPE)
  })

  it('blocks when a prior-enrollment payment sits on a replaced record: its cohort is kept, so deleting it would lose money', () => {
    const prior = payment('00000000-0000-4000-8000-0000000001f9', OLD_JUNE_RECORD, 500, '2025-03-17', 'Cash', { paymentNo: '1', routing: 'ambiguous_batch', batchMonth: '2025-03' })
    const hosted = hostedWithOldJune([prior])
    // The student also has a 2025 enrollment, so the payment can be tied to it.
    hosted.student_finance_records.push({ ...hosted.student_finance_records[2], id: '00000000-0000-4000-8000-0000000001d9', student_id: OLD_JUNE_STUDENT })
    const { plan } = scoped(hosted)
    assert.ok(plan.deletes.payments.includes(prior.id))
    assert.ok(plan.invariantViolations.length > 0, 'a deleted payment that is not represented must stop the plan')
    assert.ok(plan.invariantViolations.every((line) => line.includes(prior.id)), plan.invariantViolations.join('; '))
  })

  it('is reproducible, and the full plan stays unscoped', () => {
    const a = scoped()
    const b = scoped()
    assert.equal(cutoverPlanHash(a.plan), cutoverPlanHash(b.plan))
    const hosted = hostedFixture()
    const full = buildTargetDataset({ parsed: parseCutoverWorkbook(cutoverWorkbook()), workbook: WORKBOOK, hosted })
    assert.ok(full.cohorts.length > 3)
    const fullPlan = buildCutoverPlan({ hosted, fingerprint: fingerprintOf(hosted), backup: { file: 'b', sha256: 'b'.repeat(64) }, restore: { file: 'r', sha256: 'c'.repeat(64) }, target: full, targetHash: targetHash(full), receiptNumbered: new Set(['PSW']) })
    assert.equal('scope' in fullPlan, false)
  })
})

describe('narrowed launch gate', () => {
  const { plan, hosted } = scoped()
  const hash = cutoverPlanHash(plan)
  const input = {
    apply: true,
    requestedPlanHash: hash,
    workbookSha256: '0d32527990b140d7ab587ee53841e27df87fbff50da4b09b28a9e278376a2dfe',
    backup: { present: true, ok: true, sha256: plan.backup.sha256, problems: [] },
    plannedBackupSha256: plan.backup.sha256,
    restoreSha256: plan.restore.sha256,
    plannedRestoreSha256: plan.restore.sha256,
    liveFingerprint: fingerprintOf(hosted),
    plannedPreState: plan.preState,
    recomputedPlanHash: hash,
    blockers: [],
  }

  const counts = Object.fromEntries(Object.entries(fingerprintOf(hosted).tables).map(([table, value]) => [table, value.count]))
  const baseline = { ...counts, students_email_non_null: 0, students_phone_non_null: 0 } as Parameters<typeof evaluateGates>[0]['expectedBaseline']

  it('allows only when BOTH the expected row counts and the exact pre-state fingerprint hold', () => {
    assert.equal(evaluateGates({ ...input, expectedBaseline: baseline }).allowed, true)
  })

  it('refuses on a count difference from the expected baseline', () => {
    const refused = evaluateGates({ ...input, expectedBaseline: { ...baseline!, payments: baseline!.payments + 1 } })
    assert.equal(refused.allowed, false)
    assert.ok(refused.refusals.some((refusal) => refusal.code === 'STALE_HOSTED_BASELINE' && refusal.detail.includes('payments')))
  })

  it('refuses on a changed row even when every count still matches', () => {
    const live = fingerprintOf(hosted)
    const tampered = { ...live, tables: { ...live.tables, payments: { ...live.tables.payments, rowsMd5: 'edited-row' } } }
    const refused = evaluateGates({ ...input, expectedBaseline: baseline, liveFingerprint: tampered })
    assert.equal(refused.allowed, false)
    assert.ok(refused.refusals.some((refusal) => refusal.code === 'STALE_HOSTED_BASELINE' && refusal.detail.includes('pre-state')))
  })
})
