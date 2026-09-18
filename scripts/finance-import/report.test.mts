/**
 * The privacy guard on the committed report.
 *
 * The report goes into Git and is built from real students' finance records,
 * so the rule that decides which values may be printed is worth a test of its
 * own. It is a whitelist: a column is silent unless somebody has decided it is
 * safe, which is the right failure direction.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { PRINTABLE_HEADERS_FOR_TESTS, mayPrintValuesForTests } from './report.mts'

import type { ColumnProfile } from './lib/profile.mts'

function profileFor(header: string | null): ColumnProfile {
  return {
    column: 0,
    letter: 'A',
    header,
    role: 'unknown',
    rowsExamined: 0,
    blankCount: 0,
    nonBlankCount: 0,
    formulaCount: 0,
    errorCount: 0,
    typeCounts: {},
    distinctCount: 0,
    distinctValues: [],
    numeric: null,
    dateStatusCounts: {
      ok: 0,
      'ambiguous-1900-leap-bug': 0,
      'implausible-range': 0,
      'has-time-component': 0,
      'not-a-serial': 0,
      blank: 0,
    },
    formulaSamples: [],
  }
}

describe('only allowlisted column values may reach the committed report', () => {
  it('allows closed vocabularies that describe a transaction', () => {
    assert.equal(mayPrintValuesForTests(profileFor('Program')), true)
    assert.equal(mayPrintValuesForTests(profileFor('Mode of Payment')), true)
    assert.equal(mayPrintValuesForTests(profileFor('Receipt Sent')), true)
  })

  it('matches the workbook’s trailing spaces and casing', () => {
    assert.equal(mayPrintValuesForTests(profileFor('Receipt Sent ')), true)
    assert.equal(mayPrintValuesForTests(profileFor('RECEIPT SENT')), true)
  })

  it('refuses every column that identifies or describes a person', () => {
    for (const header of [
      'Student Name',
      'First Name ',
      'Last Name ',
      'Middle Name',
      'Student ID ',
      'Payer',
      'Payee',
      'REMARKS',
      'VIKAS REMARKS',
      'Amount Paid',
      'Balance Fees',
      'Enrollment Total Fees',
    ]) {
      assert.equal(mayPrintValuesForTests(profileFor(header)), false, `${header} must not be printed`)
    }
  })

  it('refuses an unheaded column', () => {
    assert.equal(mayPrintValuesForTests(profileFor(null)), false)
  })

  it('refuses a column nobody has ruled on yet', () => {
    // A new column added to the workbook stays silent until someone decides.
    assert.equal(mayPrintValuesForTests(profileFor('Some New Column')), false)
  })

  it('keeps the allowlist small and reviewable', () => {
    assert.ok(
      PRINTABLE_HEADERS_FOR_TESTS.size <= 8,
      'the allowlist should stay short enough to review by eye',
    )
  })
})
