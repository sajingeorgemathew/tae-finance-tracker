import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { chooseDefaultBatch, compareBatches, resolveRequestedBatch } from './select-batch.ts'
import type { BatchOption } from './types.ts'

function batch(partial: Partial<BatchOption> & { id: string; name: string }): BatchOption {
  return {
    programId: 'psw',
    programShortCode: 'PSW',
    startDate: null,
    studentCount: 0,
    ...partial,
  }
}

const JULY_MORNING = batch({
  id: 'july-m',
  name: '29th JULY, 2026 - Morning',
  startDate: '2026-07-29',
})
const JULY_EVENING = batch({
  id: 'july-e',
  name: '29th JULY 2026 - Evening',
  startDate: '2026-07-29',
})
const MARCH_MORNING = batch({
  id: 'march-m',
  name: '17th March 2025 - Morning',
  startDate: '2025-03-17',
})
const DECEMBER_MORNING = batch({ id: 'dec-m', name: 'December 2025 - Morning' })
const DECEMBER_EVENING = batch({ id: 'dec-e', name: 'December - Evening' })

describe('batch ordering', () => {
  it('puts the most recent dated batch first', () => {
    const ordered = [MARCH_MORNING, JULY_MORNING].sort(compareBatches)
    assert.equal(ordered[0].id, 'july-m')
  })

  it('puts batches with no recorded start date last, never guessed into place', () => {
    const ordered = [DECEMBER_MORNING, MARCH_MORNING].sort(compareBatches)
    assert.deepEqual(
      ordered.map((item) => item.id),
      ['march-m', 'dec-m'],
    )
  })

  it('breaks a same-day tie with Morning before Evening', () => {
    const ordered = [JULY_EVENING, JULY_MORNING].sort(compareBatches)
    assert.deepEqual(
      ordered.map((item) => item.id),
      ['july-m', 'july-e'],
    )
  })

  it('is deterministic regardless of input order', () => {
    const forward = [JULY_EVENING, JULY_MORNING, MARCH_MORNING, DECEMBER_EVENING].sort(
      compareBatches,
    )
    const backward = [DECEMBER_EVENING, MARCH_MORNING, JULY_MORNING, JULY_EVENING].sort(
      compareBatches,
    )
    assert.deepEqual(
      forward.map((item) => item.id),
      backward.map((item) => item.id),
    )
  })
})

describe('the default batch', () => {
  it('opens on the most recent batch that records a start date', () => {
    const result = chooseDefaultBatch([MARCH_MORNING, JULY_EVENING, JULY_MORNING])
    assert.equal(result.batch?.id, 'july-m')
    assert.match(result.note, /2026-07-29/)
  })

  it('never prefers an undated batch over a dated one', () => {
    const result = chooseDefaultBatch([DECEMBER_MORNING, MARCH_MORNING])
    assert.equal(result.batch?.id, 'march-m')
  })

  it('falls back to name order, and says so, when nothing states a date', () => {
    const result = chooseDefaultBatch([DECEMBER_EVENING, DECEMBER_MORNING])
    assert.equal(result.batch?.id, 'dec-m')
    assert.match(result.note, /no batch in this program records a start date/i)
    assert.match(result.note, /tab order is not chronological/i)
  })

  it('reports no batch rather than throwing when a program has none', () => {
    assert.equal(chooseDefaultBatch([]).batch, null)
  })
})

describe('a requested batch', () => {
  const batches = [MARCH_MORNING, JULY_MORNING]

  it('is honoured when it exists', () => {
    assert.equal(resolveRequestedBatch(batches, 'march-m').batch?.id, 'march-m')
  })

  it('falls back to the default, with an explanation, when the link is stale', () => {
    const result = resolveRequestedBatch(batches, 'no-such-batch')
    assert.equal(result.batch?.id, 'july-m')
    assert.match(result.note, /not available for this program/i)
  })

  it('uses the default when no batch was asked for', () => {
    assert.equal(resolveRequestedBatch(batches, null).batch?.id, 'july-m')
  })
})
