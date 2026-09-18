import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  hasLeadingZero,
  nameComparisonForm,
  studentIdPrefix,
  studentIdStorage,
  studentIdText,
} from './student-ids.mts'

import type { RawCell } from './excel-values.mts'

const cell = (partial: Partial<RawCell> & Pick<RawCell, 'type' | 'value'>): RawCell => ({
  ref: 'B3',
  ...partial,
})

describe('student numbers are text', () => {
  it('reads a numeric cell through Excel’s formatted text', () => {
    assert.equal(studentIdText(cell({ type: 'n', value: 12506, text: '12506' })), '12506')
  })

  it('reads a text cell as written', () => {
    // 27 April 26 stores this one as a string while its neighbours are numbers.
    assert.equal(studentIdText(cell({ type: 's', value: '125213' })), '125213')
  })

  it('preserves a leading zero that a numeric read would drop', () => {
    const id = studentIdText(cell({ type: 's', value: '012345' }))
    assert.equal(id, '012345')
    assert.equal(hasLeadingZero(id), true)
    assert.equal(hasLeadingZero('125213'), false)
  })

  it('returns null for a blank rather than an empty string', () => {
    assert.equal(studentIdText(null), null)
    assert.equal(studentIdText(cell({ type: 's', value: '   ' })), null)
  })

  it('records how the number was stored, which varies between sheets', () => {
    assert.equal(studentIdStorage(cell({ type: 'n', value: 125213 })), 'number')
    assert.equal(studentIdStorage(cell({ type: 's', value: '125213' })), 'text')
    assert.equal(studentIdStorage(null), 'absent')
  })
})

describe('prefix extraction', () => {
  it('reads the same prefix from five- and six-digit numbers', () => {
    assert.equal(studentIdPrefix('12506'), '125')
    assert.equal(studentIdPrefix('125213'), '125')
    assert.equal(studentIdPrefix('12101'), '121')
  })

  it('returns null rather than a partial prefix', () => {
    assert.equal(studentIdPrefix('12'), null)
    assert.equal(studentIdPrefix(null), null)
  })

  it('reads the prefix from a number carrying stray characters', () => {
    // Reported as-is; the ID itself is never rewritten.
    assert.equal(studentIdPrefix('125-213'), '125')
  })
})

describe('name comparison form is for reporting, not merging', () => {
  it('folds case and collapses whitespace', () => {
    assert.equal(nameComparisonForm('  Ramanpreet ', 'Kaur '), 'ramanpreet kaur')
    assert.equal(nameComparisonForm('RAMANPREET', 'KAUR'), 'ramanpreet kaur')
  })

  it('skips missing parts without inventing a gap', () => {
    assert.equal(nameComparisonForm('Abhirami', null), 'abhirami')
    assert.equal(nameComparisonForm(null, null), '')
  })

  it('does not match names that merely look similar', () => {
    // Exact-after-normalisation only. No fuzzy distance, ever.
    assert.notEqual(nameComparisonForm('Gurleen', 'Kaur'), nameComparisonForm('Gurleen', 'Kuar'))
    assert.notEqual(nameComparisonForm('R.', 'Kaur'), nameComparisonForm('Ramanpreet', 'Kaur'))
  })
})
