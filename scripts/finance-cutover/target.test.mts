import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { cutoverWorkbook } from './fixtures.mts'
import { fingerprintOf, hostedFixture, IDS } from './hosted-fixtures.mts'
import { parseCutoverWorkbook } from './parse.mts'
import { buildCutoverPlan, cutoverPlanHash, DELETE_ORDER } from './plan.mts'
import { buildTargetDataset, frenchProgramId, targetHash, type TargetDataset } from './target.mts'

/**
 * FINANCE-CUTOVER-05A — the target dataset and the deletion plan.
 *
 * March is kept by id; the workbook cohorts are rebuilt; people are joined on
 * the exact student number and on nothing else; the plan deletes exactly what
 * no remaining row needs.
 */

const WORKBOOK = { fileName: 'fixture.xlsx', sha256: 'a'.repeat(64) }

function build(hosted = hostedFixture()): { target: TargetDataset; hosted: ReturnType<typeof hostedFixture> } {
  return { target: buildTargetDataset({ parsed: parseCutoverWorkbook(cutoverWorkbook()), workbook: WORKBOOK, hosted }), hosted }
}

describe('March preservation', () => {
  const { target } = build()

  it('retains the March batches, record, installment, payment and column layout by hosted id', () => {
    assert.deepEqual(target.retained.batches, [IDS.marchMorning, IDS.marchEvening].sort())
    assert.deepEqual(target.retained.student_finance_records, [IDS.marchRecord])
    assert.deepEqual(target.retained.installments, [IDS.marchInstallment])
    assert.deepEqual(target.retained.payments, [IDS.marchPayment])
    assert.deepEqual(target.retained.batch_finance_columns, [IDS.marchColumn])
    assert.ok(target.retained.students.includes(IDS.marchStudent))
  })

  it('re-inserts nothing of March', () => {
    const inserted = new Set(Object.values(target.inserts).flat().map((row) => row.id))
    for (const id of [IDS.marchMorning, IDS.marchRecord, IDS.marchPayment, IDS.marchInstallment, IDS.marchStudent]) assert.equal(inserted.has(id), false)
  })

  it('keeps import history and the audit trail whole', () => {
    assert.deepEqual(target.retained.import_batches, [IDS.importBatch])
    assert.deepEqual(target.retained.import_exceptions, [IDS.importException])
  })
})

describe('exact student number identity', () => {
  const { target } = build()

  it('re-uses the hosted student whose number matches exactly, once, for both cohorts it appears in', () => {
    const links = target.links.filter((link) => link.studentNumber === '999901')
    assert.deepEqual(links.map((link) => link.cohortId).sort(), ['PSW-2026-04', 'PSW-2026-08'])
    assert.ok(links.every((link) => link.studentId === IDS.reusedStudent && link.resolution === 'hosted_by_number'))
    assert.equal(target.inserts.students.filter((row) => row.student_number === '999901').length, 0)
  })

  it('never matches by name: a look-alike with another number is not re-used', () => {
    const link = target.links.find((candidate) => candidate.studentNumber === '999902')
    assert.equal(link?.resolution, 'new_numbered')
    assert.notEqual(link?.studentId, IDS.lookalike)
    assert.equal(target.retained.students.includes(IDS.lookalike), false)
  })

  it('never matches a number-less row to a number-less hosted student of the same name', () => {
    const link = target.links.find((candidate) => candidate.cohortId === 'PSW-2026-06' && candidate.studentNumber === null)
    assert.equal(link?.resolution, 'new_unnumbered')
    assert.notEqual(link?.studentId, IDS.unnumberedLookalike)
  })

  it('gives every number-less row its own student, keyed on the source row', () => {
    const unnumbered = target.links.filter((link) => link.studentNumber === null)
    assert.equal(new Set(unnumbered.map((link) => link.studentId)).size, unnumbered.length)
  })

  it('stops the plan when one number is held by two hosted students', () => {
    const hosted = hostedFixture()
    hosted.students.push({ ...hosted.students[1], id: '00000000-0000-4000-8000-0000000000cf' })
    const { target: blocked } = build(hosted)
    assert.ok(blocked.issues.some((issue) => issue.code === 'HOSTED_DUPLICATE_STUDENT_NUMBER' && issue.blocking))
  })

  it('stores student numbers as text and writes no contact', () => {
    assert.ok(target.inserts.students.every((row) => row.student_number === null || typeof row.student_number === 'string'))
    assert.ok(target.inserts.students.every((row) => row.email === null && row.phone === null))
  })
})

describe('workbook cohorts', () => {
  const { target } = build()

  it('creates one batch per table with deterministic ids and the title start date', () => {
    assert.equal(target.inserts.batches.length, 10)
    const august = target.inserts.batches.find((batch) => batch.legacy_sheet_name === 'Aug 2026')
    assert.equal(august?.start_date, '2026-07-29')
  })

  it('turns each ACTUAL money cell into one payment with no date and no method', () => {
    const asha = target.links.find((link) => link.cohortId === 'PSW-2026-04' && link.studentNumber === '999901')
    const payments = target.inserts.payments.filter((row) => row.student_finance_record_id === asha?.financeRecordId)
    assert.deepEqual(payments.map((row) => row.amount).sort((a, b) => Number(a) - Number(b)), [865, 900])
    assert.ok(payments.every((row) => row.payment_date === null && row.payment_method === null && row.installment_id === null))
  })

  it('creates installments only from the schedule section, with no invented month', () => {
    const cy = target.links.find((link) => link.studentNumber === '999903')
    assert.equal(target.inserts.installments.filter((row) => row.student_finance_record_id === cy?.financeRecordId).length, 0, 'no schedule on the row, no installments')
    assert.ok(target.inserts.installments.every((row) => row.installment_month === null && row.due_date === null))
  })

  it('leaves the date of birth out of provenance by name', () => {
    const ecea = target.inserts.student_finance_records.filter((row) => row.legacy_raw_json && (row.legacy_raw_json as { cohort_id: string }).cohort_id === 'ECEA-CURRENT')
    assert.ok(ecea.length > 0)
    for (const row of ecea) {
      const raw = row.legacy_raw_json as { cells: Record<string, unknown>; redacted_columns: { letter: string }[] }
      assert.equal('G' in raw.cells, false)
      assert.deepEqual(raw.redacted_columns.map((column) => column.letter), ['G'])
    }
  })

  it('configures French generically, with no invented receipt numbering', () => {
    assert.deepEqual(target.inserts.programs, [
      { id: frenchProgramId(), name: 'French', short_code: 'FRENCH', student_number_prefix: null, receipt_course_code: null, receipt_course_suffix: null, active: true },
    ])
    const french = target.inserts.student_finance_records.filter((row) => row.program_id === frenchProgramId())
    assert.equal(french.length, 2)
    assert.ok(french.every((row) => row.legacy_total_fee === null), 'the sheet states no fee; none is invented')
  })

  it('preserves non-student rows that carry something as import exceptions', () => {
    const reasons = target.inserts.import_exceptions.map((row) => row.reason).sort()
    assert.deepEqual(reasons, ['below_table_note', 'cell_outside_table', 'error_cell_row', 'misplaced_numeric_value', 'misplaced_numeric_value', 'placeholder_seat'])
  })
})

describe('deterministic hash', () => {
  it('is identical for identical inputs', () => {
    assert.equal(targetHash(build().target), targetHash(build().target))
  })

  it('changes when the hosted state it re-uses changes', () => {
    const hosted = hostedFixture()
    hosted.students[1] = { ...hosted.students[1], id: '00000000-0000-4000-8000-0000000000ce' }
    hosted.student_finance_records = hosted.student_finance_records.map((row) => (row.student_id === IDS.reusedStudent ? { ...row, student_id: '00000000-0000-4000-8000-0000000000ce' } : row))
    assert.notEqual(targetHash(build(hosted).target), targetHash(build().target))
  })
})

describe('deletion plan', () => {
  const { target, hosted } = build()
  const plan = buildCutoverPlan({ hosted, fingerprint: fingerprintOf(hosted), backup: { file: 'b.json', sha256: 'b'.repeat(64) }, restore: { file: 'r.sql', sha256: 'e'.repeat(64) }, target, targetHash: targetHash(target), receiptNumbered: new Set(['PSW', 'ECEA']) })

  it('removes every non-March batch and keeps March', () => {
    assert.deepEqual(plan.deletes.batches, [IDS.oldApril, IDS.old2025, IDS.oldEcea].sort())
  })

  it('removes old records, including unassigned ones, and their installments and payments', () => {
    assert.deepEqual(plan.deletes.student_finance_records, [IDS.oldAprilRecord, IDS.historicalRecord, IDS.unassignedRecord, IDS.lookalikeRecord, IDS.unnumberedRecord].sort())
    assert.deepEqual(plan.deletes.payments, [IDS.oldPayment, IDS.unassignedPayment].sort())
    assert.deepEqual(plan.deletes.installments, [IDS.oldInstallment])
    assert.deepEqual(plan.deletes.batch_finance_columns, [IDS.oldColumn])
  })

  it('keeps a student a retained or target record still uses, and deletes the rest', () => {
    const deleted = new Set<string>(plan.deletes.students)
    assert.equal(deleted.has(IDS.reusedStudent), false)
    assert.equal(deleted.has(IDS.marchStudent), false)
    assert.deepEqual(plan.deletes.students, [IDS.lookalike, IDS.unnumberedLookalike, IDS.historicalOnly].sort())
  })

  it('deletes children before parents', () => {
    assert.deepEqual([...DELETE_ORDER], ['payments', 'installments', 'student_finance_records', 'batch_finance_columns', 'batches', 'students'])
  })

  it('balances CURRENT − DELETE + INSERT (+ the audit row) = TARGET with no invariant violation', () => {
    assert.deepEqual(plan.invariantViolations, [])
    for (const table of Object.keys(plan.counts.current) as (keyof typeof plan.counts.current)[]) {
      assert.equal(plan.counts.current[table] - plan.counts.delete[table] + plan.counts.insert[table] + plan.counts.applyAudit[table], plan.counts.target[table], table)
    }
    assert.equal(plan.counts.target.audit_log, 1)
    assert.equal(plan.counts.target.programs, 3)
  })

  it('hashes deterministically and changes with the pre-state', () => {
    const again = buildCutoverPlan({ hosted, fingerprint: fingerprintOf(hosted), backup: { file: 'b.json', sha256: 'b'.repeat(64) }, restore: { file: 'r.sql', sha256: 'e'.repeat(64) }, target, targetHash: targetHash(target), receiptNumbered: new Set(['PSW', 'ECEA']) })
    assert.equal(cutoverPlanHash(plan), cutoverPlanHash(again))
    const other = buildCutoverPlan({ hosted, fingerprint: { ...fingerprintOf(hosted), studentsEmailNonNull: 1 }, backup: { file: 'b.json', sha256: 'b'.repeat(64) }, restore: { file: 'r.sql', sha256: 'e'.repeat(64) }, target, targetHash: targetHash(target), receiptNumbered: new Set(['PSW', 'ECEA']) })
    assert.notEqual(cutoverPlanHash(plan), cutoverPlanHash(other))
  })

  it('reports a backup that does not match the live fingerprint', () => {
    const fingerprint = fingerprintOf(hosted)
    const stale = { ...fingerprint, tables: { ...fingerprint.tables, payments: { ...fingerprint.tables.payments, count: 99 } } }
    const bad = buildCutoverPlan({ hosted, fingerprint: stale, backup: { file: 'b.json', sha256: 'b'.repeat(64) }, restore: { file: 'r.sql', sha256: 'e'.repeat(64) }, target, targetHash: targetHash(target), receiptNumbered: new Set(['PSW', 'ECEA']) })
    assert.ok(bad.invariantViolations.some((violation) => violation.includes('live fingerprint')))
  })
})
