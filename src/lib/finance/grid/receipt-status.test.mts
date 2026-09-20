import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  legacyReceiptLabel,
  summarizeLegacyReceipts,
} from './receipt-status.ts'

describe('historical receipt status follows the workbook, not the empty receipts table', () => {
  it('reports Sent when every stated value is YES', () => {
    assert.equal(summarizeLegacyReceipts(['YES', 'YES', 'YES']).status, 'sent')
  })

  it('reports Mixed when YES and NO both appear', () => {
    assert.equal(summarizeLegacyReceipts(['YES', 'NO']).status, 'mixed')
  })

  it('reports Not sent when every stated value is NO', () => {
    assert.equal(summarizeLegacyReceipts(['NO', 'NO']).status, 'not_sent')
  })

  it('reports Unknown when the workbook stated nothing', () => {
    assert.equal(summarizeLegacyReceipts(['', '   ', null, undefined]).status, 'unknown')
  })

  it('reports Unknown, not Not sent, for a record with no payments at all', () => {
    // There are zero rows in `receipts`. That is a fact about this system, and
    // must never be rendered as a claim that a student was not sent one.
    const summary = summarizeLegacyReceipts([])
    assert.equal(summary.status, 'unknown')
    assert.notEqual(summary.status, 'not_sent')
    assert.equal(legacyReceiptLabel(summary.status), 'Legacy receipt: Unknown')
  })
})

describe('blanks are not held against a student', () => {
  it('ignores blanks when every stated value agrees', () => {
    const summary = summarizeLegacyReceipts(['YES', '', 'YES'])
    assert.equal(summary.status, 'sent')
    assert.equal(summary.recorded, 2)
    assert.equal(summary.blank, 1)
    assert.equal(summary.total, 3)
  })

  it('is case- and whitespace-insensitive, as the workbook spellings are', () => {
    assert.equal(summarizeLegacyReceipts([' yes ', 'Yes']).status, 'sent')
    assert.equal(summarizeLegacyReceipts(['no', ' NO']).status, 'not_sent')
  })
})

describe('an unrecognised value is never guessed at', () => {
  it('falls to Mixed rather than assuming sent or not sent', () => {
    assert.equal(summarizeLegacyReceipts(['Pending']).status, 'mixed')
    assert.equal(summarizeLegacyReceipts(['YES', 'Pending']).status, 'mixed')
  })
})

describe('every label names the legacy source', () => {
  it('never offers a bare "Receipt not sent"', () => {
    for (const status of ['sent', 'mixed', 'not_sent', 'unknown'] as const) {
      assert.match(legacyReceiptLabel(status), /^Legacy receipt: /)
    }
  })
})
