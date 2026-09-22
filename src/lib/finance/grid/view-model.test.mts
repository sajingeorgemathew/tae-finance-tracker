import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { filterRows, matchesSearch } from './filters.ts'
import type { LegacyCell } from './legacy-cells.ts'
import { displayMoney } from './money.ts'
import { NO_STUDENT_NUMBER } from './student-name.ts'
import {
  buildFinanceGrid,
  resolveScheduledColumns,
  type RawFinanceRecord,
  type RawInstallment,
  type RawPayment,
} from './view-model.ts'

// -----------------------------------------------------------------------------
// Builders — row shapes exactly as the loader selects them
// -----------------------------------------------------------------------------

function cell(partial: Partial<LegacyCell>): LegacyCell {
  return {
    header: null,
    section: 'actual',
    cell_type: 'n',
    raw_value: null,
    formatted_text: null,
    formula: null,
    is_error: false,
    ...partial,
  }
}

let sequence = 0
const nextId = (prefix: string) => `${prefix}-${(sequence += 1)}`

function record(partial: Partial<RawFinanceRecord> = {}): RawFinanceRecord {
  const id = partial.id ?? nextId('rec')
  return {
    id,
    student_id: nextId('stu'),
    batch_id: 'batch-1',
    legacy_total_fee: null,
    legacy_total_paid: null,
    legacy_balance: null,
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

function installment(partial: Partial<RawInstallment> = {}): RawInstallment {
  return {
    id: nextId('inst'),
    student_finance_record_id: 'rec-1',
    sequence_number: 1,
    scheduled_amount: null,
    legacy_column_name: null,
    default_note: null,
    custom_note: null,
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

// -----------------------------------------------------------------------------

describe('historical snapshot values are shown as recorded', () => {
  it('keeps a blank total fee blank rather than showing $0.00', () => {
    const grid = buildFinanceGrid({
      records: [record({ legacy_total_fee: null })],
      installments: [],
      payments: [],
      ...PSW,
    })

    assert.equal(grid.rows[0].legacyTotalFee.kind, 'blank')
    assert.equal(displayMoney(grid.rows[0].legacyTotalFee), '—')
  })

  it('keeps a negative legacy balance negative', () => {
    const grid = buildFinanceGrid({
      records: [
        record({
          legacy_total_fee: '12000.00',
          legacy_total_paid: '11100.00',
          legacy_balance: '-900.00',
        }),
      ],
      installments: [],
      payments: [],
      ...PSW,
    })

    assert.equal(displayMoney(grid.rows[0].legacyBalance), '-$900.00')
  })

  it('does not recalculate a snapshot because the payments disagree', () => {
    // The batch sheet says 11,100 was paid. Tracker Master routed only one
    // payment of 100 to this batch record. The snapshot wins.
    const target = record({
      id: 'rec-snapshot',
      legacy_total_paid: '11100.00',
    })

    const grid = buildFinanceGrid({
      records: [target],
      installments: [],
      payments: [payment({ student_finance_record_id: 'rec-snapshot', amount: '100.00' })],
      ...PSW,
    })

    assert.equal(displayMoney(grid.rows[0].legacyTotalPaid), '$11,100.00')
    assert.equal(displayMoney(grid.rows[0].paymentTotal), '$100.00')
  })
})

describe('scheduled installments stay separate from the actual figures', () => {
  it('renders the PSW schedule from normalized installments, not the ACTUAL cells', () => {
    const target = record({
      id: 'rec-psw',
      legacy_raw_json: {
        cells: {
          G: cell({ header: 'Total Fee ', section: 'actual', raw_value: 12000 }),
          V: cell({ header: 'April ', section: 'installment', raw_value: 1500 }),
        },
      },
    })

    const grid = buildFinanceGrid({
      records: [target],
      installments: [
        installment({
          student_finance_record_id: 'rec-psw',
          sequence_number: 1,
          legacy_column_name: 'Enroll. Fee',
          scheduled_amount: '1000.00',
        }),
        installment({
          student_finance_record_id: 'rec-psw',
          sequence_number: 2,
          legacy_column_name: 'April ',
          scheduled_amount: '1500.00',
        }),
      ],
      payments: [],
      ...PSW,
    })

    // The actual group holds only the ACTUAL-section cell.
    assert.deepEqual(
      grid.columns.map((column) => column.label),
      ['Total Fee'],
    )

    // The scheduled group is its own set of columns, in source order.
    assert.deepEqual(
      grid.scheduledColumns.map((column) => column.label),
      ['Enroll. Fee', 'April'],
    )

    const row = grid.rows[0]
    assert.equal(displayMoney(row.actualCells['actual:G']), '$12,000.00')
    assert.equal(displayMoney(row.scheduledCells[grid.scheduledColumns[1].key]), '$1,500.00')
  })

  it('leaves a blank scheduled cell blank, never $0.00', () => {
    const grid = buildFinanceGrid({
      records: [record({ id: 'rec-a' }), record({ id: 'rec-b' })],
      installments: [
        installment({
          student_finance_record_id: 'rec-a',
          sequence_number: 1,
          legacy_column_name: 'August ',
          scheduled_amount: '800.00',
        }),
      ],
      payments: [],
      ...PSW,
    })

    const key = grid.scheduledColumns[0].key
    const withoutSchedule = grid.rows.find((row) => row.financeRecordId === 'rec-b')!

    assert.equal(withoutSchedule.scheduledCells[key].kind, 'blank')
    assert.equal(displayMoney(withoutSchedule.scheduledCells[key]), '—')
  })

  it('orders scheduled columns by source sequence, not alphabetically', () => {
    const columns = resolveScheduledColumns([
      installment({ sequence_number: 3, legacy_column_name: 'October' }),
      installment({ sequence_number: 1, legacy_column_name: 'Enroll. Fee' }),
      installment({ sequence_number: 2, legacy_column_name: 'August' }),
    ])

    assert.deepEqual(
      columns.map((column) => column.label),
      ['Enroll. Fee', 'August', 'October'],
    )
  })

  it('gives ECEA no scheduled columns at all rather than fabricating a plan', () => {
    const grid = buildFinanceGrid({
      records: [
        record({
          legacy_raw_json: {
            cells: {
              J: cell({ header: 'Total fees', section: 'flat', raw_value: 4000 }),
              L: cell({ header: '1st Installment', section: 'flat', raw_value: 2000 }),
              M: cell({ header: '2nd Installment', section: 'flat' }),
            },
          },
        }),
      ],
      installments: [],
      payments: [],
      programShortCode: 'ECEA',
      batchName: 'ELCE 25 & 26',
    })

    assert.deepEqual(grid.scheduledColumns, [])

    // Its ordinal fee columns appear in the historical section instead, which
    // is where the workbook itself put them.
    assert.deepEqual(
      grid.columns.map((column) => column.label),
      ['Total fees', '1st Installment', '2nd Installment'],
    )
  })
})

describe('student identity is never manufactured', () => {
  it('leaves student number null for an unresolved historical student', () => {
    const grid = buildFinanceGrid({
      records: [
        record({
          student: {
            id: 'stu-unresolved',
            student_number: null,
            first_name: null,
            middle_name: null,
            last_name: null,
            display_name: null,
            legacy_name: 'A Name From The Sheet',
          },
        }),
      ],
      installments: [],
      payments: [],
      ...PSW,
    })

    const row = grid.rows[0]
    assert.equal(row.studentNumber, null)
    assert.equal(row.studentName, 'A Name From The Sheet')
    assert.ok(row.legacyFlags.includes('no_student_number'))
    assert.equal(NO_STUDENT_NUMBER, 'No student number')
  })

  it('never exposes an importer source key as a student number', () => {
    const grid = buildFinanceGrid({
      records: [
        record({
          id: '62d53173|finance_record|17th March 2025|3',
          student: {
            id: 'stu-x',
            student_number: null,
            first_name: null,
            middle_name: null,
            last_name: null,
            display_name: null,
            legacy_name: null,
          },
        }),
      ],
      installments: [],
      payments: [],
      ...PSW,
    })

    assert.equal(grid.rows[0].studentNumber, null)
    assert.equal(grid.rows[0].studentName, 'Unnamed student')
  })
})

describe('the legacy marker stays meaningful', () => {
  it('does not mark every row when the whole batch leaves a column empty', () => {
    // The ECEA roster records no balance for any of its students. That is the
    // shape of the sheet, reported once in the summary strip — not fifty
    // separate findings about fifty students.
    const grid = buildFinanceGrid({
      records: [
        record({ legacy_total_fee: '1953.77', legacy_total_paid: '1953.77' }),
        record({ legacy_total_fee: '1953.77', legacy_total_paid: '1812.77' }),
      ],
      installments: [],
      payments: [],
      programShortCode: 'ECEA',
      batchName: 'ELCE 25 & 26',
    })

    assert.deepEqual(grid.rows[0].legacyFlags, [])
    assert.deepEqual(grid.rows[1].legacyFlags, [])
  })

  it('marks a row that is missing a figure the rest of its batch records', () => {
    const grid = buildFinanceGrid({
      records: [
        record({ id: 'has', legacy_total_fee: '5365.00', legacy_balance: '-900.00' }),
        record({ id: 'lacks', legacy_total_fee: '5365.00', legacy_balance: null }),
      ],
      installments: [],
      payments: [],
      ...PSW,
    })

    const lacks = grid.rows.find((row) => row.financeRecordId === 'lacks')!
    assert.ok(lacks.legacyFlags.includes('balance_not_recorded'))

    const has = grid.rows.find((row) => row.financeRecordId === 'has')!
    assert.equal(has.legacyFlags.includes('balance_not_recorded'), false)
  })

  it('always marks a row with no student number, whatever the batch looks like', () => {
    const grid = buildFinanceGrid({
      records: [
        record({
          student: {
            id: 'x',
            student_number: null,
            first_name: 'Taran',
            middle_name: null,
            last_name: null,
            display_name: null,
            legacy_name: null,
          },
        }),
      ],
      installments: [],
      payments: [],
      ...PSW,
    })

    assert.deepEqual(grid.rows[0].legacyFlags, ['no_student_number'])
  })
})

describe('Tracker Master Balance Fees never reaches the batch balance', () => {
  it('shows the record snapshot even when a payment carries other figures', () => {
    const target = record({ id: 'rec-bal', legacy_balance: '-450.00' })

    const grid = buildFinanceGrid({
      records: [target],
      installments: [],
      payments: [
        // `balance_fees` is a row-local formula in Tracker Master. The loader
        // never selects it, and the view model has nowhere to put it.
        payment({ student_finance_record_id: 'rec-bal', amount: '250.00' }),
      ],
      ...PSW,
    })

    assert.equal(displayMoney(grid.rows[0].legacyBalance), '-$450.00')
  })

  it('exposes no raw legacy JSON on any public row', () => {
    const grid = buildFinanceGrid({
      records: [
        record({
          legacy_raw_json: {
            source_key: 'must-not-leak',
            sheet: '17th March 2025',
            cells: { G: cell({ header: 'Total Fee ', section: 'actual', raw_value: 1 }) },
          },
        }),
      ],
      installments: [],
      payments: [payment()],
      ...PSW,
    })

    const serialized = JSON.stringify(grid)
    assert.equal(serialized.includes('must-not-leak'), false)
    assert.equal(serialized.includes('source_key'), false)
    assert.equal(serialized.includes('legacy_raw_json'), false)
    assert.equal(serialized.includes('raw_value'), false)
  })
})

describe('balance convention is verified per batch before it is used', () => {
  it('marks rows as due only when the batch confirms paid minus fee', () => {
    const grid = buildFinanceGrid({
      records: [
        record({
          legacy_total_fee: '12000.00',
          legacy_total_paid: '11100.00',
          legacy_balance: '-900.00',
        }),
        record({
          legacy_total_fee: '12000.00',
          legacy_total_paid: '12000.00',
          legacy_balance: '0.00',
        }),
      ],
      installments: [],
      payments: [],
      ...PSW,
    })

    assert.equal(grid.balanceConvention.convention, 'paid_minus_fee')
    assert.equal(grid.balanceConvention.filterable, true)
    assert.deepEqual(
      grid.rows.map((row) => row.balanceState),
      ['due', 'settled'],
    )
  })

  it('disables the filter when the batch records no checkable figure', () => {
    const grid = buildFinanceGrid({
      records: [record({ legacy_balance: '-100.00' })],
      installments: [],
      payments: [],
      ...PSW,
    })

    assert.equal(grid.balanceConvention.convention, 'unverifiable')
    assert.equal(grid.balanceConvention.filterable, false)
    assert.equal(grid.rows[0].balanceState, 'unknown')
  })

  it('disables the filter rather than filtering on a contradicted convention', () => {
    const grid = buildFinanceGrid({
      records: [
        record({
          legacy_total_fee: '1000.00',
          legacy_total_paid: '1000.00',
          legacy_balance: '500.00',
        }),
      ],
      installments: [],
      payments: [],
      ...PSW,
    })

    assert.equal(grid.balanceConvention.convention, 'inconsistent')
    assert.equal(grid.balanceConvention.filterable, false)
    assert.ok(grid.rows[0].legacyFlags.includes('balance_differs_from_batch_convention'))
  })
})

describe('summary totals come only from this batch’s snapshots', () => {
  it('sums the snapshots and reports how many students had no figure', () => {
    const grid = buildFinanceGrid({
      records: [
        record({ legacy_total_fee: '12000.00', legacy_total_paid: '11100.00' }),
        record({ legacy_total_fee: '12000.00', legacy_total_paid: null }),
      ],
      installments: [],
      payments: [payment({ amount: '9999.00' })],
      ...PSW,
    })

    assert.equal(displayMoney(grid.totals.totalFees), '$24,000.00')
    assert.equal(displayMoney(grid.totals.totalPaid), '$11,100.00')
    assert.equal(grid.totals.paidMissing, 1)
    assert.equal(grid.totals.students, 2)
  })
})

describe('search filters the display and nothing else', () => {
  const grid = buildFinanceGrid({
    records: [
      record({
        legacy_source_row: 3,
        student: {
          id: 'a',
          student_number: '125346',
          first_name: 'Asha',
          middle_name: null,
          last_name: 'Menon',
          display_name: null,
          legacy_name: null,
        },
      }),
      record({
        legacy_source_row: 4,
        student: {
          id: 'b',
          student_number: '125999',
          first_name: 'Bilal',
          middle_name: null,
          last_name: 'Osei',
          display_name: null,
          legacy_name: null,
        },
      }),
    ],
    installments: [],
    payments: [],
    ...PSW,
  })

  it('matches a student number', () => {
    const found = filterRows(grid.rows, { search: '125346' })
    assert.equal(found.length, 1)
    assert.equal(found[0].studentName, 'Asha Menon')
  })

  it('matches a name, case-insensitively', () => {
    assert.equal(filterRows(grid.rows, { search: 'osei' }).length, 1)
    assert.equal(filterRows(grid.rows, { search: 'BILAL' }).length, 1)
  })

  it('does not fuzzy-match a neighbouring student number', () => {
    assert.equal(matchesSearch(grid.rows[0], '125348'), false)
  })

  it('returns everything for an empty term', () => {
    assert.equal(filterRows(grid.rows, { search: '   ' }).length, 2)
  })
})

describe('rows read down the sheet the way staff remember', () => {
  it('orders by the workbook row number', () => {
    const grid = buildFinanceGrid({
      records: [
        record({ id: 'later', legacy_source_row: 12 }),
        record({ id: 'earlier', legacy_source_row: 4 }),
      ],
      installments: [],
      payments: [],
      ...PSW,
    })

    assert.deepEqual(
      grid.rows.map((row) => row.financeRecordId),
      ['earlier', 'later'],
    )
  })
})

// -----------------------------------------------------------------------------
// FINANCE-RECONCILE-04A — the unassigned records
// -----------------------------------------------------------------------------

describe('unassigned records carry their reason and their transactions, and nothing invented', () => {
  const UNASSIGNED = { programShortCode: 'PSW', batchName: null, batchId: null }

  it('reads the importer reason only for a record with no batch', () => {
    const grid = buildFinanceGrid({
      records: [
        record({ id: 'u-1', batch_id: null, legacy_source_row: null, legacy_raw_json: { unassigned_reason: 'ambiguous_batch' } }),
        record({ id: 'b-1', batch_id: 'batch-1', legacy_raw_json: { unassigned_reason: 'ambiguous_batch', cells: {} } }),
      ],
      installments: [],
      payments: [],
      ...UNASSIGNED,
    })
    const byId = new Map(grid.rows.map((row) => [row.financeRecordId, row]))
    assert.equal(byId.get('u-1')?.unassignedReason, 'ambiguous_batch')
    assert.equal(byId.get('b-1')?.unassignedReason, null)
  })

  it('counts and sums the imported payments, lists the distinct source batch cells, and needs no manifest for it', () => {
    const grid = buildFinanceGrid({
      records: [record({ id: 'u-1', batch_id: null, legacy_source_row: null, legacy_raw_json: { unassigned_reason: 'batch_not_found' } })],
      installments: [],
      payments: [
        payment({ student_finance_record_id: 'u-1', amount: '600.00', payment_date: '2025-12-02', legacy_batch_hint: 'Dec-25' }),
        payment({ student_finance_record_id: 'u-1', amount: '200.00', payment_date: '2026-01-31', legacy_batch_hint: 'Dec-25' }),
        payment({ student_finance_record_id: 'u-1', amount: '0.00', payment_date: null, legacy_batch_hint: ' ' }),
      ],
      manifest: [],
      ...UNASSIGNED,
    })
    const row = grid.rows[0]
    assert.equal(grid.layoutSource, 'none')
    assert.equal(grid.columns.length, 0)
    assert.equal(row.paymentCount, 3)
    assert.equal(displayMoney(row.paymentTotal), '$800.00')
    assert.equal(row.lastPaymentDate, '2026-01-31')
    assert.deepEqual(row.sourceBatchHints, ['Dec-25'])
    assert.deepEqual(
      row.payments.map((entry) => entry.legacyBatchHint),
      ['Dec-25', 'Dec-25', null],
    )
  })

  it('shows a record with no payment as none, with a blank total, and fabricates no fee, paid or balance', () => {
    const grid = buildFinanceGrid({
      records: [record({ id: 'u-0', batch_id: null, legacy_source_row: null, legacy_raw_json: { unassigned_reason: 'missing_student_id' }, student: { id: 's', student_number: null, first_name: null, middle_name: null, last_name: null, display_name: null, legacy_name: null } })],
      installments: [],
      payments: [],
      ...UNASSIGNED,
    })
    const row = grid.rows[0]
    assert.equal(row.paymentCount, 0)
    assert.equal(row.paymentTotal.kind, 'blank')
    assert.equal(row.lastPaymentDate, null)
    assert.deepEqual(row.sourceBatchHints, [])
    assert.equal(row.legacyTotalFee.kind, 'blank')
    assert.equal(row.legacyTotalPaid.kind, 'blank')
    assert.equal(row.legacyBalance.kind, 'blank')
    assert.equal(row.paymentStatus, 'unknown')
    assert.equal(row.unassignedReason, 'missing_student_id')
    assert.equal(row.studentName, 'Unnamed student')
  })

  it('never turns a payments total into a balance or a total paid', () => {
    const grid = buildFinanceGrid({
      records: [record({ id: 'u-2', batch_id: null, legacy_source_row: null, legacy_total_fee: '6600.00', legacy_raw_json: { unassigned_reason: 'batch_not_found' } })],
      installments: [],
      payments: [payment({ student_finance_record_id: 'u-2', amount: '600.00' })],
      ...UNASSIGNED,
    })
    const row = grid.rows[0]
    assert.equal(displayMoney(row.legacyTotalFee), '$6,600.00')
    assert.equal(row.legacyTotalPaid.kind, 'blank')
    assert.equal(row.legacyBalance.kind, 'blank')
    assert.equal(displayMoney(row.paymentTotal), '$600.00')
    assert.equal(grid.totals.totalPaid.kind, 'blank')
    assert.equal(grid.totals.balance.kind, 'blank')
  })
})
