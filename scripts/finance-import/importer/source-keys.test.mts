import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  batchSourceKey,
  financeRecordSourceKey,
  installmentSourceKey,
  paymentSourceKey,
  sourceKey,
  studentSourceKey,
  tableKey,
  unassignedFinanceRecordSourceKey,
  unresolvedStudentSourceKey,
} from './source-keys.mts'

const HASH = '62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2'

describe('source keys are deterministic', () => {
  it('produces the same key for the same inputs, every time', () => {
    const first = financeRecordSourceKey(HASH, 'Aug 2026', 11, 'title@3')
    const second = financeRecordSourceKey(HASH, 'Aug 2026', 11, 'title@3')
    assert.equal(first, second)
  })

  it('does not depend on anything outside its arguments', () => {
    // Built a thousand calls apart with unrelated work in between: no counter,
    // no clock, no insertion order can leak into a key.
    const before = paymentSourceKey(HASH, 'Tracker Master', 42)
    for (let index = 0; index < 1000; index += 1) paymentSourceKey(HASH, 'other', index)
    assert.equal(paymentSourceKey(HASH, 'Tracker Master', 42), before)
  })

  it('separates every entity kind', () => {
    const keys = new Set([
      batchSourceKey(HASH, 'Dec 2025', 'title@1'),
      studentSourceKey(HASH, '125001'),
      unresolvedStudentSourceKey(HASH, 'Tracker Master', null, 7),
      financeRecordSourceKey(HASH, 'Dec 2025', 7, 'title@1'),
      unassignedFinanceRecordSourceKey(HASH, 'student-key', 'PSW'),
      paymentSourceKey(HASH, 'Tracker Master', 7),
      installmentSourceKey(HASH, 'Dec 2025', 7, 'S', 'INSTALLMENT FEE STRUCTURE'),
    ])
    assert.equal(keys.size, 7)
  })

  it('makes a different workbook a different key space', () => {
    const other = 'a'.repeat(64)
    assert.notEqual(
      paymentSourceKey(HASH, 'Tracker Master', 7),
      paymentSourceKey(other, 'Tracker Master', 7),
    )
  })

  it('distinguishes the two tables on one sheet', () => {
    assert.notEqual(
      batchSourceKey(HASH, '17th March 2025', tableKey(1, 2)),
      batchSourceKey(HASH, '17th March 2025', tableKey(21, 22)),
    )
  })

  it('distinguishes two columns of the same row', () => {
    assert.notEqual(
      installmentSourceKey(HASH, 'Dec 2025', 5, 'S', 'schedule'),
      installmentSourceKey(HASH, 'Dec 2025', 5, 'T', 'schedule'),
    )
  })
})

describe('key parts cannot collide', () => {
  it('escapes the separator so two part lists never produce one key', () => {
    // Without escaping, ['a|b','c'] and ['a','b|c'] would both join to "a|b|c".
    assert.notEqual(sourceKey('a|b', 'c'), sourceKey('a', 'b|c'))
  })

  it('escapes backslashes so the escaping itself cannot be forged', () => {
    assert.notEqual(sourceKey('a\\', 'b'), sourceKey('a', 'b'))
    assert.notEqual(sourceKey('a\\|b'), sourceKey('a', 'b'))
  })

  it('keeps a null part distinct from an absent one', () => {
    // An unresolved student has no student number; that is part of its identity
    // and must not key the same as a student whose number was simply omitted.
    assert.notEqual(sourceKey('student', null), sourceKey('student'))
  })

  it('renders numbers identically however they arrive', () => {
    assert.equal(sourceKey('row', 11), sourceKey('row', '11'))
  })
})

describe('table keys', () => {
  it('identifies a table by its title row', () => {
    assert.equal(tableKey(3, 4), 'title@3')
  })

  it('falls back to the header row for a table with no title', () => {
    assert.equal(tableKey(null, 3), 'header@3')
  })
})
