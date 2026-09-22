import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  isUnassignedReason,
  unassignedReasonExplanation,
  unassignedReasonLabel,
  unassignedReasonOf,
} from './unassigned.ts'

/**
 * FINANCE-RECONCILE-04A — reading the importer's routing outcome.
 */

describe('unassignedReasonOf', () => {
  it('reads each of the three importer outcomes from the preserved JSON', () => {
    assert.equal(unassignedReasonOf({ unassigned_reason: 'ambiguous_batch' }), 'ambiguous_batch')
    assert.equal(unassignedReasonOf({ unassigned_reason: 'batch_not_found' }), 'batch_not_found')
    assert.equal(unassignedReasonOf({ unassigned_reason: 'missing_student_id' }), 'missing_student_id')
  })

  it('returns null rather than guessing for anything else', () => {
    assert.equal(unassignedReasonOf({ unassigned_reason: 'unique_batch' }), null)
    assert.equal(unassignedReasonOf({ unassigned_reason: '' }), null)
    assert.equal(unassignedReasonOf({ cells: {} }), null)
    assert.equal(unassignedReasonOf(null), null)
    assert.equal(unassignedReasonOf('ambiguous_batch'), null)
    assert.equal(unassignedReasonOf(['ambiguous_batch']), null)
  })

  it('exposes the guard', () => {
    assert.equal(isUnassignedReason('batch_not_found'), true)
    assert.equal(isUnassignedReason('anything'), false)
  })
})

describe('reason wording', () => {
  it('labels every reason, and the absence of one, without a verdict', () => {
    assert.equal(unassignedReasonLabel('ambiguous_batch'), 'In two batch tables')
    assert.equal(unassignedReasonLabel('batch_not_found'), 'In no batch table')
    assert.equal(unassignedReasonLabel('missing_student_id'), 'No student number')
    assert.equal(unassignedReasonLabel(null), 'Reason not recorded')
  })

  it('explains the routing rule, not the student', () => {
    assert.match(unassignedReasonExplanation('ambiguous_batch'), /did not guess/)
    assert.match(unassignedReasonExplanation('batch_not_found'), /a month, not a cohort/)
    assert.match(unassignedReasonExplanation('missing_student_id'), /rather than matched to anyone by name/)
    assert.match(unassignedReasonExplanation(null), /recorded no reason/)
  })
})
