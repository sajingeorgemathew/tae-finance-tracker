import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { formulaShape, parseSimpleSumRange, referencedColumns, tallyShapes } from './formulas.mts'

describe('reading what Total Paid actually sums', () => {
  it('reads the column span of a simple SUM', () => {
    const range = parseSimpleSumRange('SUM(H3:O3)')
    assert.equal(range?.firstLetter, 'H')
    assert.equal(range?.lastLetter, 'O')
    assert.equal(range?.firstColumn, 7)
    assert.equal(range?.lastColumn, 14)
  })

  it('handles two-letter columns and anchors', () => {
    assert.equal(parseSimpleSumRange('SUM($T$5:$AA$5)')?.lastLetter, 'AA')
    assert.equal(parseSimpleSumRange('sum(v3:z3)')?.firstLetter, 'V')
  })

  it('refuses anything more complicated than one SUM over one range', () => {
    // These appear in the workbook and must not be read as a column span.
    assert.equal(parseSimpleSumRange('SUM(V3:AA3)-U3'), null)
    assert.equal(parseSimpleSumRange('P3-G3'), null)
    assert.equal(parseSimpleSumRange('500+400'), null)
    assert.equal(parseSimpleSumRange('SUM(A1:B1,D1:E1)'), null)
  })

  it('refuses a reversed range rather than silently swapping it', () => {
    assert.equal(parseSimpleSumRange('SUM(O3:H3)'), null)
  })
})

describe('formula shapes', () => {
  it('collapses row numbers so a column-wide pattern is visible', () => {
    assert.equal(formulaShape('SUM(H3:O3)'), 'SUM(Hn:On)')
    assert.equal(formulaShape('SUM(H4:O4)'), 'SUM(Hn:On)')
    assert.equal(formulaShape('I2-E2'), 'In-En')
  })

  it('counts shapes so an inconsistent column stands out', () => {
    const shapes = tallyShapes(['SUM(H3:O3)', 'SUM(H4:O4)', 'SUM(H5:N5)'])
    assert.deepEqual(shapes, [
      { shape: 'SUM(Hn:On)', count: 2 },
      { shape: 'SUM(Hn:Nn)', count: 1 },
    ])
  })

  it('returns an empty tally for no formulas', () => {
    assert.deepEqual(tallyShapes([]), [])
  })
})

describe('referenced columns', () => {
  it('lists the columns a formula touches, in order, without repeats', () => {
    assert.deepEqual(referencedColumns('P3-G3'), ['P', 'G'])
    assert.deepEqual(referencedColumns('SUM(T4:Y4)-S4'), ['T', 'Y', 'S'])
    assert.deepEqual(referencedColumns('8800-G5'), ['G'])
  })

  it('returns nothing for a formula with no references', () => {
    assert.deepEqual(referencedColumns('500+400'), [])
  })
})
