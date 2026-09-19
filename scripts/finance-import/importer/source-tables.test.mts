import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildSourceTable, readStudentNumber, rowCellsForRawJson } from './source-tables.mts'
import { findBlocks } from '../lib/blocks.mts'
import { planBatchFinanceRecords } from './finance-records.mts'
import { planInstallments } from './installments.mts'
import { BLANK, pswBatchSheet, rangeOf, sheetFromRows } from './fixtures.mts'

import type { SourceCell } from './source-tables.mts'

const HASH = '62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2'

function cell(partial: Partial<SourceCell>): SourceCell {
  return {
    column: 0,
    letter: 'A',
    ref: 'A11',
    cellType: 'n',
    rawValue: null,
    text: null,
    formula: null,
    numberFormat: null,
    isError: false,
    isBlank: false,
    numeric: null,
    ...partial,
  }
}

function tableOf(rows: Parameters<typeof sheetFromRows>[0]) {
  const sheet = sheetFromRows(rows)
  const blocks = findBlocks(sheet, rangeOf(sheet))
  return buildSourceTable('Fixture', sheet, blocks[0], 'psw_batch')
}

describe('a spreadsheet error can never become a student', () => {
  it('refuses an error cell as a student number', () => {
    const refError = cell({ cellType: 'e', rawValue: 0x17, text: '#REF!', isError: true })
    const result = readStudentNumber(refError)

    // Without this guard "#REF!" reads as perfectly good-looking text and would
    // create a student named after a broken formula.
    assert.equal(result.value, null)
    assert.match(result.rejected ?? '', /#REF!/)
  })

  it('still accepts an ordinary number', () => {
    const ok = cell({ cellType: 'n', rawValue: 125001, text: '125001' })
    assert.deepEqual(readStudentNumber(ok), { value: '125001', rejected: null })
  })

  it('does not clean up an unusual student number', () => {
    const odd = cell({ cellType: 's', rawValue: '125-213' })
    assert.equal(readStudentNumber(odd).value, '125-213')
  })

  it('creates no student from a row whose only content is an error', () => {
    // Mirrors Aug 2026!A11: a #REF! in the Sr. No. column and nothing else.
    const table = tableOf([
      ['PSW Morning Batch - 29th JULY, 2026'],
      ['Sr. No. ', 'Student ID ', 'First Name ', 'Total Fee', 'Total Paid', 'Total Fee'],
      [{ error: '#REF!', f: '#REF!+1' }, BLANK, BLANK, BLANK, BLANK, BLANK],
    ])

    const result = planBatchFinanceRecords(HASH, table, 'PSW', 'batch', (n) => `student:${n}`)

    assert.equal(result.records.length, 0)
    assert.equal(result.rowsWithoutStudentNumber.length, 0)
    // It is not a totals line either: it carries no money.
    assert.equal(result.totalsRowsExcluded.length, 0)
    assert.equal(result.otherRowsExcluded.length, 1)
  })

  it('preserves the error rather than repairing or zeroing it', () => {
    const table = tableOf([
      ['PSW Morning Batch - 29th JULY, 2026'],
      ['Sr. No. ', 'Student ID ', 'First Name ', 'Total Fee', 'Total Paid', 'Total Fee'],
      [{ error: '#REF!', f: '#REF!+1' }, BLANK, BLANK, BLANK, BLANK, BLANK],
    ])

    const errors = table.rows.flatMap((row) => row.errorCells)
    assert.equal(errors.length, 1)
    assert.equal(errors[0].error, '#REF!')
    assert.equal(errors[0].formula, '#REF!+1')
  })
})

describe('rows are classified by what they carry', () => {
  it('calls a row with a student a student row', () => {
    const table = tableOf([
      ['PSW Morning Batch - 12th May 2025'],
      ['Sr. No. ', 'Student ID ', 'First Name ', 'Total Fee', 'Total Paid', 'Total Fee'],
      [1, 125001, 'Asha', 5000, 1000, 5000],
    ])
    assert.equal(table.rows[0].kind, 'student')
  })

  it('calls a row with money and no student a totals row', () => {
    const table = tableOf([
      ['PSW Morning Batch - 12th May 2025'],
      ['Sr. No. ', 'Student ID ', 'First Name ', 'Total Fee', 'Total Paid', 'Total Fee'],
      [BLANK, BLANK, BLANK, 9000, 2900, 9000],
    ])
    assert.equal(table.rows[0].kind, 'totals')
  })

  it('calls a row with neither neither', () => {
    const table = tableOf([
      ['PSW Morning Batch - 12th May 2025'],
      ['Sr. No. ', 'Student ID ', 'First Name ', 'Total Fee', 'Total Paid', 'Total Fee'],
      [7, BLANK, BLANK, BLANK, BLANK, BLANK],
    ])
    assert.equal(table.rows[0].kind, 'other')
  })
})

describe('a blank and a zero stay distinguishable', () => {
  it('reads a blank as blank with no numeric value', () => {
    const table = tableOf([
      ['PSW Morning Batch - 12th May 2025'],
      ['Sr. No. ', 'Student ID ', 'First Name ', 'Total Fee', 'Total Paid', 'Total Fee'],
      [1, 125001, 'Asha', BLANK, BLANK, 5000],
    ])

    // Column D (Total Fee) has no cell at all for this row.
    assert.equal(table.rows[0].cellByColumn.get(3), undefined)
  })

  it('reads a zero as a value', () => {
    const table = tableOf([
      ['PSW Morning Batch - 12th May 2025'],
      ['Sr. No. ', 'Student ID ', 'First Name ', 'Total Fee', 'Total Paid', 'Total Fee'],
      [1, 125001, 'Asha', 0, BLANK, 5000],
    ])

    const feeCell = table.rows[0].cellByColumn.get(3)
    assert.equal(feeCell?.isBlank, false)
    assert.equal(feeCell?.numeric, 0)
  })
})

describe('legacy_raw_json keeps what the workbook said', () => {
  it('keeps the heading, raw value, formula and cell type', () => {
    const sheet = pswBatchSheet()
    const blocks = findBlocks(sheet, rangeOf(sheet))
    const table = buildSourceTable('12th May 2025', sheet, blocks[0], 'psw_batch')

    const json = rowCellsForRawJson(table, table.rows[0])

    assert.equal(json.E.header, 'Total Fee')
    assert.equal(json.E.raw_value, 5000)
    assert.equal(json.I.formula, 'SUM(F3:H3)')
    assert.equal(json.I.section, 'actual')
  })

  it('omits blanks so an absent key means nothing was entered', () => {
    const sheet = pswBatchSheet()
    const blocks = findBlocks(sheet, rangeOf(sheet))
    const table = buildSourceTable('12th May 2025', sheet, blocks[0], 'psw_batch')

    // Row 3 leaves June blank on both sides.
    const json = rowCellsForRawJson(table, table.rows[0])
    assert.equal('H' in json, false)
    assert.equal('N' in json, false)
  })
})

describe('a batch sheet creates no payments', () => {
  const sheet = pswBatchSheet()
  const blocks = findBlocks(sheet, rangeOf(sheet))
  const table = buildSourceTable('12th May 2025', sheet, blocks[0], 'psw_batch')

  it('produces finance records and installments, and nothing payment-shaped', () => {
    const records = planBatchFinanceRecords(HASH, table, 'PSW', 'batch', (n) => `student:${n}`)
    const installments = planInstallments(HASH, table, (row) => `record:${row}`)

    // Tracker Master is the sole payment source. The ACTUAL section's money —
    // the Enroll. Fee and month cells the sheet sums into Total Paid — is
    // deliberately not imported as payments, because those cells are very
    // likely another view of the same transactions.
    for (const planned of [...records.records, ...installments.installments]) {
      const keys = Object.keys(planned)
      assert.equal(keys.includes('amount'), false)
      assert.equal(keys.includes('paymentDate'), false)
      assert.equal(keys.includes('paymentMethod'), false)
      assert.equal(keys.includes('source'), false)
    }
  })

  it('preserves those ACTUAL cells in the finance record instead', () => {
    const records = planBatchFinanceRecords(HASH, table, 'PSW', 'batch', (n) => `student:${n}`)
    const cells = records.records[0].legacyRawJson.cells as Record<string, { section: string }>

    // F is the ACTUAL Enroll. Fee, G the ACTUAL May: money received, kept here
    // so a later legacy view can render it without it being money in its own right.
    assert.equal(cells.F.section, 'actual')
    assert.equal(cells.G.section, 'actual')
  })

  it('counts each ACTUAL money cell exactly once, in one place', () => {
    const installments = planInstallments(HASH, table, (row) => `record:${row}`)

    // No installment may be sourced from an ACTUAL-section column. The lookup
    // is by column letter, not by heading: "Enroll. Fee", "May" and "June" each
    // appear on both sides of the table, which is exactly the trap.
    for (const installment of installments.installments) {
      const letter = installment.legacyRawJson.column as string
      const column = table.columns.find((candidate) => candidate.letter === letter)
      assert.equal(column?.section, 'installment', `${letter} (${installment.legacyColumnName})`)
    }
  })
})
