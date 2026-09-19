/**
 * The privacy guard on the committed dry-run report.
 *
 * The report goes into Git and is rendered from a plan built out of real
 * students' finance records, so what reaches it is worth a test of its own.
 * The rule is that only aggregates and structure are printed: no student
 * number, no name, no payer, no remark, no per-person amount, and no source row
 * number — a row number plus the workbook identifies a person just as surely as
 * a name does.
 *
 * The plan the tests render is deliberately stuffed with values that must NOT
 * appear; it lives in `report-fixtures.mts`, shared with the apply report's
 * test so both committed reports are held to one rule.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { renderDryRunReport } from './dry-run-report.mts'
import { emptyCounts, HASH, planWithSecrets, priorImport, SECRETS } from './report-fixtures.mts'

function render(): string {
  return renderDryRunReport({
    plan: planWithSecrets(),
    countsBefore: emptyCounts(),
    countsAfter: emptyCounts(),
    priorImport: priorImport(),
    workbookUnchanged: true,
    privateOutputs: [],
  })
}

describe('nothing identifying reaches the committed dry-run report', () => {
  it('prints no student number', () => {
    assert.equal(render().includes(SECRETS.studentNumber), false)
  })

  it('prints no student name, in any spelling', () => {
    const report = render()
    assert.equal(report.includes(SECRETS.name), false)
    assert.equal(report.includes(SECRETS.altName), false)
  })

  it('prints no payer name and no remark', () => {
    const report = render()
    assert.equal(report.includes(SECRETS.payer), false)
    assert.equal(report.includes(SECRETS.remark), false)
  })

  it('prints no amount attributable to a person', () => {
    assert.equal(render().includes(SECRETS.amount), false)
  })

  it('prints no source row number for a row that carries a person', () => {
    const report = render()
    // The unresolved row is row 1015 and the duplicate candidates are rows
    // 42/43. Only the aggregate count may appear.
    assert.equal(/\b1015\b/.test(report), false)
    assert.equal(/\brow 42\b/.test(report), false)
  })

  it('leaks nothing through an unresolved row’s note', () => {
    // The note is built by the importer and can quote a source value, so the
    // report must summarise unresolved rows rather than print their notes.
    assert.equal(render().includes('no amount for'), false)
  })
})

describe('the report still says what a reviewer needs', () => {
  const report = render()

  it('states the workbook hash and the sheet names verbatim', () => {
    assert.equal(report.includes(HASH), true)
    assert.equal(report.includes('ELCE 25 & 26'), true)
  })

  it('states the planned counts', () => {
    assert.equal(/\b378\b/.test(report), true)
    assert.equal(/\b1013\b/.test(report), true)
    assert.equal(/\b1883\b/.test(report), true)
  })

  it('states the routing breakdown', () => {
    for (const count of ['972', '19', '20', '3']) {
      assert.equal(report.includes(count), true, count)
    }
  })

  it('states READY_FOR_APPLY and why', () => {
    assert.equal(report.includes('READY_FOR_APPLY=false'), true)
    assert.equal(report.includes('missing_amount'), true)
  })

  it('states the French deferral', () => {
    assert.equal(report.includes('deferred_program_configuration'), true)
  })

  it('names the structural cells that carry no student', () => {
    // A batch title and the #REF! cell are layout facts, not people.
    assert.equal(report.includes('PSW Morning Batch - 29th JULY, 2026'), true)
    assert.equal(report.includes('#REF!'), true)
  })
})
