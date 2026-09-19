import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  planBatchFinanceRecords,
  planUnassignedFinanceRecord,
  resolveSummaryColumns,
  resolveUnassignedTotalFee,
} from './finance-records.mts'
import { buildSourceTable } from './source-tables.mts'
import { findBlocks } from '../lib/blocks.mts'
import { BLANK, pswBatchSheet, rangeOf, sheetFromRows } from './fixtures.mts'

const HASH = '62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2'

function pswTable() {
  const sheet = pswBatchSheet()
  const blocks = findBlocks(sheet, rangeOf(sheet))
  return buildSourceTable('12th May 2025', sheet, blocks[0], 'psw_batch')
}

function planFor() {
  return planBatchFinanceRecords(
    HASH,
    pswTable(),
    'PSW',
    'batch-key',
    (row) => (row.studentNumber === null ? null : `student:${row.studentNumber}`),
  )
}

describe('the legacy summary columns are resolved from the table itself', () => {
  it('takes the fee, paid and balance columns from the ACTUAL section', () => {
    const columns = resolveSummaryColumns(pswTable())

    assert.equal(columns.totalFee?.letter, 'E')
    assert.equal(columns.totalPaid?.letter, 'I')
    // J has no heading at all; it is recognised by its Total Paid − Total Fee
    // formula, not by its position.
    assert.equal(columns.balance?.letter, 'J')
  })

  it('never takes a figure from the INSTALLMENT section', () => {
    const columns = resolveSummaryColumns(pswTable())
    for (const column of [columns.totalFee, columns.totalPaid, columns.balance]) {
      assert.notEqual(column?.section, 'installment')
    }
  })

  it('records why each field resolved as it did', () => {
    const columns = resolveSummaryColumns(pswTable())
    assert.equal(columns.evidence.length, 3)
    assert.match(columns.evidence.join('\n'), /legacy_balance from J/)
  })
})

describe('totals rows are excluded, everywhere', () => {
  it('creates no finance record for a row with money and no student', () => {
    const result = planFor()

    assert.equal(result.records.length, 2)
    assert.equal(result.totalsRowsExcluded.length, 1)
    assert.equal(result.totalsRowsExcluded[0].row, 5)
  })

  it('does not let a totals line become a student', () => {
    const result = planFor()
    assert.equal(
      result.records.some((record) => record.legacySourceRow === 5),
      false,
    )
  })
})

describe('a blank is not a zero', () => {
  it('leaves a legacy field null when the source cell is blank', () => {
    // A table whose Total Fee column is empty for the student row.
    const sheet = sheetFromRows([
      ['PSW Morning Batch - 12th May 2025'],
      ['Sr. No. ', 'Student ID ', 'First Name ', 'Total Fee', 'Total Paid', 'Total Fee'],
      [1, 125001, 'Asha', BLANK, BLANK, 5000],
    ])
    const blocks = findBlocks(sheet, rangeOf(sheet))
    const table = buildSourceTable('12th May 2025', sheet, blocks[0], 'psw_batch')

    const result = planBatchFinanceRecords(HASH, table, 'PSW', 'batch', (row) =>
      row.studentNumber === null ? null : `student:${row.studentNumber}`,
    )

    assert.equal(result.records[0].legacyTotalFee.value, null)
    assert.match(result.records[0].legacyTotalFee.note ?? '', /not zero/)
  })

  it('keeps an explicit zero as zero', () => {
    const sheet = sheetFromRows([
      ['PSW Morning Batch - 12th May 2025'],
      ['Sr. No. ', 'Student ID ', 'First Name ', 'Total Fee', 'Total Paid', 'Total Fee'],
      [1, 125001, 'Asha', 0, BLANK, 5000],
    ])
    const blocks = findBlocks(sheet, rangeOf(sheet))
    const table = buildSourceTable('12th May 2025', sheet, blocks[0], 'psw_batch')

    const result = planBatchFinanceRecords(HASH, table, 'PSW', 'batch', (row) =>
      row.studentNumber === null ? null : `student:${row.studentNumber}`,
    )

    assert.equal(result.records[0].legacyTotalFee.value, 0)
    assert.equal(result.records[0].legacyTotalFee.note, null)
  })
})

describe('legacy figures are copied, never computed', () => {
  it('stores the workbook’s own Total Paid without recomputing it', () => {
    const record = planFor().records[0]
    // The fixture's SUM says 1500. Nothing re-adds the month columns.
    assert.equal(record.legacyTotalPaid.value, 1500)
    assert.equal(record.legacyTotalPaid.formula, 'SUM(F3:H3)')
  })

  it('stores the balance the sheet states, negative and all', () => {
    const record = planFor().records[0]
    assert.equal(record.legacyBalance.value, -3500)
    assert.equal(record.legacyBalance.formula, 'I3-E3')
  })

  it('keeps the full source row for the ACTUAL cells that become no payment', () => {
    const record = planFor().records[0]
    const cells = record.legacyRawJson.cells as Record<string, { section: string }>

    // The ACTUAL month cells are preserved here precisely because they are not
    // imported as payments; this is the only place they survive.
    assert.equal(cells.G.section, 'actual')
    assert.equal(cells.M.section, 'installment')
  })
})

describe('rows that name a student but state no number', () => {
  const sheet = sheetFromRows([
    ['PSW Morning Batch - 12th May 2025'],
    ['Sr. No. ', 'Student ID ', 'First Name ', 'Total Fee', 'Total Paid', 'Total Fee'],
    [1, BLANK, 'Nameless', 5000, 1000, 5000],
  ])

  function planWith(resolve: (row: { studentNumber: string | null }) => string | null) {
    const blocks = findBlocks(sheet, rangeOf(sheet))
    const table = buildSourceTable('12th May 2025', sheet, blocks[0], 'psw_batch')
    return planBatchFinanceRecords(HASH, table, 'PSW', 'batch', resolve)
  }

  it('gets a batch-specific record rather than being dropped', () => {
    // The caller hands back the unresolved student planned for this exact row.
    const result = planWith(() => 'unresolved-student:row-3')

    assert.equal(result.records.length, 1)
    assert.equal(result.records[0].studentSourceKey, 'unresolved-student:row-3')
    assert.equal(result.records[0].batchSourceKey, 'batch')
    assert.equal(result.rowsWithoutStudentNumber.length, 1)
  })

  it('preserves the row’s finance snapshot exactly', () => {
    const record = planWith(() => 'unresolved-student:row-3').records[0]

    assert.equal(record.legacyTotalFee.value, 5000)
    assert.equal(record.legacyTotalPaid.value, 1000)
  })

  it('manufactures no student number', () => {
    const record = planWith(() => 'unresolved-student:row-3').records[0]
    assert.equal(record.studentNumber, null)
  })

  it('reports a row it could not resolve to any student at all', () => {
    // No student planned for it: that row would be dropped, so it is surfaced.
    const result = planWith(() => null)

    assert.equal(result.records.length, 0)
    assert.equal(result.rowsWithNoResolvableStudent.length, 1)
  })
})

describe('Enrollment Total Fees on an unassigned record', () => {
  it('uses a single stated value', () => {
    const resolved = resolveUnassignedTotalFee([{ row: 4, value: 5000 }])
    assert.equal(resolved.value, 5000)
  })

  it('uses a value restated identically on a later row', () => {
    const resolved = resolveUnassignedTotalFee([
      { row: 4, value: 5000 },
      { row: 9, value: 5000 },
    ])
    assert.equal(resolved.value, 5000)
  })

  it('refuses to choose between conflicting values', () => {
    const resolved = resolveUnassignedTotalFee([
      { row: 4, value: 5000 },
      { row: 9, value: 4000 },
    ])

    assert.equal(resolved.value, null)
    assert.deepEqual(resolved.conflicting.sort(), [4000, 5000])
    assert.match(resolved.note, /left null rather than choosing/)
  })

  it('leaves the field null when no row states one', () => {
    assert.equal(resolveUnassignedTotalFee([]).value, null)
  })
})

describe('an unassigned record never carries a Tracker Master balance', () => {
  it('leaves legacy_balance null and says why', () => {
    const record = planUnassignedFinanceRecord(
      HASH,
      'student:125001',
      '125001',
      'PSW',
      resolveUnassignedTotalFee([{ row: 4, value: 5000 }]),
      'ambiguous_batch',
    )

    assert.equal(record.batchSourceKey, null)
    assert.equal(record.legacyBalance.value, null)
    assert.match(record.legacyBalance.note ?? '', /row-local formula/)
  })

  it('reuses one record per student and program', () => {
    const first = planUnassignedFinanceRecord(
      HASH,
      'student:125001',
      '125001',
      'PSW',
      resolveUnassignedTotalFee([]),
      'ambiguous_batch',
    )
    const second = planUnassignedFinanceRecord(
      HASH,
      'student:125001',
      '125001',
      'PSW',
      resolveUnassignedTotalFee([]),
      'batch_not_found',
    )

    assert.equal(first.sourceKey, second.sourceKey)
  })
})
