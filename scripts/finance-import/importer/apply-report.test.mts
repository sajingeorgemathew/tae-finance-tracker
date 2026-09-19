/**
 * The committed apply report: its privacy guard, and its provenance.
 *
 * Two rules are tested here, and the second is the one that was learned the
 * hard way.
 *
 * 1. Privacy. The report goes into Git and is rendered from real students'
 *    finance records. Aggregates and structure only.
 * 2. Provenance. Every identifier the report states — the import batch ID, the
 *    `import_type`, the workbook hash — must come from the recorded apply and
 *    from nowhere else. A renderer that knows an identifier by heart can state
 *    an ID no import ever had, and be perfectly consistent while doing it.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import { renderApplyReport } from './apply-report.mts'
import { APPLY_OPERATOR_VERIFICATION } from './operator-verification.mts'
import { HASH, planWithSecrets, SECRETS } from './report-fixtures.mts'

import type { ApplyResult } from './apply.mts'
import type { OperatorVerification } from './operator-verification.mts'

const BATCH_ID = '00000000-1111-5222-8333-444444444444'

const HERE = path.dirname(fileURLToPath(import.meta.url))

function applyResult(overrides: Partial<ApplyResult> = {}): ApplyResult {
  return {
    importBatchId: BATCH_ID,
    importType: 'finance_workbook',
    status: 'completed',
    workbookSha256: HASH,
    namespace: { name: 'finance-import.example', uuid: '11111111-2222-5333-8444-555555555555' },
    entities: [{ table: 'payments', planned: 1013, inserted: 1013, verified: 1013, passed: true }],
    // Check names and the RLS note are authored by the importer, not built out
    // of source rows, so they are structural. What the report must not let
    // through is the plan, which is full of people.
    checks: [{ name: 'payments read back', expected: '1013', actual: '1013', passed: true }],
    counters: { rowsSeen: 3644, rowsImported: 3644, rowsSkipped: 0 },
    tableTotals: { payments: 1013, programs: 2 },
    failure: null,
    ...overrides,
  }
}

function operator(overrides: Partial<OperatorVerification> = {}): OperatorVerification {
  return { ...APPLY_OPERATOR_VERIFICATION, ...overrides }
}

function render(overrides: Partial<ApplyResult> = {}, ops = operator()): string {
  return renderApplyReport({
    result: applyResult(overrides),
    plan: planWithSecrets(),
    workbookUnchanged: true,
    appliedAt: new Date('2026-09-18T23:26:33.899Z'),
    privateOutputs: ['.private/finance-import-analysis/import-apply-result.json'],
    rls: {
      attempted: true,
      adminReadSucceeded: true,
      anonymousReadBlocked: true,
      note: 'Unauthenticated: 0 payment row(s) visible. Neither read used the service role.',
    },
    operator: ops,
  })
}

describe('nothing identifying reaches the committed apply report', () => {
  const report = render()

  it('prints no student number and no name', () => {
    assert.equal(report.includes(SECRETS.studentNumber), false)
    assert.equal(report.includes(SECRETS.name), false)
    assert.equal(report.includes(SECRETS.altName), false)
  })

  it('prints no payer, no remark and no per-person amount', () => {
    assert.equal(report.includes(SECRETS.payer), false)
    assert.equal(report.includes(SECRETS.remark), false)
    assert.equal(report.includes(SECRETS.amount), false)
  })

  it('prints no source row number for a row that carries a person', () => {
    assert.equal(/\b1015\b/.test(report), false)
  })

  it('leaks nothing through an unresolved row’s note or a preserved exception', () => {
    // Both carry source values verbatim, so the report may count them and must
    // not quote them.
    assert.equal(report.includes('no amount for'), false)
    assert.equal(report.includes('legacy_raw_json"'), false)
  })
})

describe('the apply report states only what the apply recorded', () => {
  it('takes the import batch ID from the result', () => {
    assert.equal(render().includes(`| Import batch ID | \`${BATCH_ID}\` |`), true)
  })

  it('states a different batch ID when the result carries one', () => {
    // The guard against a report that keeps saying what the last one said.
    const other = '99999999-8888-5777-8666-555555555555'
    const report = render({ importBatchId: other })
    assert.equal(report.includes(other), true)
    assert.equal(report.includes(BATCH_ID), false)
  })

  it('takes the import_type from the result rather than from the ticket', () => {
    assert.equal(render().includes('| `import_type` | `finance_workbook` |'), true)
    assert.equal(render({ importType: 'other' }).includes('| `import_type` | `other` |'), true)
  })

  it('states the workbook hash the apply recorded', () => {
    assert.equal(render().includes(HASH), true)
  })

  it('hard-codes no identifier of its own', () => {
    // Every UUID and every SHA-256 in the report must have arrived as data.
    // A renderer holding one of its own is how a stale ID survives a rerun.
    const source = readFileSync(path.join(HERE, 'apply-report.mts'), 'utf8')
    assert.equal(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(source), false)
    assert.equal(/\b[0-9a-f]{64}\b/i.test(source), false)
  })

  it('marks a failed apply as failed rather than reporting a completion', () => {
    const report = render({ status: 'failed', failure: 'transport error writing payments' })
    assert.equal(report.includes('**failed**'), true)
    assert.equal(report.includes('transport error writing payments'), true)
  })
})

describe('the operator verification is rendered, not appended', () => {
  const report = render()

  it('reports application health per route', () => {
    assert.equal(report.includes('Post-apply operator verification'), true)
    for (const route of APPLY_OPERATOR_VERIFICATION.routes) {
      assert.equal(report.includes(route.route), true, route.route)
      assert.equal(report.includes(route.result), true, route.route)
    }
  })

  it('reports the validation commands and their results', () => {
    for (const entry of APPLY_OPERATOR_VERIFICATION.validation) {
      assert.equal(report.includes(entry.command), true, entry.command)
      assert.equal(report.includes(entry.result), true, entry.command)
    }
  })

  it('reports the duplicate-import refusal', () => {
    assert.equal(report.includes(APPLY_OPERATOR_VERIFICATION.duplicateRefusal.note), true)
  })

  it('says so plainly when the refusal was never exercised', () => {
    const notExercised = render({}, operator({
      duplicateRefusal: { exercised: false, note: 'unused' },
    }))
    assert.equal(notExercised.includes('**Not exercised.**'), true)
  })

  it('reports the workbook re-hash, and calls a changed workbook changed', () => {
    assert.equal(report.includes(APPLY_OPERATOR_VERIFICATION.workbook.sha256), true)
    assert.equal(report.includes('unchanged'), true)
    const changed = render({}, operator({
      workbook: { ...APPLY_OPERATOR_VERIFICATION.workbook, unchanged: false },
    }))
    assert.equal(changed.includes('**CHANGED**'), true)
  })

  it('keeps the section numbered after the failure section when there is one', () => {
    assert.equal(render().includes('## 15. Post-apply operator verification'), true)
    const failed = render({ status: 'failed', failure: 'transport error' })
    assert.equal(failed.includes('## 15. Failure'), true)
    assert.equal(failed.includes('## 16. Post-apply operator verification'), true)
  })
})

describe('the recorded operator verification carries no person', () => {
  it('records routes, commands and hashes only', () => {
    const source = readFileSync(path.join(HERE, 'operator-verification.mts'), 'utf8')
    for (const secret of Object.values(SECRETS)) {
      assert.equal(source.includes(secret), false, secret)
    }
    // An email address among the acceptance steps would name a person.
    assert.equal(/[\w.+-]+@[\w-]+\.[\w.]+/.test(source), false)
  })
})
