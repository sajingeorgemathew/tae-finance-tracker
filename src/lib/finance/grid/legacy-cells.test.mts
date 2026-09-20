import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  columnLetterIndex,
  headerNamesMoney,
  historicalCellsForRecord,
  legacyCellToMoney,
  resolveHistoricalColumns,
  rowHasErrorCell,
  type LegacyCell,
} from './legacy-cells.ts'
import { displayMoney } from './money.ts'

/** A preserved cell, shaped exactly as `rowCellsForRawJson` writes one. */
function cell(partial: Partial<LegacyCell>): LegacyCell {
  return {
    header: null,
    section: 'actual',
    cell_type: 'n',
    raw_value: null,
    formatted_text: null,
    formula: null,
    is_error: false,
    ...partial,
  }
}

/** A finance record's `legacy_raw_json`, with only the cells that matter here. */
function rawJson(cells: Record<string, LegacyCell>): unknown {
  return { sheet: '17th March 2025', table_key: 'title@1', row: 3, cells }
}

describe('column ordering follows the spreadsheet, not the alphabet', () => {
  it('orders AA after Z', () => {
    assert.ok(columnLetterIndex('Z') < columnLetterIndex('AA'))
    assert.equal(columnLetterIndex('A'), 1)
    assert.equal(columnLetterIndex('Z'), 26)
    assert.equal(columnLetterIndex('AA'), 27)
  })

  it('sorts an unrecognised key last instead of colliding with column A', () => {
    assert.equal(columnLetterIndex('not-a-column'), Number.MAX_SAFE_INTEGER)
  })
})

describe('dynamic actual columns preserve source order', () => {
  it('keeps the batch sheet order even when a row states cells out of order', () => {
    const columns = resolveHistoricalColumns([
      rawJson({
        P: cell({ header: 'Total Paid', section: 'actual' }),
        G: cell({ header: 'Total Fee ', section: 'actual' }),
        J: cell({ header: 'April ', section: 'actual' }),
      }),
    ])

    assert.deepEqual(
      columns.map((column) => column.label),
      ['Total Fee', 'April', 'Total Paid'],
    )
  })

  it('unions columns across rows, because blank cells were never stored', () => {
    // One student paid a late fee and another did not; neither row alone shows
    // the batch's full column set.
    const columns = resolveHistoricalColumns([
      rawJson({ G: cell({ header: 'Total Fee ', section: 'actual' }) }),
      rawJson({ O: cell({ header: 'Late fees', section: 'actual' }) }),
    ])

    assert.deepEqual(
      columns.map((column) => column.letter),
      ['G', 'O'],
    )
  })

  it('does not force a month onto a batch whose sheet never had one', () => {
    const columns = resolveHistoricalColumns([
      rawJson({ G: cell({ header: 'Total Fee ', section: 'actual' }) }),
    ])

    assert.equal(
      columns.some((column) => /january/i.test(column.label)),
      false,
    )
  })

  it('names an unheaded column by its cell reference rather than inventing a heading', () => {
    const [column] = resolveHistoricalColumns([
      rawJson({ R: cell({ header: null, section: 'actual' }) }),
    ])

    assert.equal(column.label, 'Column R')
    assert.equal(column.unheaded, true)
  })
})

describe('sections decide what counts as historical money', () => {
  it('excludes identity columns from a split batch table', () => {
    const columns = resolveHistoricalColumns([
      rawJson({
        B: cell({ header: 'Student ID ', section: 'identity' }),
        D: cell({ header: 'First Name ', section: 'identity' }),
        G: cell({ header: 'Total Fee ', section: 'actual' }),
      }),
    ])

    assert.deepEqual(
      columns.map((column) => column.letter),
      ['G'],
    )
  })

  it('excludes the installment section, which is rendered from normalized rows', () => {
    const columns = resolveHistoricalColumns([
      rawJson({
        G: cell({ header: 'Total Fee ', section: 'actual' }),
        T: cell({ header: 'Total Fee ', section: 'installment' }),
        V: cell({ header: 'April ', section: 'installment' }),
      }),
    ])

    assert.deepEqual(
      columns.map((column) => column.letter),
      ['G'],
    )
  })

  it('keeps only money headings on a flat table, where identity shares the section', () => {
    // The ECEA roster has no ACTUAL/INSTALLMENT split: everything is 'flat',
    // and Start Date holds a date serial that must not be shown as a fee.
    const columns = resolveHistoricalColumns([
      rawJson({
        A: cell({ header: 'Sr. No. ', section: 'flat' }),
        B: cell({ header: 'Student ID ', section: 'flat' }),
        F: cell({ header: 'Start Date', section: 'flat', raw_value: 40000 }),
        G: cell({ header: 'YYYY/MM/DD', section: 'flat', raw_value: 29000 }),
        H: cell({ header: 'Payee', section: 'flat' }),
        J: cell({ header: 'Total fees', section: 'flat' }),
        L: cell({ header: '1st Installment', section: 'flat' }),
        N: cell({ header: 'Late fees', section: 'flat' }),
      }),
    ])

    assert.deepEqual(
      columns.map((column) => column.label),
      ['Total fees', '1st Installment', 'Late fees'],
    )
  })

  it('recognises month headings and the workbook abbreviations', () => {
    assert.equal(headerNamesMoney('September'), true)
    assert.equal(headerNamesMoney('Sept'), true)
    assert.equal(headerNamesMoney('Total Fee '), true)
    assert.equal(headerNamesMoney('Payee'), false)
    assert.equal(headerNamesMoney(null), false)
  })
})

describe('cell values are shown as recorded', () => {
  it('keeps a negative figure negative', () => {
    assert.equal(displayMoney(legacyCellToMoney(cell({ raw_value: -900 }))), '-$900.00')
  })

  it('leaves a blank blank, never $0.00', () => {
    assert.equal(legacyCellToMoney(undefined).kind, 'blank')
    assert.equal(legacyCellToMoney(cell({ raw_value: null })).kind, 'blank')
  })

  it('preserves a spreadsheet error rather than blanking it', () => {
    const value = legacyCellToMoney(
      cell({ is_error: true, formatted_text: '#REF!', cell_type: 'e' }),
    )
    assert.equal(value.kind, 'error')
    assert.equal(displayMoney(value), '#REF!')
  })

  it('shows text a staff member typed into a money cell', () => {
    const value = legacyCellToMoney(cell({ raw_value: 'waived', cell_type: 's' }))
    assert.equal(value.kind, 'text')
    assert.equal(displayMoney(value), 'waived')
  })
})

describe('per-record cell maps', () => {
  const columns = resolveHistoricalColumns([
    rawJson({
      G: cell({ header: 'Total Fee ', section: 'actual' }),
      O: cell({ header: 'Late fees', section: 'actual' }),
    }),
  ])

  it('gives every column a value, blank where the student had none', () => {
    const cells = historicalCellsForRecord(
      rawJson({ G: cell({ header: 'Total Fee ', section: 'actual', raw_value: 12000 }) }),
      columns,
    )

    assert.equal(displayMoney(cells['actual:G']), '$12,000.00')
    assert.equal(cells['actual:O'].kind, 'blank')
  })

  it('reports a row that holds a spreadsheet error', () => {
    assert.equal(rowHasErrorCell(rawJson({ A: cell({ is_error: true }) })), true)
    assert.equal(rowHasErrorCell(rawJson({ A: cell({ raw_value: 1 }) })), false)
    assert.equal(rowHasErrorCell(null), false)
  })
})
