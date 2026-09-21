import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  BLANK_DISPLAY,
  displayMoney,
  formatMoney,
  moneyFromNumber,
  moneyFromNumeric,
  sumMoney,
} from './money.ts'

describe('money formatting preserves what the workbook recorded', () => {
  it('formats CAD amounts the way the ticket specifies', () => {
    assert.equal(formatMoney(865), '$865.00')
    assert.equal(formatMoney(1000), '$1,000.00')
    assert.equal(formatMoney(1234567.5), '$1,234,567.50')
    assert.equal(formatMoney(0), '$0.00')
  })

  it('does not hide a negative historical value', () => {
    assert.equal(formatMoney(-900), '-$900.00')
    assert.equal(displayMoney(moneyFromNumber(-1250.5)), '-$1,250.50')
  })

  it('rounds to the cent rather than showing floating-point noise', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point.
    assert.equal(formatMoney(0.1 + 0.2), '$0.30')
    assert.equal(formatMoney(1.0049), '$1.00')
    assert.equal(formatMoney(1.006), '$1.01')
    assert.equal(formatMoney(-1.006), '-$1.01')
  })
})

describe('a blank is never a zero', () => {
  it('renders a missing figure as an em dash, not $0.00', () => {
    assert.equal(moneyFromNumeric(null).kind, 'blank')
    assert.equal(displayMoney(moneyFromNumeric(null)), BLANK_DISPLAY)
    assert.notEqual(displayMoney(moneyFromNumeric(null)), '$0.00')
  })

  it('treats an empty string as blank and a recorded zero as zero', () => {
    assert.equal(moneyFromNumeric('   ').kind, 'blank')

    const zero = moneyFromNumeric('0.00')
    assert.equal(zero.kind, 'amount')
    assert.equal(displayMoney(zero), '$0.00')
  })

  it('keeps an unparseable historical value as text rather than dropping it', () => {
    const cell = moneyFromNumeric('see remarks')
    assert.equal(cell.kind, 'text')
    assert.equal(displayMoney(cell), 'see remarks')
  })
})

describe('summing historical figures', () => {
  it('reports a blank total when nothing could be added', () => {
    const result = sumMoney([moneyFromNumeric(null), moneyFromNumeric(null)])
    assert.equal(result.total.kind, 'blank')
    assert.equal(result.counted, 0)
    assert.equal(result.missing, 2)
  })

  it('adds only the figures that exist and says how many were missing', () => {
    const result = sumMoney([
      moneyFromNumeric('1000.00'),
      moneyFromNumeric(null),
      moneyFromNumeric('-250.50'),
    ])

    assert.equal(displayMoney(result.total), '$749.50')
    assert.equal(result.counted, 2)
    assert.equal(result.missing, 1)
  })

  it('sums in cents, so a long column does not drift', () => {
    const result = sumMoney(Array.from({ length: 10 }, () => moneyFromNumeric('0.10')))
    assert.equal(displayMoney(result.total), '$1.00')
  })
})
