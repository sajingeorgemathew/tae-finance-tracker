import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { compareCells, expectedActualCell, expectedScheduledCell } from './reconcile-grid.mts'

import type { SourceCell } from '../finance-import/importer/source-tables.mts'

/**
 * The reconciliation is only worth anything if it can *fail*. These tests pin
 * the comparison rules so a pass over the real workbook is a statement about
 * the data rather than about a comparator that never says no.
 */

function cell(partial: Partial<SourceCell>): SourceCell {
  return {
    column: 6,
    letter: 'G',
    ref: 'G5',
    cellType: 'n',
    rawValue: null,
    text: null,
    formula: null,
    numberFormat: null,
    isError: false,
    isBlank: true,
    numeric: null,
    ...partial,
  }
}

describe('expectedActualCell — what the workbook cell must become', () => {
  it('an absent or blank cell is blank, never zero', () => {
    assert.deepEqual(expectedActualCell(undefined), { kind: 'blank' })
    assert.deepEqual(expectedActualCell(cell({})), { kind: 'blank' })
  })

  it('a stored zero is an amount of zero', () => {
    const zero = expectedActualCell(cell({ rawValue: 0, isBlank: false, numeric: 0 }))
    assert.equal(zero.kind, 'amount')
    assert.equal(zero.kind === 'amount' && zero.amount, 0)
  })

  it('a negative stays negative', () => {
    const negative = expectedActualCell(cell({ rawValue: -900, isBlank: false, numeric: -900 }))
    assert.equal(negative.kind === 'amount' && negative.amount, -900)
  })

  it('an error cell is an error, not a blank', () => {
    const error = expectedActualCell(
      cell({ cellType: 'e', rawValue: 0x17, text: '#REF!', isError: true, isBlank: false }),
    )
    assert.deepEqual(error, { kind: 'error', text: '#REF!' })
  })

  it('a formula cell with no cached value is preserved as blank, as the import stored it', () => {
    assert.deepEqual(expectedActualCell(cell({ formula: 'G5-F5' })), { kind: 'blank' })
  })
})

describe('expectedScheduledCell — a schedule cell is a number or nothing', () => {
  it('blank, error and non-numeric cells produce no installment and so a blank', () => {
    assert.deepEqual(expectedScheduledCell(undefined), { kind: 'blank' })
    assert.deepEqual(expectedScheduledCell(cell({ isError: true, isBlank: false })), { kind: 'blank' })
    assert.deepEqual(
      expectedScheduledCell(cell({ cellType: 's', rawValue: 'paid', isBlank: false, numeric: null })),
      { kind: 'blank' },
    )
  })

  it('a numeric cell is the scheduled amount', () => {
    const amount = expectedScheduledCell(cell({ rawValue: 865, isBlank: false, numeric: 865 }))
    assert.equal(amount.kind === 'amount' && amount.amount, 865)
  })
})

describe('compareCells — every disagreement is named', () => {
  const amount = (value: number) => ({ kind: 'amount' as const, amount: value, display: '' })

  it('blank against blank is a preserved blank', () => {
    assert.equal(compareCells({ kind: 'blank' }, { kind: 'blank' }), 'blank_preserved')
    assert.equal(compareCells({ kind: 'blank' }, undefined), 'blank_preserved')
  })

  it('zero and negative matches are counted as what they preserve', () => {
    assert.equal(compareCells(amount(0), amount(0)), 'zero_preserved')
    assert.equal(compareCells(amount(-1000), amount(-1000)), 'negative_preserved')
    assert.equal(compareCells(amount(865), amount(865)), 'amount_match')
  })

  it('a blank rendered as $0.00 is a blank/zero mismatch, in either direction', () => {
    assert.equal(compareCells({ kind: 'blank' }, amount(0)), 'blank_zero_mismatch')
    assert.equal(compareCells(amount(0), { kind: 'blank' }), 'blank_zero_mismatch')
  })

  it('a flipped sign is a sign mismatch, not a value match', () => {
    assert.equal(compareCells(amount(-900), amount(900)), 'sign_mismatch')
  })

  it('a different figure is a value mismatch', () => {
    assert.equal(compareCells(amount(865), amount(865.5)), 'value_mismatch')
    assert.equal(compareCells(amount(865), { kind: 'blank' }), 'value_mismatch')
  })

  it('text and error cells compare on their text', () => {
    assert.equal(compareCells({ kind: 'text', text: 'paid' }, { kind: 'text', text: 'paid' }), 'text_match')
    assert.equal(compareCells({ kind: 'text', text: 'paid' }, { kind: 'text', text: 'Paid' }), 'value_mismatch')
    assert.equal(compareCells({ kind: 'error', text: '#REF!' }, { kind: 'error', text: '#REF!' }), 'error_match')
    assert.equal(compareCells({ kind: 'error', text: '#REF!' }, { kind: 'blank' }), 'kind_mismatch')
  })

  it('half a cent of rounding is tolerated; a cent is not', () => {
    assert.equal(compareCells(amount(10.004), amount(10)), 'amount_match')
    assert.equal(compareCells(amount(10.01), amount(10)), 'value_mismatch')
  })
})
