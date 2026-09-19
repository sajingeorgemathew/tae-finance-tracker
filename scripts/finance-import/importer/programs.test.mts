import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { CANONICAL_PROGRAMS, resolveProgramLabel, resolveSheetProgram } from './programs.mts'

describe('ELCE is an alias for ECEA, not a rewrite', () => {
  it('maps the workbook label ELCE to the canonical short code ECEA', () => {
    const resolved = resolveProgramLabel('ELCE')
    assert.equal(resolved.status, 'mapped')
    assert.equal(resolved.status === 'mapped' && resolved.shortCode, 'ECEA')
  })

  it('preserves the source spelling exactly', () => {
    const resolved = resolveProgramLabel('ELCE')
    // The relationship points at ECEA; the workbook's own text stays ELCE and
    // is what goes into legacy_raw_json.
    assert.equal(resolved.status === 'mapped' && resolved.sourceLabel, 'ELCE')
    assert.equal(resolved.status === 'mapped' && resolved.aliased, true)
  })

  it('marks PSW as not aliased', () => {
    const resolved = resolveProgramLabel('PSW')
    assert.equal(resolved.status === 'mapped' && resolved.shortCode, 'PSW')
    assert.equal(resolved.status === 'mapped' && resolved.aliased, false)
  })

  it('matches a carelessly written label without altering it', () => {
    const resolved = resolveProgramLabel('  elce ')
    assert.equal(resolved.status === 'mapped' && resolved.shortCode, 'ECEA')
    assert.equal(resolved.status === 'mapped' && resolved.sourceLabel, '  elce ')
  })

  it('keeps the configured ECEA numbering that receipts depend on', () => {
    assert.deepEqual(CANONICAL_PROGRAMS.ECEA, {
      shortCode: 'ECEA',
      name: 'Early Childhood Education Assistant',
      studentNumberPrefix: '121',
      receiptCourseCode: '12100',
      receiptCourseSuffix: '21',
    })
  })
})

describe('French is deferred, never invented', () => {
  it('defers the French label rather than mapping it', () => {
    const resolved = resolveProgramLabel('French')
    assert.equal(resolved.status, 'deferred')
    assert.equal(
      resolved.status === 'deferred' && resolved.reason,
      'deferred_program_configuration',
    )
  })

  it('defers the French sheet', () => {
    const resolved = resolveSheetProgram('French', null)
    assert.equal(resolved.status, 'deferred')
  })

  it('creates no French entry in the canonical programs', () => {
    assert.deepEqual(Object.keys(CANONICAL_PROGRAMS).sort(), ['ECEA', 'PSW'])
  })
})

describe('unmapped and blank labels', () => {
  it('reports an unrecognised label rather than choosing the nearest program', () => {
    const resolved = resolveProgramLabel('PSWX')
    assert.equal(resolved.status, 'unknown')
  })

  it('treats a blank as blank, not as a program', () => {
    assert.equal(resolveProgramLabel(null).status, 'blank')
    assert.equal(resolveProgramLabel('   ').status, 'blank')
  })
})

describe('sheet-level program resolution', () => {
  it('reads ECEA from the ELCE sheet name', () => {
    const resolved = resolveSheetProgram('ELCE 25 & 26', null)
    assert.equal(resolved.status === 'mapped' && resolved.shortCode, 'ECEA')
  })

  it('reads PSW from a batch title', () => {
    const resolved = resolveSheetProgram('Aug 2026', 'PSW Morning Batch - 29th JULY, 2026')
    assert.equal(resolved.status === 'mapped' && resolved.shortCode, 'PSW')
  })
})
