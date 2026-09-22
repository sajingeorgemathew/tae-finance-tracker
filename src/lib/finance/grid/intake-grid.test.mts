import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { filterRows } from './filters.ts'
import { combineBatchGrids, unionColumns } from './intake-grid.ts'
import type { LegacyCell } from './legacy-cells.ts'
import type { RawManifestColumn } from './manifest.ts'
import { displayMoney } from './money.ts'
import { allVisibleSelected, someVisibleSelected, toggleVisible } from './selection.ts'
import type { FinanceColumn } from './types.ts'
import { buildFinanceGrid, type RawFinanceRecord } from './view-model.ts'

/**
 * FINANCE-GRID-03C — a Morning and an Evening batch shown as one intake.
 *
 * Each batch is built exactly as GRID-03 built it, then combined. The tests
 * check what the combination may and may not do: keep every row's batch,
 * union the columns in source order, leave a cell blank where a row's own
 * table had no such column, sum without double counting, and derive Payment
 * Status per batch under that batch's own verified convention.
 */

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

function record(partial: Partial<RawFinanceRecord> & { batch_id: string }): RawFinanceRecord {
  const id = partial.id ?? nextId('rec')
  return {
    id,
    student_id: nextId('stu'),
    legacy_total_fee: '12000.00',
    legacy_total_paid: '12000.00',
    legacy_balance: '0.00',
    legacy_source_row: 3,
    legacy_raw_json: { cells: {} },
    student: {
      id: nextId('stu'),
      student_number: nextId('12'),
      first_name: 'Test',
      middle_name: null,
      last_name: partial.batch_id === 'morning' ? 'Morningstudent' : 'Eveningstudent',
      display_name: null,
      legacy_name: null,
    },
    ...partial,
  }
}

function manifestRow(partial: Partial<RawManifestColumn> & { column_key: string }): RawManifestColumn {
  return {
    section: 'actual',
    source_column_letter: partial.column_key.split(':')[1] ?? null,
    source_header: null,
    normalized_role: 'month',
    value_kind: 'money',
    display_order: 1,
    is_grid_visible: true,
    display_even_if_blank: true,
    ...partial,
  }
}

/** The Morning table: Total Fee, August, October (nobody paid), Late Fees. */
const MORNING_MANIFEST = [
  manifestRow({ column_key: 'actual:F', source_header: 'Total Fee ', normalized_role: 'total_fee', display_order: 1 }),
  manifestRow({ column_key: 'actual:G', source_header: 'August', display_order: 2 }),
  manifestRow({ column_key: 'actual:H', source_header: 'October', display_order: 3 }),
  manifestRow({ column_key: 'actual:I', source_header: 'Late fees', normalized_role: 'late_fees', display_order: 4 }),
  manifestRow({ column_key: 'installment:P', section: 'installment', source_header: 'Enroll. Fee', normalized_role: 'enrollment', display_order: 1 }),
  manifestRow({ column_key: 'installment:Q', section: 'installment', source_header: 'September', display_order: 2 }),
]

/** The Evening table: same sheet, but H is headed "Nov" and it has an extra J column; no Q installment. */
const EVENING_MANIFEST = [
  manifestRow({ column_key: 'actual:F', source_header: 'Total Fee', normalized_role: 'total_fee', display_order: 1 }),
  manifestRow({ column_key: 'actual:G', source_header: 'August', display_order: 2 }),
  manifestRow({ column_key: 'actual:H', source_header: 'Nov', display_order: 3 }),
  manifestRow({ column_key: 'actual:I', source_header: 'Late Fees', normalized_role: 'late_fees', display_order: 4 }),
  manifestRow({ column_key: 'actual:J', source_header: 'Discount', normalized_role: 'discount', display_order: 5 }),
  manifestRow({ column_key: 'installment:P', section: 'installment', source_header: 'Enroll. Fee', normalized_role: 'enrollment', display_order: 1 }),
]

function buildPair() {
  const morningRecords = [
    record({
      id: 'm-1',
      batch_id: 'morning',
      legacy_source_row: 3,
      legacy_balance: '-865.00',
      legacy_total_paid: '11135.00',
      legacy_raw_json: {
        cells: {
          F: cell({ header: 'Total Fee ', raw_value: 12000 }),
          G: cell({ header: 'August', raw_value: 1000 }),
          I: cell({ header: 'Late fees', raw_value: 0 }),
        },
      },
    }),
    record({ id: 'm-2', batch_id: 'morning', legacy_source_row: 4 }),
  ]
  const eveningRecords = [
    record({
      id: 'e-1',
      batch_id: 'evening',
      legacy_source_row: 3,
      legacy_balance: '200.00',
      legacy_total_paid: '12200.00',
      legacy_raw_json: {
        cells: {
          F: cell({ header: 'Total Fee', raw_value: 12000 }),
          H: cell({ header: 'Nov', raw_value: 500 }),
          J: cell({ header: 'Discount', raw_value: 100 }),
        },
      },
    }),
  ]

  const morning = buildFinanceGrid({
    records: morningRecords,
    installments: [
      {
        id: 'i-1',
        student_finance_record_id: 'm-1',
        sequence_number: 2,
        scheduled_amount: '900.00',
        legacy_column_name: 'September',
        default_note: null,
        custom_note: null,
      },
    ],
    payments: [],
    manifest: MORNING_MANIFEST,
    programShortCode: 'PSW',
    batchName: '29th JULY, 2026 - Morning',
    batchId: 'morning',
    session: 'Morning',
  })
  const evening = buildFinanceGrid({
    records: eveningRecords,
    installments: [],
    payments: [],
    manifest: EVENING_MANIFEST,
    programShortCode: 'PSW',
    batchName: '29th JULY 2026 - Evening',
    batchId: 'evening',
    session: 'Evening',
  })

  return combineBatchGrids([
    { batchId: 'morning', batchName: '29th JULY, 2026 - Morning', session: 'Morning', grid: morning },
    { batchId: 'evening', batchName: '29th JULY 2026 - Evening', session: 'Evening', grid: evening },
  ])
}

describe('a combined intake keeps every row and its real batch', () => {
  const combined = buildPair()

  it('shows both cohorts under Session = All, Morning first, each in sheet order', () => {
    assert.deepEqual(
      combined.rows.map((row) => row.financeRecordId),
      ['m-1', 'm-2', 'e-1'],
    )
    assert.equal(combined.rows.length, 2 + 1)
  })

  it('preserves the underlying batch id and name on every row', () => {
    assert.deepEqual(
      combined.rows.map((row) => [row.batchId, row.batchName]),
      [
        ['morning', '29th JULY, 2026 - Morning'],
        ['morning', '29th JULY, 2026 - Morning'],
        ['evening', '29th JULY 2026 - Evening'],
      ],
    )
  })

  it('states the session per row', () => {
    assert.deepEqual(
      combined.rows.map((row) => row.session),
      ['Morning', 'Morning', 'Evening'],
    )
    assert.deepEqual(combined.sessionCounts, { Morning: 2, Evening: 1 })
  })

  it('the Morning filter shows only Morning rows', () => {
    const rows = filterRows(combined.rows, { session: 'morning' })
    assert.deepEqual(rows.map((row) => row.financeRecordId), ['m-1', 'm-2'])
  })

  it('the Evening filter shows only Evening rows', () => {
    const rows = filterRows(combined.rows, { session: 'evening' })
    assert.deepEqual(rows.map((row) => row.financeRecordId), ['e-1'])
  })

  it('does not duplicate a row by grouping', () => {
    assert.equal(new Set(combined.rows.map((row) => row.financeRecordId)).size, combined.rows.length)
  })
})

describe('the combined column manifest is a deterministic union in source order', () => {
  const combined = buildPair()
  const labels = combined.columns.map((column) => column.label)

  it('shows a column once when both tables share its key and heading, case aside', () => {
    assert.equal(labels.filter((label) => label === 'Total Fee').length, 1)
    assert.equal(labels.filter((label) => label === 'August').length, 1)
    // "Late fees" and "Late Fees" are the same column; the Morning spelling is shown.
    assert.equal(labels.filter((label) => /^late fees$/i.test(label)).length, 1)
    assert.ok(labels.includes('Late fees'))
  })

  it('shows two columns when the same letter carries a different heading, each labelled verbatim', () => {
    assert.ok(labels.includes('October'))
    assert.ok(labels.includes('Nov'))
  })

  it('preserves source order and places the Evening-only column where its sheet put it', () => {
    assert.deepEqual(labels, ['Total Fee', 'August', 'October', 'Nov', 'Late fees', 'Discount'])
  })

  it('records which sessions each column belongs to', () => {
    const bySessions = Object.fromEntries(combined.columns.map((column) => [column.label, column.sessions]))
    assert.deepEqual(bySessions['August'], ['Morning', 'Evening'])
    assert.deepEqual(bySessions['October'], ['Morning'])
    assert.deepEqual(bySessions['Nov'], ['Evening'])
    assert.deepEqual(bySessions['Discount'], ['Evening'])
  })

  it('names the other heading at a shared source position, and nothing else', () => {
    const byLabel = Object.fromEntries(
      combined.columns.map((column) => [column.label, column.conflictingHeadings]),
    )
    // The same letter, headed differently: each column names the other's heading.
    assert.deepEqual(byLabel['October'], ['Nov'])
    assert.deepEqual(byLabel['Nov'], ['October'])
    // Shared columns and single-table columns carry no conflict.
    assert.deepEqual(byLabel['Total Fee'], [])
    assert.deepEqual(byLabel['August'], [])
    assert.deepEqual(byLabel['Late fees'], [])
    assert.deepEqual(byLabel['Discount'], [])
    // Headings are still verbatim; nothing was merged or renamed.
    assert.ok(combined.columns.every((column) => column.label === column.label.trim()))
    assert.equal(combined.columns.filter((column) => /^(October|Nov)$/.test(column.label)).length, 2)
  })

  it('keeps ACTUAL and INSTALLMENT groups distinct, and unions installments too', () => {
    assert.deepEqual(
      combined.scheduledColumns.map((column) => column.label),
      ['Enroll. Fee', 'September'],
    )
    assert.ok(combined.columns.every((column) => column.section === 'actual'))
    assert.ok(combined.scheduledColumns.every((column) => column.section === 'installment'))
  })

  it('is deterministic whichever part is listed first', () => {
    const column = (key: string, label: string, order: number): FinanceColumn => ({
      key, label, section: 'actual', role: 'other', valueKind: 'money', order, unheaded: false, origin: 'manifest', sessions: [], conflictingHeadings: [],
    })
    const a = [column('actual:F', 'A', 1), column('actual:G', 'B', 2)]
    const b = [column('actual:F', 'A', 1), column('actual:H', 'C', 3)]
    const forward = unionColumns([{ session: 'Morning', columns: a }, { session: 'Evening', columns: b }])
    const backward = unionColumns([{ session: 'Evening', columns: b }, { session: 'Morning', columns: a }])
    // Morning's order leads; Evening's extra column follows the column that
    // precedes it in Evening's own order. Either way, the same set of keys.
    assert.deepEqual(forward.columns.map((column) => column.key), ['actual:F', 'actual:H', 'actual:G'])
    assert.deepEqual(backward.columns.map((column) => column.key), ['actual:F', 'actual:G', 'actual:H'])
    assert.deepEqual(
      [...forward.columns.map((column) => column.key)].sort(),
      [...backward.columns.map((column) => column.key)].sort(),
    )
  })
})

describe('a column one table lacks is blank for the other table’s rows — not zero', () => {
  const combined = buildPair()
  const keyOf = (label: string) => combined.columns.find((column) => column.label === label)!.key
  const morningRow = combined.rows.find((row) => row.financeRecordId === 'm-1')!
  const eveningRow = combined.rows.find((row) => row.financeRecordId === 'e-1')!

  it('a Morning-only column renders blank for an Evening row', () => {
    const october = eveningRow.actualCells[keyOf('October')]
    assert.equal(october.kind, 'blank')
    assert.equal(displayMoney(october), '—')
  })

  it('an Evening-only column renders blank for a Morning row', () => {
    assert.equal(displayMoney(morningRow.actualCells[keyOf('Discount')]), '—')
    assert.equal(displayMoney(morningRow.actualCells[keyOf('Nov')]), '—')
  })

  it('a Morning-only installment column is blank for the Evening row', () => {
    const september = combined.scheduledColumns.find((column) => column.label === 'September')!.key
    assert.equal(displayMoney(eveningRow.scheduledCells[september]), '—')
    assert.equal(displayMoney(morningRow.scheduledCells[september]), '$900.00')
  })

  it('keeps each row’s own values under the shared and split columns', () => {
    assert.equal(displayMoney(morningRow.actualCells[keyOf('Total Fee')]), '$12,000.00')
    assert.equal(displayMoney(eveningRow.actualCells[keyOf('Total Fee')]), '$12,000.00')
    assert.equal(displayMoney(morningRow.actualCells[keyOf('August')]), '$1,000.00')
    assert.equal(displayMoney(eveningRow.actualCells[keyOf('Nov')]), '$500.00')
    assert.equal(displayMoney(eveningRow.actualCells[keyOf('Discount')]), '$100.00')
  })

  it('blank is not zero: a recorded 0 still shows $0.00 beside a blank', () => {
    assert.equal(displayMoney(morningRow.actualCells[keyOf('Late fees')]), '$0.00')
    assert.equal(displayMoney(eveningRow.actualCells[keyOf('Late fees')]), '—')
  })

  it('counts the structural blank columns over the combined rows', () => {
    // October: the Morning table has it, nobody filled it, and Evening rows
    // are blank by absence. Enroll. Fee: both installment manifests list it
    // and no installment row fills it. Two columns, stated once in the strip.
    assert.equal(combined.blankStructuralColumns, 2)
    assert.equal(combined.layoutSource, 'manifest')
  })
})

describe('totals and status counts sum both cohorts once', () => {
  const combined = buildPair()

  it('sums snapshots across both batches without double counting', () => {
    assert.equal(combined.totals.students, 3)
    assert.equal(displayMoney(combined.totals.totalFees), '$36,000.00')
    assert.equal(displayMoney(combined.totals.totalPaid), '$35,335.00')
    assert.equal(displayMoney(combined.totals.balance), '-$665.00')
    assert.equal(combined.totals.balanceMissing, 0)
  })

  it('reports status counts with the same derivation the rows carry', () => {
    assert.deepEqual(combined.statusCounts, { outstanding: 1, settled: 1, credit: 1, unknown: 0 })
    assert.deepEqual(
      combined.rows.map((row) => row.paymentStatus),
      ['outstanding', 'settled', 'credit'],
    )
  })

  it('carries one convention summary per underlying batch', () => {
    assert.deepEqual(
      combined.batchConventions.map((entry) => [entry.batchId, entry.session, entry.result.convention]),
      [
        ['morning', 'Morning', 'paid_minus_fee'],
        ['evening', 'Evening', 'paid_minus_fee'],
      ],
    )
    assert.equal(combined.balanceConvention.convention, 'paid_minus_fee')
    assert.match(combined.balanceConvention.note, /Morning: verified across 2/)
  })

  it('leaves a missing snapshot missing in the intake total', () => {
    const morning = buildFinanceGrid({
      records: [record({ id: 'a', batch_id: 'morning', legacy_total_fee: null })],
      installments: [],
      payments: [],
      programShortCode: 'PSW',
      batchName: 'M',
      batchId: 'morning',
      session: 'Morning',
    })
    const evening = buildFinanceGrid({
      records: [record({ id: 'b', batch_id: 'evening', legacy_total_fee: '100.00' })],
      installments: [],
      payments: [],
      programShortCode: 'PSW',
      batchName: 'E',
      batchId: 'evening',
      session: 'Evening',
    })
    const combinedPair = combineBatchGrids([
      { batchId: 'morning', batchName: 'M', session: 'Morning', grid: morning },
      { batchId: 'evening', batchName: 'E', session: 'Evening', grid: evening },
    ])
    assert.equal(displayMoney(combinedPair.totals.totalFees), '$100.00')
    assert.equal(combinedPair.totals.feesMissing, 1)
  })
})

describe('each cohort’s status is read under its own batch’s convention', () => {
  it('a verified Morning and an unverifiable Evening give Unknown only to Evening rows', () => {
    const morning = buildFinanceGrid({
      records: [record({ id: 'm', batch_id: 'morning', legacy_balance: '-100.00', legacy_total_paid: '11900.00' })],
      installments: [],
      payments: [],
      programShortCode: 'PSW',
      batchName: 'M',
      batchId: 'morning',
      session: 'Morning',
    })
    const evening = buildFinanceGrid({
      // A negative balance, but no fee and paid to verify the sign against.
      records: [record({ id: 'e', batch_id: 'evening', legacy_total_fee: null, legacy_total_paid: null, legacy_balance: '-100.00' })],
      installments: [],
      payments: [],
      programShortCode: 'PSW',
      batchName: 'E',
      batchId: 'evening',
      session: 'Evening',
    })
    const combined = combineBatchGrids([
      { batchId: 'morning', batchName: 'M', session: 'Morning', grid: morning },
      { batchId: 'evening', batchName: 'E', session: 'Evening', grid: evening },
    ])
    assert.deepEqual(
      combined.rows.map((row) => [row.session, row.paymentStatus]),
      [
        ['Morning', 'outstanding'],
        ['Evening', 'unknown'],
      ],
    )
    assert.equal(combined.balanceConvention.convention, 'unverifiable')
    assert.match(combined.balanceConvention.note, /Evening: no student records all three figures/)
  })
})

describe('search and selection operate across the combined intake', () => {
  const combined = buildPair()

  it('search finds an Evening student while Session = All', () => {
    const rows = filterRows(combined.rows, { search: 'eveningstudent' })
    assert.deepEqual(rows.map((row) => row.session), ['Evening'])
  })

  it('search respects Session = Morning rather than ignoring it', () => {
    assert.equal(filterRows(combined.rows, { search: 'eveningstudent', session: 'morning' }).length, 0)
    assert.equal(filterRows(combined.rows, { search: 'morningstudent', session: 'morning' }).length, 2)
  })

  it('search matches a student number across both cohorts', () => {
    const number = combined.rows[2].studentNumber!
    const rows = filterRows(combined.rows, { search: number })
    assert.deepEqual(rows.map((row) => row.financeRecordId), ['e-1'])
  })

  it('select-all selects only the rows currently visible after the filters', () => {
    const visible = filterRows(combined.rows, { session: 'morning', status: 'outstanding' })
    const visibleIds = visible.map((row) => row.financeRecordId)
    assert.deepEqual(visibleIds, ['m-1'])

    const selection = toggleVisible({}, visibleIds, true)
    assert.deepEqual(Object.keys(selection), ['m-1'])
    assert.equal(allVisibleSelected(selection, visibleIds), true)

    // Widening the view: the selection stays what it was, now partial.
    const allIds = combined.rows.map((row) => row.financeRecordId)
    assert.equal(allVisibleSelected(selection, allIds), false)
    assert.equal(someVisibleSelected(selection, allIds), true)

    // Deselecting the visible rows leaves rows hidden by the filter untouched.
    const wider = toggleVisible(selection, allIds, true)
    const narrowed = toggleVisible(wider, ['e-1'], false)
    assert.deepEqual(Object.keys(narrowed).sort(), ['m-1', 'm-2'])
  })
})
