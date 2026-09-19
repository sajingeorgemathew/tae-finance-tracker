/**
 * The safety gate.
 *
 * Each test here corresponds to a way the apply could write historical finance
 * data it should not have. The gate has no override, so a test that passes
 * wrongly is the only way past it.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  APPROVED_WORKBOOK_SHA256,
  MUST_BE_EMPTY_BEFORE_APPLY,
  REVIEWED_BASELINE,
  runPreflight,
} from './apply-preflight.mts'

import type { DryRunPlan } from './plan.mts'
import type { PreflightInputs } from './apply-preflight.mts'

const SCHEMA_PRESENT = {
  '20260917143000_finance_foundation': true,
  '20260917150000_initial_program_configuration': true,
  'students.legacy_raw_json': true,
  'student_finance_records.legacy_raw_json': true,
  'installments.legacy_raw_json': true,
  'public.import_exceptions': true,
}

/** A plan whose regenerated counts match the reviewed baseline exactly. */
function planAtBaseline(): DryRunPlan {
  return {
    fingerprint: { sha256: APPROVED_WORKBOOK_SHA256, fileName: 'finance-tracker.xlsx.xlsx' },
    readiness: { ready: true, blockers: [], notes: [] },
    invariantViolations: [],
    deferred: [
      {
        sheetName: 'French',
        reason: 'deferred_program_configuration',
        meaningfulRows: REVIEWED_BASELINE.frenchRowsDeferred,
        rowsWithStudentNumber: 0,
      },
    ],
    counts: {
      batches: REVIEWED_BASELINE.batches,
      batchesByProgram: { PSW: REVIEWED_BASELINE.pswBatches, ECEA: REVIEWED_BASELINE.eceaBatches },
      students: REVIEWED_BASELINE.numberedStudents,
      unresolvedStudents: REVIEWED_BASELINE.unresolvedStudents,
      financeRecords: REVIEWED_BASELINE.financeRecords,
      payments: REVIEWED_BASELINE.trackerMasterTransactionRows,
      paymentsPlanned: REVIEWED_BASELINE.payments,
      importExceptions: REVIEWED_BASELINE.importExceptions,
      installmentsByProgram: {
        PSW: REVIEWED_BASELINE.pswInstallments,
        ECEA: REVIEWED_BASELINE.eceaInstallments,
      },
      frenchRowsDeferred: REVIEWED_BASELINE.frenchRowsDeferred,
    },
  } as unknown as DryRunPlan
}

function inputs(overrides: Partial<PreflightInputs> = {}): PreflightInputs {
  return {
    plan: planAtBaseline(),
    workbookSha256: APPROVED_WORKBOOK_SHA256,
    branch: 'feature/finance-import-02',
    gitStatusLines: [],
    schemaPresence: { ...SCHEMA_PRESENT },
    countsBefore: Object.fromEntries(MUST_BE_EMPTY_BEFORE_APPLY.map((table) => [table, 0])),
    priorImport: {
      checked: true,
      alreadyImported: false,
      statuses: {},
      note: 'no completed import of this workbook hash',
    },
    ...overrides,
  }
}

describe('the gate passes only when everything holds', () => {
  it('passes on the approved workbook, an empty database and a ready plan', () => {
    const result = runPreflight(inputs())
    assert.equal(result.passed, true, result.blockers.join('; '))
    assert.deepEqual(result.blockers, [])
  })
})

describe('the gate stops the apply', () => {
  it('when the workbook is not the approved file', () => {
    const result = runPreflight(inputs({ workbookSha256: 'a'.repeat(64) }))
    assert.equal(result.passed, false)
  })

  it('when the plan was built from a different file than the one on disk', () => {
    const plan = planAtBaseline()
    plan.fingerprint = { ...plan.fingerprint, sha256: 'b'.repeat(64) }
    assert.equal(runPreflight(inputs({ plan })).passed, false)
  })

  it('when the branch is not the ticket branch', () => {
    assert.equal(runPreflight(inputs({ branch: 'main' })).passed, false)
  })

  it('when a required migration has not been applied', () => {
    const schemaPresence = { ...SCHEMA_PRESENT, 'public.import_exceptions': false }
    const result = runPreflight(inputs({ schemaPresence }))
    assert.equal(result.passed, false)
    assert.match(result.blockers.join(' '), /import_exceptions/)
  })

  it('when the dry run is not ready for apply', () => {
    const plan = planAtBaseline()
    plan.readiness = { ready: false, blockers: ['a row has no destination'], notes: [] }
    assert.equal(runPreflight(inputs({ plan })).passed, false)
  })

  it('when the plan reports an invariant violation', () => {
    const plan = planAtBaseline()
    plan.invariantViolations = ['a payment references a finance record that is not planned']
    assert.equal(runPreflight(inputs({ plan })).passed, false)
  })

  it('when an operational table already holds rows', () => {
    const countsBefore = Object.fromEntries(MUST_BE_EMPTY_BEFORE_APPLY.map((t) => [t, 0]))
    countsBefore.payments = 12
    const result = runPreflight(inputs({ countsBefore }))
    assert.equal(result.passed, false)
    assert.match(result.blockers.join(' '), /payments=12/)
  })

  it('when a completed import of this workbook already exists', () => {
    const result = runPreflight(
      inputs({
        priorImport: {
          checked: true,
          alreadyImported: true,
          statuses: { completed: 1 },
          note: 'a completed import of this exact workbook already exists',
        },
      }),
    )
    assert.equal(result.passed, false)
  })

  it('when the prior-import check could not be run at all', () => {
    const result = runPreflight(
      inputs({
        priorImport: {
          checked: false,
          alreadyImported: false,
          statuses: {},
          note: 'not checked: no Supabase credentials available',
        },
      }),
    )
    assert.equal(result.passed, false)
  })
})

describe('the regenerated plan is compared against the reviewed baseline', () => {
  it('stops when a count drifts, and names the difference', () => {
    const plan = planAtBaseline()
    plan.counts.paymentsPlanned = 1012

    const result = runPreflight(inputs({ plan }))
    assert.equal(result.passed, false)
    assert.match(result.blockers.join(' '), /baseline 1013, regenerated 1012/)
  })

  it('stops when conservation breaks, even if each count looks plausible alone', () => {
    const plan = planAtBaseline()
    plan.counts.payments = 1020

    const result = runPreflight(inputs({ plan }))
    assert.equal(result.passed, false)
    assert.match(result.blockers.join(' '), /Tracker Master transaction rows/)
  })

  it('stops when French stops being deferred', () => {
    const plan = planAtBaseline()
    plan.counts.frenchRowsDeferred = 0
    assert.equal(runPreflight(inputs({ plan })).passed, false)
  })

  it('checks the total student figure, not only the two parts', () => {
    const plan = planAtBaseline()
    plan.counts.students = 379
    plan.counts.unresolvedStudents = 6

    const result = runPreflight(inputs({ plan }))
    assert.equal(result.passed, false)
    assert.match(result.blockers.join(' '), /numbered students/)
  })
})

describe('a dirty working tree is recorded, not refused', () => {
  it('passes with uncommitted importer changes, which is the normal case', () => {
    const result = runPreflight(inputs({ gitStatusLines: [' M package.json', '?? scripts/x'] }))
    assert.equal(result.passed, true)
    const check = result.checks.find((entry) => entry.name.startsWith('git working tree'))
    assert.match(check?.detail ?? '', /2 changed\/untracked path\(s\)/)
  })
})
