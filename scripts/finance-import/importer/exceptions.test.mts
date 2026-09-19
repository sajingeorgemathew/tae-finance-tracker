/**
 * Import exceptions: the third option for a row that will not fit the schema.
 *
 * What these guard is the difference between preserving a row and losing it.
 * An exception that dropped the source data, or that shared a key with the
 * entity it stood in for, would defeat the point of the table.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { buildImportException, tallyExceptionReasons } from './exceptions.mts'
import { paymentSourceKey } from './source-keys.mts'

const HASH = '62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2'

function missingAmount(row = 1015) {
  return buildImportException({
    workbookHash: HASH,
    sourceFilename: 'finance-tracker.xlsx.xlsx',
    sourceSheet: 'Tracker Master',
    sourceRow: row,
    entityType: 'payment',
    reason: 'missing_amount',
    note: 'payments.amount is NOT NULL and the source states no amount',
    wouldBeEntitySourceKey: paymentSourceKey(HASH, 'Tracker Master', row),
    legacyRawJson: { amount_paid: null, mode_of_payment: 'Etransfer', receipt_sent: 'YES' },
  })
}

describe('a row with no amount is preserved, not invented or dropped', () => {
  it('records the reason and the entity it would have been', () => {
    const exception = missingAmount()

    assert.equal(exception.reason, 'missing_amount')
    assert.equal(exception.entityType, 'payment')
    assert.equal(exception.sourceSheet, 'Tracker Master')
    assert.equal(exception.sourceRow, 1015)
  })

  it('preserves the source row verbatim', () => {
    const source = missingAmount().legacyRawJson.source as Record<string, unknown>

    // Including the values that would have been lost with the payment.
    assert.equal(source.mode_of_payment, 'Etransfer')
    assert.equal(source.receipt_sent, 'YES')
    assert.equal(source.amount_paid, null)
  })

  it('never invents an amount', () => {
    const source = missingAmount().legacyRawJson.source as Record<string, unknown>
    assert.notEqual(source.amount_paid, 0)
  })

  it('explains itself without anyone reopening the workbook', () => {
    const json = missingAmount().legacyRawJson

    assert.match(String(json.note), /NOT NULL/)
    assert.match(String(json.preserved_because), /rather than dropped/)
  })

  it('records the key the payment would have had', () => {
    const json = missingAmount().legacyRawJson
    assert.equal(json.would_be_entity_source_key, paymentSourceKey(HASH, 'Tracker Master', 1015))
  })
})

describe('exception source keys', () => {
  it('are deterministic', () => {
    assert.equal(missingAmount().sourceKey, missingAmount().sourceKey)
  })

  it('differ per source row', () => {
    assert.notEqual(missingAmount(1015).sourceKey, missingAmount(1014).sourceKey)
  })

  it('do not collide with the key of the entity they stand in for', () => {
    // A row preserved as an exception may later be corrected into a real
    // payment, and that payment's key must not already be taken.
    const exception = missingAmount()
    assert.notEqual(exception.sourceKey, paymentSourceKey(HASH, 'Tracker Master', 1015))
  })

  it('distinguish two exceptions raised on one row for different entities', () => {
    const payment = buildImportException({
      workbookHash: HASH,
      sourceFilename: 'w.xlsx',
      sourceSheet: 'Dec 2025',
      sourceRow: 7,
      entityType: 'payment',
      reason: 'missing_amount',
      note: '',
      legacyRawJson: {},
    })
    const installment = buildImportException({
      workbookHash: HASH,
      sourceFilename: 'w.xlsx',
      sourceSheet: 'Dec 2025',
      sourceRow: 7,
      sourceColumn: 'S',
      entityType: 'installment',
      reason: 'installment_error_cell',
      note: '',
      legacyRawJson: {},
    })

    assert.notEqual(payment.sourceKey, installment.sourceKey)
  })

  it('distinguish two columns of the same row', () => {
    const at = (column: string) =>
      buildImportException({
        workbookHash: HASH,
        sourceFilename: 'w.xlsx',
        sourceSheet: 'Dec 2025',
        sourceRow: 7,
        sourceColumn: column,
        entityType: 'installment',
        reason: 'installment_error_cell',
        note: '',
        legacyRawJson: {},
      }).sourceKey

    assert.notEqual(at('S'), at('T'))
  })
})

describe('reason tallies', () => {
  it('counts by reason', () => {
    const counts = tallyExceptionReasons([missingAmount(1), missingAmount(2)])
    assert.deepEqual(counts, { missing_amount: 2 })
  })

  it('returns an empty tally for no exceptions', () => {
    assert.deepEqual(tallyExceptionReasons([]), {})
  })
})
