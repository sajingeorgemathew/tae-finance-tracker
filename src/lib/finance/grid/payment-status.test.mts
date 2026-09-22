import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  countReceiptStatuses,
  filterRows,
  isReceiptFilter,
  matchesStatus,
  RECEIPT_FILTERS,
  RECEIPT_GAP,
  receiptFilterFromLegacy,
  receiptFilterLabel,
  statusFilterFromLegacy,
} from './filters.ts'
import { moneyFromNumeric } from './money.ts'
import {
  countPaymentStatuses,
  paymentStatusFromBalanceState,
  paymentStatusLabel,
  paymentStatusOf,
} from './payment-status.ts'
import { buildFinanceGrid, type RawFinanceRecord, type RawPayment } from './view-model.ts'

/**
 * FINANCE-GRID-03C — Payment Status.
 *
 * One derivation, from the imported balance under the batch's verified sign
 * convention. Never from payments, never from fee minus paid, never from
 * Tracker Master's Balance Fees.
 */

let sequence = 0
const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`

function record(partial: Partial<RawFinanceRecord> = {}): RawFinanceRecord {
  return {
    id: partial.id ?? nextId('rec'),
    student_id: nextId('stu'),
    batch_id: 'batch-1',
    legacy_total_fee: '12000.00',
    legacy_total_paid: '12000.00',
    legacy_balance: '0.00',
    legacy_source_row: 3,
    legacy_raw_json: { cells: {} },
    student: {
      id: nextId('stu'),
      student_number: '125346',
      first_name: 'Test',
      middle_name: null,
      last_name: 'Student',
      display_name: null,
      legacy_name: null,
    },
    ...partial,
  }
}

function payment(partial: Partial<RawPayment> = {}): RawPayment {
  return {
    id: nextId('pay'),
    student_finance_record_id: 'rec-1',
    amount: '100.00',
    payment_date: '2025-04-01',
    payment_method: 'E-Transfer',
    note: null,
    voided_at: null,
    legacy_receipt_sent: 'YES',
    legacy_batch_hint: null,
    ...partial,
  }
}

const PSW = { programShortCode: 'PSW', batchName: '17th March 2025 - Morning' }

describe('payment status from a reliable balance', () => {
  it('Outstanding from a negative balance under the verified convention', () => {
    assert.equal(paymentStatusOf(moneyFromNumeric('-865.00'), 'paid_minus_fee'), 'outstanding')
  })

  it('Settled from a zero balance', () => {
    assert.equal(paymentStatusOf(moneyFromNumeric('0.00'), 'paid_minus_fee'), 'settled')
    assert.equal(paymentStatusOf(moneyFromNumeric('0'), 'paid_minus_fee'), 'settled')
  })

  it('Credit from a positive balance', () => {
    assert.equal(paymentStatusOf(moneyFromNumeric('200.00'), 'paid_minus_fee'), 'credit')
  })

  it('Unknown from a missing balance', () => {
    assert.equal(paymentStatusOf(moneyFromNumeric(null), 'paid_minus_fee'), 'unknown')
    assert.equal(paymentStatusOf(moneyFromNumeric(''), 'paid_minus_fee'), 'unknown')
  })

  it('Unknown from an unparseable balance', () => {
    assert.equal(paymentStatusOf(moneyFromNumeric('see remarks'), 'paid_minus_fee'), 'unknown')
  })

  it('Unknown whenever the batch convention is not verified, whatever the sign', () => {
    assert.equal(paymentStatusOf(moneyFromNumeric('-865.00'), 'unverifiable'), 'unknown')
    assert.equal(paymentStatusOf(moneyFromNumeric('-865.00'), 'inconsistent'), 'unknown')
    assert.equal(paymentStatusOf(moneyFromNumeric('0.00'), 'unverifiable'), 'unknown')
  })

  it('maps every balance state to exactly one status', () => {
    assert.equal(paymentStatusFromBalanceState('due'), 'outstanding')
    assert.equal(paymentStatusFromBalanceState('settled'), 'settled')
    assert.equal(paymentStatusFromBalanceState('credit'), 'credit')
    assert.equal(paymentStatusFromBalanceState('unknown'), 'unknown')
  })

  it('uses the agreed words, and never "Paid"', () => {
    assert.deepEqual(
      (['outstanding', 'settled', 'credit', 'unknown'] as const).map(paymentStatusLabel),
      ['Outstanding', 'Settled', 'Credit', 'Unknown'],
    )
  })
})

describe('the row carries the status the batch convention allows', () => {
  it('a verified PSW batch labels its rows Outstanding, Settled and Credit as recorded', () => {
    const grid = buildFinanceGrid({
      records: [
        record({ legacy_total_paid: '11135.00', legacy_balance: '-865.00' }),
        record({ legacy_total_paid: '12000.00', legacy_balance: '0.00' }),
        record({ legacy_total_paid: '12200.00', legacy_balance: '200.00' }),
        record({ legacy_total_fee: null, legacy_total_paid: null, legacy_balance: null }),
      ],
      installments: [],
      payments: [],
      ...PSW,
    })
    assert.deepEqual(
      grid.rows.map((row) => row.paymentStatus),
      ['outstanding', 'settled', 'credit', 'unknown'],
    )
    assert.deepEqual(countPaymentStatuses(grid.rows), { outstanding: 1, settled: 1, credit: 1, unknown: 1 })
  })

  it('ECEA rows stay Unknown: no balance is recorded and fee minus paid is never computed', () => {
    const grid = buildFinanceGrid({
      records: [
        record({ legacy_total_fee: '4000.00', legacy_total_paid: '2000.00', legacy_balance: null }),
        record({ legacy_total_fee: '4000.00', legacy_total_paid: '4000.00', legacy_balance: null }),
      ],
      installments: [],
      payments: [],
      programShortCode: 'ECEA',
      batchName: 'ELCE 25 & 26',
    })
    assert.deepEqual(grid.rows.map((row) => row.paymentStatus), ['unknown', 'unknown'])
    assert.equal(grid.balanceConvention.convention, 'unverifiable')
  })

  it('a blank balance is Unknown, never Outstanding, even where the batch is verified', () => {
    const grid = buildFinanceGrid({
      records: [
        record({ legacy_total_paid: '11135.00', legacy_balance: '-865.00' }),
        record({ legacy_balance: null }),
      ],
      installments: [],
      payments: [],
      ...PSW,
    })
    assert.equal(grid.rows[1].paymentStatus, 'unknown')
  })

  it('payments never change the status: the snapshot wins', () => {
    const settled = record({ id: 'rec-1', legacy_total_paid: '12000.00', legacy_balance: '0.00' })
    const withPayments = buildFinanceGrid({
      records: [settled],
      installments: [],
      payments: [payment({ amount: '1.00' }), payment({ amount: '-5000.00' })],
      ...PSW,
    })
    const without = buildFinanceGrid({ records: [settled], installments: [], payments: [], ...PSW })
    assert.equal(withPayments.rows[0].paymentStatus, 'settled')
    assert.equal(without.rows[0].paymentStatus, 'settled')
  })

  it('Tracker Master Balance Fees is never selected by the loader and never reaches the row', () => {
    const loader = readFileSync(fileURLToPath(new URL('./load.ts', import.meta.url)), 'utf8')
    assert.equal(/balance_fees/i.test(loader), false)
    const paymentShape: RawPayment = payment()
    assert.equal('balance_fees' in paymentShape, false)
  })
})

describe('the status filter is the badge’s own status', () => {
  const grid = buildFinanceGrid({
    records: [
      record({ legacy_source_row: 3, legacy_total_paid: '11135.00', legacy_balance: '-865.00' }),
      record({ legacy_source_row: 4, legacy_total_paid: '12000.00', legacy_balance: '0.00' }),
      record({ legacy_source_row: 5, legacy_total_paid: '12200.00', legacy_balance: '200.00' }),
      record({ legacy_source_row: 6, legacy_balance: null }),
    ],
    installments: [],
    payments: [],
    ...PSW,
  })

  it('each filter returns exactly the rows whose badge shows that status', () => {
    for (const status of ['outstanding', 'settled', 'credit', 'unknown'] as const) {
      const filtered = filterRows(grid.rows, { status })
      assert.deepEqual(
        filtered.map((row) => row.financeRecordId),
        grid.rows.filter((row) => row.paymentStatus === status).map((row) => row.financeRecordId),
      )
      assert.ok(filtered.every((row) => matchesStatus(row, status)))
    }
  })

  it('All returns everything', () => {
    assert.equal(filterRows(grid.rows, { status: 'all' }).length, 4)
  })

  it('maps the GRID-03 filter names onto the same statuses', () => {
    assert.equal(statusFilterFromLegacy('balance_due'), 'outstanding')
    assert.equal(statusFilterFromLegacy('settled'), 'settled')
    assert.equal(statusFilterFromLegacy('no_balance'), 'unknown')
    assert.equal(statusFilterFromLegacy('legacy_receipt_gap'), 'all')
    assert.equal(statusFilterFromLegacy('nonsense'), null)
  })
})

describe('the legacy receipt filter is secondary and composes with the rest', () => {
  const rows = buildFinanceGrid({
    records: [
      record({ id: 'r-sent', legacy_source_row: 3, legacy_total_paid: '11135.00', legacy_balance: '-865.00' }),
      record({ id: 'r-mixed', legacy_source_row: 4, legacy_total_paid: '11135.00', legacy_balance: '-865.00' }),
      record({ id: 'r-none', legacy_source_row: 5, legacy_total_paid: '12000.00', legacy_balance: '0.00' }),
      record({ id: 'r-no', legacy_source_row: 6, legacy_total_paid: '12000.00', legacy_balance: '0.00' }),
    ],
    installments: [],
    payments: [
      payment({ student_finance_record_id: 'r-sent', legacy_receipt_sent: 'YES' }),
      payment({ student_finance_record_id: 'r-mixed', legacy_receipt_sent: 'YES' }),
      payment({ student_finance_record_id: 'r-mixed', legacy_receipt_sent: 'NO' }),
      payment({ student_finance_record_id: 'r-no', legacy_receipt_sent: 'NO' }),
    ],
    ...PSW,
  }).rows

  it('each receipt filter returns exactly the rows whose Receipt cell shows that status', () => {
    for (const receipt of ['sent', 'mixed', 'not_sent', 'unknown'] as const) {
      assert.deepEqual(
        filterRows(rows, { receipt }).map((row) => row.financeRecordId),
        rows.filter((row) => row.receiptStatus === receipt).map((row) => row.financeRecordId),
      )
    }
    assert.deepEqual(filterRows(rows, { receipt: 'unknown' }).map((row) => row.financeRecordId), ['r-none'])
    assert.equal(filterRows(rows, { receipt: 'all' }).length, 4)
  })

  it('composes with payment status and search rather than replacing them', () => {
    assert.deepEqual(
      filterRows(rows, { receipt: 'sent', status: 'outstanding' }).map((row) => row.financeRecordId),
      ['r-sent'],
    )
    assert.deepEqual(filterRows(rows, { receipt: 'sent', status: 'settled' }), [])
    assert.deepEqual(
      filterRows(rows, { receipt: 'not_sent', search: '125346' }).map((row) => row.financeRecordId),
      ['r-no'],
    )
    assert.deepEqual(filterRows(rows, { receipt: 'not_sent', search: 'nobody' }), [])
  })

  it('counts receipt statuses the way the pills need them', () => {
    assert.deepEqual(countReceiptStatuses(rows), { sent: 1, mixed: 1, not_sent: 1, unknown: 1 })
  })

  it('never changes a payment status: receipt status is a different question', () => {
    assert.deepEqual(
      rows.map((row) => [row.receiptStatus, row.paymentStatus]),
      [
        ['sent', 'outstanding'],
        ['mixed', 'outstanding'],
        ['unknown', 'settled'],
        ['not_sent', 'settled'],
      ],
    )
  })

  it('accepts only the four historical statuses in the URL', () => {
    assert.equal(isReceiptFilter('sent'), true)
    assert.equal(isReceiptFilter('not_sent'), true)
    assert.equal(isReceiptFilter('issued'), false)
    assert.equal(isReceiptFilter(null), false)
  })
})

describe('the GRID-03 legacy_receipt_gap link keeps its meaning: Not sent or Mixed', () => {
  const rows = buildFinanceGrid({
    records: [
      record({ id: 'g-sent', legacy_source_row: 3 }),
      record({ id: 'g-mixed', legacy_source_row: 4 }),
      record({ id: 'g-none', legacy_source_row: 5 }),
      record({ id: 'g-no', legacy_source_row: 6 }),
    ],
    installments: [],
    payments: [
      payment({ student_finance_record_id: 'g-sent', legacy_receipt_sent: 'YES' }),
      payment({ student_finance_record_id: 'g-mixed', legacy_receipt_sent: 'YES' }),
      payment({ student_finance_record_id: 'g-mixed', legacy_receipt_sent: 'NO' }),
      payment({ student_finance_record_id: 'g-no', legacy_receipt_sent: 'NO' }),
    ],
    ...PSW,
  }).rows

  it('maps the old filter to the compatibility value, never to All', () => {
    const mapped = receiptFilterFromLegacy('legacy_receipt_gap')
    assert.equal(mapped, RECEIPT_GAP)
    assert.notEqual(mapped, 'all')
    assert.equal(isReceiptFilter(mapped), true)
  })

  it('does not map anything else', () => {
    assert.equal(receiptFilterFromLegacy('balance_due'), null)
    assert.equal(receiptFilterFromLegacy('all'), null)
    assert.equal(receiptFilterFromLegacy(null), null)
  })

  it('shows exactly the Not sent and Mixed rows, and neither Sent nor Unknown', () => {
    const shown = filterRows(rows, { receipt: RECEIPT_GAP })
    assert.deepEqual(shown.map((row) => row.financeRecordId).sort(), ['g-mixed', 'g-no'])
    assert.ok(shown.every((row) => row.receiptStatus === 'not_sent' || row.receiptStatus === 'mixed'))
    assert.ok(!shown.some((row) => row.receiptStatus === 'sent' || row.receiptStatus === 'unknown'))
    assert.notEqual(shown.length, rows.length)
  })

  it('still composes with the other filters', () => {
    assert.deepEqual(
      filterRows(rows, { receipt: RECEIPT_GAP, search: '125346' }).map((row) => row.financeRecordId).sort(),
      ['g-mixed', 'g-no'],
    )
    assert.deepEqual(filterRows(rows, { receipt: RECEIPT_GAP, search: 'nobody' }), [])
    assert.deepEqual(filterRows(rows, { receipt: RECEIPT_GAP, status: 'outstanding' }), [])
  })

  it('is not one of the everyday pills, but has a label when active', () => {
    assert.equal(RECEIPT_FILTERS.includes(RECEIPT_GAP), false)
    assert.equal(receiptFilterLabel(RECEIPT_GAP), 'Not sent or Mixed')
  })
})
