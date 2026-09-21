/**
 * FINANCE-COLUMN-MANIFEST-03A — the manifest drives structure, rows drive values.
 *
 * Every test here builds the grid the way the loader does: records with their
 * preserved cells, normalized installments, and the batch's manifest rows. The
 * rule under test is the one the ticket states: a column exists because the
 * manifest says so; a cell has a value because the student's record says so;
 * and where the two meet with no value, the cell is blank and never `$0.00`.
 */

import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { LegacyCell } from './legacy-cells.ts'
import type { RawManifestColumn } from './manifest.ts'
import { displayMoney } from './money.ts'
import {
  buildFinanceGrid,
  type RawFinanceRecord,
  type RawInstallment,
} from './view-model.ts'

// -----------------------------------------------------------------------------
// Builders
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
  return {
    id: partial.id ?? nextId('rec'),
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
    student_finance_record_id: 'rec-a',
    sequence_number: 1,
    scheduled_amount: null,
    legacy_column_name: null,
    default_note: null,
    custom_note: null,
    ...partial,
  }
}

function manifestRow(partial: Partial<RawManifestColumn>): RawManifestColumn {
  return {
    column_key: 'actual:G',
    section: 'actual',
    source_column_letter: 'G',
    source_header: 'Total Fee ',
    normalized_role: 'total_fee',
    value_kind: 'money',
    display_order: 1,
    is_grid_visible: true,
    display_even_if_blank: true,
    ...partial,
  }
}

/**
 * A PSW-shaped ACTUAL manifest: fee, a month everyone paid, a month nobody
 * did, Late Fees, Total Paid, an unheaded outstanding column, REMARKS, Payer.
 */
function pswActualManifest(): RawManifestColumn[] {
  return [
    manifestRow({ column_key: 'actual:G', source_column_letter: 'G', source_header: 'Total Fee ', normalized_role: 'total_fee', display_order: 1 }),
    manifestRow({ column_key: 'actual:H', source_column_letter: 'H', source_header: 'August', normalized_role: 'month', display_order: 2 }),
    manifestRow({ column_key: 'actual:J', source_column_letter: 'J', source_header: 'October', normalized_role: 'month', display_order: 3 }),
    manifestRow({ column_key: 'actual:K', source_column_letter: 'K', source_header: 'Late Fees', normalized_role: 'late_fees', display_order: 4 }),
    manifestRow({ column_key: 'actual:L', source_column_letter: 'L', source_header: 'Total Paid', normalized_role: 'total_paid', display_order: 5 }),
    manifestRow({ column_key: 'actual:M', source_column_letter: 'M', source_header: null, normalized_role: 'other', display_order: 6 }),
    manifestRow({ column_key: 'actual:R', source_column_letter: 'R', source_header: 'REMARKS', normalized_role: 'remarks', value_kind: 'text', is_grid_visible: false, display_order: 7 }),
    manifestRow({ column_key: 'actual:S', source_column_letter: 'S', source_header: 'Payer', normalized_role: 'payer', value_kind: 'text', is_grid_visible: false, display_order: 8 }),
  ]
}

function pswInstallmentManifest(): RawManifestColumn[] {
  return [
    manifestRow({ column_key: 'installment:P', section: 'installment', source_column_letter: 'P', source_header: 'Enroll. Fee', normalized_role: 'enrollment', display_order: 1 }),
    manifestRow({ column_key: 'installment:Q', section: 'installment', source_column_letter: 'Q', source_header: 'September', normalized_role: 'month', display_order: 2 }),
    manifestRow({ column_key: 'installment:R', section: 'installment', source_column_letter: 'R', source_header: 'October', normalized_role: 'month', display_order: 3 }),
  ]
}

/** Two students; nobody has an October, a Late Fee, a remark or a payer. */
function pswRecords(): RawFinanceRecord[] {
  return [
    record({
      id: 'rec-a',
      legacy_source_row: 3,
      legacy_total_fee: '5000',
      legacy_total_paid: '1500',
      legacy_balance: '-3500',
      legacy_raw_json: {
        cells: {
          G: cell({ header: 'Total Fee ', raw_value: 5000 }),
          H: cell({ header: 'August', raw_value: 1000 }),
          L: cell({ header: 'Total Paid', raw_value: 1500 }),
          M: cell({ header: null, raw_value: -3500, formula: 'L3-G3' }),
        },
      },
    }),
    record({
      id: 'rec-b',
      legacy_source_row: 4,
      legacy_total_fee: '4000',
      legacy_total_paid: '0',
      legacy_balance: '-4000',
      legacy_raw_json: {
        cells: {
          G: cell({ header: 'Total Fee ', raw_value: 4000 }),
          H: cell({ header: 'August', raw_value: 0 }),
          L: cell({ header: 'Total Paid', raw_value: 0 }),
          M: cell({ header: null, raw_value: -4000, formula: 'L4-G4' }),
        },
      },
    }),
  ]
}

function buildWithManifest(
  manifest: RawManifestColumn[],
  installments: RawInstallment[] = [],
  records: RawFinanceRecord[] = pswRecords(),
) {
  return buildFinanceGrid({
    records,
    installments,
    payments: [],
    manifest,
    programShortCode: 'PSW',
    batchName: '29th JULY 2026 - Evening',
  })
}

const DASH = '—'

// -----------------------------------------------------------------------------
// ACTUAL
// -----------------------------------------------------------------------------

describe('the manifest drives column presence and order', () => {
  it('shows every visible manifest column, in manifest order, whether or not any row fills it', () => {
    const built = buildWithManifest(pswActualManifest())
    assert.deepEqual(
      built.columns.map((column) => column.label),
      ['Total Fee', 'August', 'October', 'Late Fees', 'Total Paid', 'Column M'],
    )
    assert.ok(built.columns.every((column) => column.origin === 'manifest'))
    assert.equal(built.layoutSource, 'manifest')
  })

  it('October does not disappear merely because every row is blank', () => {
    const built = buildWithManifest(pswActualManifest())
    const october = built.columns.find((column) => column.label === 'October')
    assert.ok(october)
    for (const row of built.rows) assert.equal(row.actualCells[october.key].kind, 'blank')
  })

  it('Late Fees does not disappear merely because every row is blank', () => {
    const built = buildWithManifest(pswActualManifest())
    const lateFees = built.columns.find((column) => column.label === 'Late Fees')
    assert.ok(lateFees)
    assert.equal(lateFees.role, 'late_fees')
    for (const row of built.rows) assert.equal(displayMoney(row.actualCells[lateFees.key]), DASH)
  })

  it('a manifest-backed blank renders as an em dash, never as $0.00', () => {
    const built = buildWithManifest(pswActualManifest())
    const october = built.columns.find((column) => column.label === 'October')!
    assert.deepEqual(
      built.rows.map((row) => displayMoney(row.actualCells[october.key])),
      [DASH, DASH],
    )
  })

  it('an actual zero still displays $0.00 and a negative stays negative', () => {
    const built = buildWithManifest(pswActualManifest())
    const august = built.columns.find((column) => column.label === 'August')!
    const outstanding = built.columns.find((column) => column.label === 'Column M')!
    const [a, b] = built.rows
    assert.equal(displayMoney(b.actualCells[august.key]), '$0.00')
    assert.equal(displayMoney(a.actualCells[outstanding.key]), '-$3,500.00')
    assert.equal(displayMoney(b.actualCells[outstanding.key]), '-$4,000.00')
  })

  it('REMARKS and Payer are kept out of the ACTUAL money group', () => {
    const built = buildWithManifest(pswActualManifest())
    assert.equal(built.columns.some((column) => column.label === 'REMARKS'), false)
    assert.equal(built.columns.some((column) => column.label === 'Payer'), false)
    // And their cells do not travel to the browser under any key.
    for (const row of built.rows) {
      assert.equal('actual:R' in row.actualCells, false)
      assert.equal('actual:S' in row.actualCells, false)
    }
  })

  it('a hidden text column stays hidden even when a row holds a value in it', () => {
    const records = pswRecords()
    ;(records[0].legacy_raw_json as { cells: Record<string, unknown> }).cells.R = cell({
      header: 'REMARKS',
      cell_type: 's',
      raw_value: 'paid by cheque',
    })
    const built = buildWithManifest(pswActualManifest(), [], records)
    // The letter is accounted for by the manifest, so it is not resurrected as
    // a derived column either.
    assert.equal(built.columns.some((column) => column.key === 'actual:R'), false)
    assert.equal(JSON.stringify(built).includes('paid by cheque'), false)
  })

  it('a source typo in a heading is displayed verbatim', () => {
    const built = buildWithManifest([
      manifestRow({ column_key: 'actual:N', source_column_letter: 'N', source_header: 'Marc', normalized_role: 'other', display_order: 1 }),
    ])
    assert.equal(built.columns[0].label, 'Marc')
    assert.equal(built.columns[0].role, 'other')
  })

  it('an unheaded manifest column keeps the safe fallback label', () => {
    const built = buildWithManifest(pswActualManifest())
    const unheaded = built.columns.find((column) => column.unheaded)
    assert.equal(unheaded?.label, 'Column M')
  })

  it('counts the structural blank columns once, for the summary strip', () => {
    const built = buildWithManifest(pswActualManifest())
    // October and Late Fees.
    assert.equal(built.blankStructuralColumns, 2)
  })

  it('a value in a letter the manifest does not describe is appended, never hidden', () => {
    const records = pswRecords()
    ;(records[1].legacy_raw_json as { cells: Record<string, unknown> }).cells.T = cell({
      header: 'Discount',
      raw_value: 100,
    })
    const built = buildWithManifest(pswActualManifest(), [], records)
    const last = built.columns[built.columns.length - 1]
    assert.equal(last.label, 'Discount')
    assert.equal(last.origin, 'derived')
    assert.equal(displayMoney(built.rows[1].actualCells[last.key]), '$100.00')
  })

  it('falls back to the row union, and says so, when a batch has no manifest', () => {
    const built = buildWithManifest([])
    assert.equal(built.layoutSource, 'derived')
    assert.ok(built.columns.every((column) => column.origin === 'derived'))
    // The union cannot show October: that is the limitation the manifest fixes.
    assert.equal(built.columns.some((column) => column.label === 'October'), false)
  })

  it('a manifest column marked not-display-even-if-blank is omitted when nobody fills it', () => {
    const built = buildWithManifest(
      pswActualManifest().map((row) =>
        row.column_key === 'actual:J' ? { ...row, display_even_if_blank: false } : row,
      ),
    )
    assert.equal(built.columns.some((column) => column.label === 'October'), false)
    assert.ok(built.columns.some((column) => column.label === 'Late Fees'))
  })
})

// -----------------------------------------------------------------------------
// INSTALLMENT
// -----------------------------------------------------------------------------

describe('the installment manifest describes structure; normalized rows supply values', () => {
  it('lines installments up under their manifest column by sequence number', () => {
    const built = buildWithManifest(
      [...pswActualManifest(), ...pswInstallmentManifest()],
      [
        installment({ student_finance_record_id: 'rec-a', sequence_number: 1, legacy_column_name: 'Enroll. Fee', scheduled_amount: '500' }),
        installment({ student_finance_record_id: 'rec-a', sequence_number: 2, legacy_column_name: 'September', scheduled_amount: '1000' }),
      ],
    )
    assert.deepEqual(
      built.scheduledColumns.map((column) => [column.key, column.label]),
      [
        ['installment:P', 'Enroll. Fee'],
        ['installment:Q', 'September'],
        ['installment:R', 'October'],
      ],
    )
    const [a, b] = built.rows
    assert.equal(displayMoney(a.scheduledCells['installment:P']), '$500.00')
    assert.equal(displayMoney(a.scheduledCells['installment:Q']), '$1,000.00')
    // No installment row exists for October: blank, and no fake installment.
    assert.equal(displayMoney(a.scheduledCells['installment:R']), DASH)
    assert.equal(displayMoney(b.scheduledCells['installment:P']), DASH)
  })

  it('a manifest schedule column nobody has an installment in is still present, blank', () => {
    const built = buildWithManifest([...pswActualManifest(), ...pswInstallmentManifest()], [])
    assert.equal(built.scheduledColumns.length, 3)
    for (const row of built.rows) {
      for (const column of built.scheduledColumns) {
        assert.equal(row.scheduledCells[column.key].kind, 'blank')
      }
    }
  })

  it('an installment whose heading disagrees with the manifest position gets its own column, not a wrong one', () => {
    const built = buildWithManifest(
      [...pswActualManifest(), ...pswInstallmentManifest()],
      [installment({ student_finance_record_id: 'rec-a', sequence_number: 2, legacy_column_name: 'November', scheduled_amount: '900' })],
    )
    const derived = built.scheduledColumns.find((column) => column.origin === 'derived')
    assert.ok(derived)
    assert.equal(derived.label, 'November')
    assert.equal(displayMoney(built.rows[0].scheduledCells[derived.key]), '$900.00')
    assert.equal(displayMoney(built.rows[0].scheduledCells['installment:Q']), DASH)
  })

  it('ECEA: Balance exists structurally, stays blank, and is never calculated', () => {
    const eceaManifest = [
      manifestRow({ column_key: 'actual:J', source_column_letter: 'J', source_header: 'Total fees', normalized_role: 'total_fee', display_order: 1 }),
      manifestRow({ column_key: 'actual:O', source_column_letter: 'O', source_header: 'Total Paid', normalized_role: 'total_paid', display_order: 2 }),
      manifestRow({ column_key: 'actual:P', source_column_letter: 'P', source_header: 'Balance', normalized_role: 'balance', display_order: 3 }),
    ]
    const built = buildFinanceGrid({
      records: [
        record({
          id: 'ecea-1',
          legacy_total_fee: '3000',
          legacy_total_paid: '1000',
          legacy_balance: null,
          legacy_raw_json: {
            cells: {
              J: cell({ header: 'Total fees', section: 'flat', raw_value: 3000 }),
              O: cell({ header: 'Total Paid', section: 'flat', raw_value: 1000 }),
            },
          },
        }),
      ],
      installments: [],
      payments: [],
      manifest: eceaManifest,
      programShortCode: 'ECEA',
      batchName: 'ELCE 25 & 26',
    })

    const balance = built.columns.find((column) => column.label === 'Balance')
    assert.ok(balance, 'Balance column exists because the manifest says so')
    assert.equal(displayMoney(built.rows[0].actualCells[balance.key]), DASH)
    assert.equal(built.rows[0].legacyBalance.kind, 'blank')
    // Not fee - paid, not $0.00, not anything.
    assert.notEqual(displayMoney(built.rows[0].actualCells[balance.key]), '-$2,000.00')
    assert.equal(built.totals.balance.kind, 'blank')
    assert.equal(built.totals.balanceMissing, 1)
    assert.equal(built.balanceConvention.filterable, false)
    // No installment group is manufactured for the ordinal roster.
    assert.deepEqual(built.scheduledColumns, [])
    assert.equal(built.blankStructuralColumns, 1)
  })

  it('a structural blank contributes nothing to the summary, not zero', () => {
    const built = buildWithManifest(pswActualManifest())
    assert.equal(displayMoney(built.totals.totalFees), '$9,000.00')
    assert.equal(displayMoney(built.totals.totalPaid), '$1,500.00')
    assert.equal(built.totals.feesMissing, 0)
  })

  it('no raw manifest fields reach the serialised view', () => {
    const built = buildWithManifest([...pswActualManifest(), ...pswInstallmentManifest()])
    const json = JSON.stringify(built)
    for (const field of [
      'source_column_letter',
      'source_workbook_hash',
      'legacy_table_key',
      'is_grid_visible',
      '"letter"',
      '"visible"',
    ]) {
      assert.equal(json.includes(field), false, `${field} must not be serialised`)
    }
  })
})
