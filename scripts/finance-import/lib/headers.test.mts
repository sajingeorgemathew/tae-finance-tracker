import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { looksLikeHeaderRow, monthNumberFromHeader, normalizeHeader, roleForHeader } from './headers.mts'

describe('header normalisation does not change the source header', () => {
  it('trims, collapses and folds case for matching only', () => {
    assert.equal(normalizeHeader('Student ID '), 'student id')
    assert.equal(normalizeHeader('  Total   Fee  '), 'total fee')
    assert.equal(normalizeHeader('LATE FEES'), 'late fees')
  })

  it('leaves the caller’s string untouched', () => {
    const original = 'Enroll. Fee '
    const normalized = normalizeHeader(original)
    assert.equal(original, 'Enroll. Fee ')
    assert.notEqual(original, normalized)
  })

  it('treats a non-breaking space as a space', () => {
    assert.equal(normalizeHeader('Total Paid'), 'total paid')
  })

  it('maps the workbook’s spellings onto one role each', () => {
    // These four spellings all appear in the workbook.
    assert.equal(roleForHeader('Student ID '), 'student_id')
    assert.equal(roleForHeader('Late fees'), 'late_fees')
    assert.equal(roleForHeader('Late Fees'), 'late_fees')
    assert.equal(roleForHeader('Total fees'), 'total_fee')
  })

  it('reports an unrecognised heading as unknown rather than guessing', () => {
    assert.equal(roleForHeader('VIKAS REMARKS'), 'remarks')
    assert.equal(roleForHeader('Something Nobody Has Seen'), 'unknown')
    assert.equal(roleForHeader(''), 'unknown')
  })
})

describe('month headers', () => {
  it('recognises full names and the workbook’s abbreviations', () => {
    assert.equal(monthNumberFromHeader('September'), 9)
    assert.equal(monthNumberFromHeader('Sept'), 9)
    assert.equal(monthNumberFromHeader('Sep'), 9)
    assert.equal(monthNumberFromHeader('Mar'), 3)
    assert.equal(monthNumberFromHeader('August '), 8)
  })

  it('does not treat a non-month as a month', () => {
    assert.equal(monthNumberFromHeader('Total Paid'), null)
    assert.equal(monthNumberFromHeader('Payer'), null)
  })

  it('classifies a month heading by role without deciding its section', () => {
    // Which section it belongs to is a property of position, not of the word.
    assert.equal(roleForHeader('May'), 'month')
    assert.equal(roleForHeader('January'), 'month')
  })
})

describe('recognising a header row', () => {
  it('accepts a full heading row', () => {
    const row = ['Sr. No. ', 'Student ID ', 'First Name ', 'Last Name ', 'Total Fee ']
    assert.equal(looksLikeHeaderRow(row), true)
  })

  it('accepts a partial heading row, as the Evening tables use', () => {
    // Dec 2025 row 22: the title sits in column A and only the scheduled side
    // restates its headings.
    const row = ['PSW Evening Batch - December', null, null, 'Total Fee ', 'Enroll. Fee']
    assert.equal(looksLikeHeaderRow(row), true)
  })

  it('rejects a data row', () => {
    const row = [null, null, 'Y', null, null]
    assert.equal(looksLikeHeaderRow(row), false)
  })

  it('rejects a row holding only a title', () => {
    assert.equal(looksLikeHeaderRow(['PSW Morning Batch - 17th March 2025', null, null]), false)
  })
})
