import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  interpretDateCell,
  isBlank,
  isExplicitZero,
  numericValue,
  rawText,
  serialToISODate,
} from './excel-values.mts'

import type { RawCell } from './excel-values.mts'

const cell = (partial: Partial<RawCell> & Pick<RawCell, 'type' | 'value'>): RawCell => ({
  ref: 'A1',
  ...partial,
})

describe('blank is not zero', () => {
  it('treats an absent cell as blank', () => {
    assert.equal(isBlank(null), true)
    assert.equal(isExplicitZero(null), false)
  })

  it('treats a stored zero as a value, not a blank', () => {
    const zero = cell({ type: 'n', value: 0 })
    assert.equal(isBlank(zero), false)
    assert.equal(isExplicitZero(zero), true)
    assert.equal(numericValue(zero), 0)
  })

  it('distinguishes an empty string from a zero', () => {
    const empty = cell({ type: 's', value: '' })
    assert.equal(isBlank(empty), true)
    assert.equal(isExplicitZero(empty), false)
  })

  it('does not turn a blank into a number', () => {
    assert.equal(numericValue(null), null)
    assert.equal(numericValue(cell({ type: 's', value: 'n/a' })), null)
  })
})

describe('raw value preservation', () => {
  it('returns a string exactly as stored, including trailing spaces', () => {
    assert.equal(rawText(cell({ type: 's', value: 'Student ID ' })), 'Student ID ')
  })

  it('prefers Excel’s own formatted text for numbers', () => {
    // A student number stored as a number must not be reformatted on the way in.
    assert.equal(rawText(cell({ type: 'n', value: 12506, text: '12506' })), '12506')
  })

  it('falls back to the stored value when there is no formatted text', () => {
    assert.equal(rawText(cell({ type: 'n', value: 5673.45 })), '5673.45')
  })

  it('names an error rather than returning its internal code', () => {
    assert.equal(rawText(cell({ type: 'e', value: 0x17 })), '#REF!')
    assert.equal(rawText(cell({ type: 'e', value: 0x2a })), '#N/A')
  })
})

describe('Excel serial to ISO date', () => {
  it('converts serials in the 1900 system', () => {
    // Known anchors: 1 Jan 2025 and the epoch-adjacent boundary.
    assert.equal(serialToISODate(45658), '2025-01-01')
    assert.equal(serialToISODate(45784), '2025-05-07')
    assert.equal(serialToISODate(61), '1900-03-01')
  })

  it('refuses the 1900 leap-year bug window instead of guessing', () => {
    // Serial 60 is 29 February 1900, a day that did not exist.
    assert.equal(serialToISODate(60), null)
    assert.equal(serialToISODate(59), null)
  })

  it('handles the 1904 date system separately', () => {
    assert.equal(serialToISODate(0, true), '1904-01-01')
    assert.equal(serialToISODate(1, true), '1904-01-02')
  })

  it('rejects values that are not usable serials', () => {
    assert.equal(serialToISODate(-1), null)
    assert.equal(serialToISODate(Number.NaN), null)
  })
})

describe('interpreting a date cell keeps the raw value', () => {
  it('returns the serial alongside the reading', () => {
    const result = interpretDateCell(cell({ type: 'n', value: 45784 }))
    assert.equal(result.raw, 45784)
    assert.equal(result.iso, '2025-05-07')
    assert.equal(result.status, 'ok')
  })

  it('flags a serial carrying a time of day', () => {
    const result = interpretDateCell(cell({ type: 'n', value: 45784.5 }))
    assert.equal(result.status, 'has-time-component')
    assert.equal(result.raw, 45784.5)
  })

  it('flags a number too small to be a date rather than converting it', () => {
    // A quantity sitting in a date column, e.g. an amount typed one column over.
    const result = interpretDateCell(cell({ type: 'n', value: 500 }))
    assert.equal(result.status, 'implausible-range')
    assert.equal(result.raw, 500)
  })

  it('reads an old but valid serial as an ordinary date', () => {
    // The "YYYY/MM/DD" column on the cohort sheets holds values like this. They
    // are real dates; that they are decades before any batch is a contextual
    // finding for the roster analysis, not something this function decides.
    const result = interpretDateCell(cell({ type: 'n', value: 36616 }))
    assert.equal(result.status, 'ok')
    assert.equal(result.raw, 36616)
    assert.equal(result.iso, '2000-03-31')
  })

  it('flags the leap-bug window without producing a date', () => {
    const result = interpretDateCell(cell({ type: 'n', value: 45 }))
    assert.equal(result.status, 'ambiguous-1900-leap-bug')
    assert.equal(result.iso, null)
    assert.equal(result.raw, 45)
  })

  it('reports text as not a serial, keeping the text', () => {
    const result = interpretDateCell(cell({ type: 's', value: '12 May 2025' }))
    assert.equal(result.status, 'not-a-serial')
    assert.equal(result.raw, '12 May 2025')
    assert.equal(result.iso, null)
  })

  it('reports a blank as blank, not as an epoch date', () => {
    const result = interpretDateCell(null)
    assert.equal(result.status, 'blank')
    assert.equal(result.iso, null)
    assert.equal(result.raw, null)
  })
})
