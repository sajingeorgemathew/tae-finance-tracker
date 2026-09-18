import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { classifySheet } from './classify.mts'
import { normalizeHeader } from './headers.mts'

import type { SheetBlock } from './blocks.mts'

/** A block carrying only the headings a classification decision turns on. */
function blockWith(headings: string[], title: string | null = null): SheetBlock {
  const headers = headings.map((original, index) => ({
    column: index,
    letter: String.fromCharCode(65 + index),
    original,
    normalized: normalizeHeader(original),
  }))

  return {
    titleRow: title === null ? null : 1,
    title,
    headerRow: 2,
    inheritedHeaders: [],
    firstDataRow: 3,
    lastDataRow: 10,
    ownHeaders: headers,
    headers,
    actualSection: null,
    installmentSection: null,
  }
}

describe('sheet classification', () => {
  it('recognises the transaction master by its payment columns', () => {
    const result = classifySheet(
      'Tracker Master',
      [blockWith(['Payment No', 'Batch', 'Student ID ', 'Amount Paid', 'Paid Date'])],
    )
    assert.equal(result.classification, 'transaction_master')
    assert.ok(result.evidence.length > 0)
  })

  it('recognises a pivot summary before mistaking it for a roster', () => {
    // Summary also carries a Student ID column, so order matters here.
    const result = classifySheet(
      'Summary',
      [blockWith(['Student ID ', 'Student Name', 'Sum of Amount Paid', 'Sum of Balance Fees'])],
    )
    assert.equal(result.classification, 'summary')
  })

  it('recognises a PSW batch sheet from its block titles', () => {
    const result = classifySheet('12th May 2025', [
      blockWith(['Sr. No. ', 'Student ID ', 'Total Fee ', 'Total Paid'], 'PSW Morning Batch - 12th May 2025'),
      blockWith(['Sr. No. ', 'Student ID ', 'Total Fee ', 'Total Paid'], 'PSW Evening Batch - 12th May 2025'),
    ])
    assert.equal(result.classification, 'psw_batch')
  })

  it('separates a non-PSW cohort sheet from the PSW ones', () => {
    const result = classifySheet('ELCE 25 & 26', [
      blockWith([
        'Sr. No. ',
        'Student ID ',
        'First Name ',
        'Total fees',
        'Enrollment fees',
        '1st Installment',
        'Total Paid',
      ]),
    ])
    assert.equal(result.classification, 'other_program_batch')
  })

  it('answers unknown rather than forcing a fit', () => {
    const result = classifySheet('Scratch', [blockWith(['Notes', 'Something else'])])
    assert.equal(result.classification, 'unknown')
    assert.ok(result.evidence.length > 0, 'an unknown sheet still explains itself')
  })

  it('answers unknown for a sheet with no header row at all', () => {
    const result = classifySheet('Empty', [])
    assert.equal(result.classification, 'unknown')
  })
})
