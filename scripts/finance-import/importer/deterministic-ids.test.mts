import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  entityId,
  IMPORT_NAMESPACE,
  NAMESPACE_NAME,
  UUID_V5_PATTERN,
  uuidV5,
} from './deterministic-ids.mts'
import { paymentSourceKey, studentSourceKey } from './source-keys.mts'

const HASH = '62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2'

describe('uuidV5', () => {
  it('matches the RFC 4122 §A worked example', () => {
    // The canonical v5 test vector: DNS namespace, name "www.example.org".
    assert.equal(
      uuidV5('www.example.org', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
      '74738ff5-5367-5958-9aee-98fffdcd1876',
    )
  })

  it('sets the version and variant bits the spec requires', () => {
    for (const name of ['a', 'b', 'c', 'student|1', '']) {
      assert.match(uuidV5(name, IMPORT_NAMESPACE), UUID_V5_PATTERN)
    }
  })

  it('separates namespaces', () => {
    assert.notEqual(
      uuidV5('same-name', '6ba7b810-9dad-11d1-80b4-00c04fd430c8'),
      uuidV5('same-name', IMPORT_NAMESPACE),
    )
  })
})

describe('the import namespace', () => {
  // Pinned deliberately. This value is part of the identity of every row the
  // importer has ever written: if the derivation changes, every ID in the
  // database changes with it, and this test fails rather than letting that
  // happen quietly.
  it('is the exact namespace the imported data was keyed under', () => {
    assert.equal(NAMESPACE_NAME, 'finance-import.toronto-academy-of-education')
    assert.equal(IMPORT_NAMESPACE, 'dc235a0f-c1c4-5283-8410-e32c8b0af1a8')
  })
})

describe('entityId', () => {
  it('gives the same source entity the same id, every time', () => {
    const key = studentSourceKey(HASH, '125001')
    assert.equal(entityId(key), entityId(key))
  })

  it('does not depend on anything outside its argument', () => {
    const before = entityId(paymentSourceKey(HASH, 'Tracker Master', 42))
    for (let index = 0; index < 1000; index += 1) entityId(`noise-${index}`)
    assert.equal(entityId(paymentSourceKey(HASH, 'Tracker Master', 42)), before)
  })

  it('makes a different workbook a different id', () => {
    assert.notEqual(
      entityId(paymentSourceKey(HASH, 'Tracker Master', 7)),
      entityId(paymentSourceKey('a'.repeat(64), 'Tracker Master', 7)),
    )
  })

  it('separates entity kinds that share a row', () => {
    assert.notEqual(
      entityId(studentSourceKey(HASH, '125001')),
      entityId(paymentSourceKey(HASH, 'Tracker Master', 1)),
    )
  })

  it('produces a valid PostgreSQL uuid for every kind of source key', () => {
    const keys = [
      studentSourceKey(HASH, '125001'),
      paymentSourceKey(HASH, 'Tracker Master', 1014),
      // Keys carry escaped separators and unicode sheet names; neither may
      // produce anything a uuid column would reject.
      `${HASH}|finance-record|17th March 2025|3|title@1`,
      `${HASH}|batch|Sheet \\| with pipe|title@1`,
      `${HASH}|installment|École|7|U|INSTALLMENT FEE STRUCTURE`,
    ]
    for (const key of keys) assert.match(entityId(key), UUID_V5_PATTERN)
  })

  it('gives 10,000 distinct source keys 10,000 distinct ids', () => {
    const ids = new Set<string>()
    for (let index = 0; index < 10_000; index += 1) {
      ids.add(entityId(paymentSourceKey(HASH, 'Tracker Master', index)))
    }
    assert.equal(ids.size, 10_000)
  })
})
