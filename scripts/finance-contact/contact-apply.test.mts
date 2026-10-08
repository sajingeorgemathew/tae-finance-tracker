import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ApplyExecution, ApplyPlan } from './apply-plan.mts'
import { explainHashMismatch, parseArguments, postApplyChecks, resolveApplyGate } from './contact-apply.mts'
import { INTEGRITY_TABLES } from './pipeline.mts'

/**
 * FINANCE-CONTACT-04B2 — the apply gate and the post-apply invariants.
 *
 * The rule: the base command is a dry run, `--apply` needs the exact hash of
 * the reviewed plan, and anything else is refused rather than demoted. The
 * post-apply checks must tie every count movement to the writes actually
 * made.
 */

const HASH = 'f'.repeat(64)

describe('parseArguments / resolveApplyGate', () => {
  it('is a dry run with no arguments', () => {
    assert.equal(resolveApplyGate(parseArguments([])).mode, 'dry-run')
    assert.equal(resolveApplyGate(parseArguments(['--dry-run'])).mode, 'dry-run')
  })

  it('refuses --apply without a plan hash instead of running', () => {
    const gate = resolveApplyGate(parseArguments(['--apply']))
    assert.equal(gate.mode, 'refuse')
    assert.match(gate.reason, /--plan-hash/)
  })

  it('refuses a malformed plan hash', () => {
    assert.equal(resolveApplyGate(parseArguments(['--apply', '--plan-hash=abc'])).mode, 'refuse')
    assert.equal(resolveApplyGate(parseArguments(['--apply', `--plan-hash=${'g'.repeat(64)}`])).mode, 'refuse')
  })

  it('applies only with --apply and a well-formed hash', () => {
    const parsed = parseArguments(['--apply', `--plan-hash=${HASH.toUpperCase()}`])
    assert.equal(parsed.planHash, HASH, 'hash is normalised to lower case')
    assert.equal(resolveApplyGate(parsed).mode, 'apply')
  })

  it('ignores the hash without --apply and stays a dry run', () => {
    const gate = resolveApplyGate(parseArguments([`--plan-hash=${HASH}`]))
    assert.equal(gate.mode, 'dry-run')
  })

  it('refuses unknown arguments and contradictory modes', () => {
    assert.equal(resolveApplyGate(parseArguments(['--force'])).mode, 'refuse')
    assert.equal(resolveApplyGate(parseArguments(['--apply', `--plan-hash=${HASH}`, '--dry-run'])).mode, 'refuse')
  })
})

function plan(overrides: Partial<ApplyPlan> = {}): ApplyPlan {
  return {
    ticket: 'FINANCE-CONTACT-04B2',
    planVersion: 1,
    normalizationRule: 'contact-normalization/1',
    scope: { operationalCutoff: '2025-12-01', operationalEnd: '2026-08-31', excludedFutureIntakes: [] },
    sourceWorkbooks: [{ fileName: 'fixture.xlsx', sha256: 'a'.repeat(64), adapterId: 'x' }],
    hostedBaseline: { projectRef: 'fixture', counts: { students: 2, audit_log: 0 }, studentsWithEmail: 0, studentsWithPhone: 0 },
    candidates: [],
    deferred: [],
    aggregate: {
      operationalSourceRows: 0,
      uniqueOperationalNumbers: 0,
      existingHostedMatchRows: 0,
      uniqueMatchedStudents: 0,
      uniqueTargetStudents: 0,
      emailFills: 0,
      phoneFills: 0,
      studentsReceivingBoth: 0,
      studentsReceivingEmailOnly: 0,
      studentsReceivingPhoneOnly: 0,
      sharedContactHolds: 0,
      sharedEmailHolds: 0,
      sharedPhoneHolds: 0,
      invalidEmailHolds: 0,
      invalidPhoneHolds: 0,
      ambiguousPhoneHolds: 0,
      nonNanpPhoneHolds: 0,
      sourceConflictHolds: 0,
      contactDifferenceHolds: 0,
      emailAlreadyMatching: 0,
      phoneAlreadyMatching: 0,
      newStudentDeferralRows: 0,
      newStudentDeferrals: 0,
      missingIdDeferrals: 0,
      duplicateHostedNumberHolds: 0,
      nameDifferenceFlags: 0,
      sessionDifferenceFlags: 0,
      intakeDifferenceFlags: 0,
      repeatedNumberCollapsedCandidates: 0,
      studentRowsCreated: 0,
      studentRowsOverwritten: 0,
      expectedAuditRows: 0,
    },
    ...overrides,
  }
}

describe('explainHashMismatch', () => {
  it('names a changed workbook and a changed hosted count without quoting a value', () => {
    const stored = { generatedAt: 'x', planHash: HASH, plan: plan() }
    const live = plan({
      sourceWorkbooks: [{ fileName: 'fixture.xlsx', sha256: 'b'.repeat(64), adapterId: 'x' }],
      hostedBaseline: { projectRef: 'fixture', counts: { students: 2, audit_log: 3 }, studentsWithEmail: 1, studentsWithPhone: 0 },
    })
    const reasons = explainHashMismatch(HASH, live, 'e'.repeat(64), stored)
    assert.ok(reasons.some((reason) => reason.includes('fixture.xlsx changed')))
    assert.ok(reasons.some((reason) => reason.includes('audit_log count changed: 0 → 3')))
    assert.ok(reasons.some((reason) => reason.includes('non-NULL email changed: 0 → 1')))
  })

  it('says when the given hash is simply not the stored plan', () => {
    const stored = { generatedAt: 'x', planHash: 'd'.repeat(64), plan: plan() }
    const reasons = explainHashMismatch(HASH, plan(), 'e'.repeat(64), stored)
    assert.ok(reasons.some((reason) => reason.includes('not the hash given')))
  })
})

describe('postApplyChecks', () => {
  const execution: ApplyExecution = {
    outcomes: [],
    abortedBecause: null,
    applied: 3,
    stale: 0,
    failed: 0,
    emailFieldsWritten: 3,
    phoneFieldsWritten: 2,
  }
  const counts = (audit: number) => Object.fromEntries(INTEGRITY_TABLES.map((table) => [table, table === 'audit_log' ? audit : 10]))

  it('passes when only audit_log and the contact counts move by exactly the writes made', () => {
    const checks = postApplyChecks(
      { counts: counts(0), contacts: { studentsWithEmail: 0, studentsWithPhone: 0 } },
      { counts: counts(3), contacts: { studentsWithEmail: 3, studentsWithPhone: 2 } },
      execution,
    )
    assert.ok(checks.every((check) => check.ok))
  })

  it('fails when a student row appeared, a finance count moved, or an audit row is missing', () => {
    const after = { ...counts(2), students: 11, payments: 9 }
    const checks = postApplyChecks(
      { counts: counts(0), contacts: { studentsWithEmail: 0, studentsWithPhone: 0 } },
      { counts: after, contacts: { studentsWithEmail: 3, studentsWithPhone: 2 } },
      execution,
    )
    const failing = checks.filter((check) => !check.ok).map((check) => check.name)
    assert.deepEqual(failing, ['students count', 'payments count', 'audit_log count'])
  })
})
