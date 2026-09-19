import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { defaultNoteFor, planInstallments, scheduleColumns } from './installments.mts'
import { buildSourceTable } from './source-tables.mts'
import { findBlocks } from '../lib/blocks.mts'
import { planBatchFinanceRecords } from './finance-records.mts'
import { BLANK, pswBatchSheet, rangeOf, sheetFromRows } from './fixtures.mts'

const HASH = '62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2'

function pswTable() {
  const sheet = pswBatchSheet()
  const blocks = findBlocks(sheet, rangeOf(sheet))
  return buildSourceTable('12th May 2025', sheet, blocks[0], 'psw_batch')
}

function planFor() {
  // Both student rows (3 and 4) have a finance record; the totals line does not.
  return planInstallments(HASH, pswTable(), (row) => (row === 5 ? null : `record:${row}`))
}

describe('only the scheduled section creates installments', () => {
  it('takes its columns from the INSTALLMENT section alone', () => {
    const { columns } = scheduleColumns(pswTable())
    const letters = columns.map((entry) => entry.column.letter).sort()

    // L, M and N are the scheduled Enroll. Fee, May and June.
    assert.deepEqual(letters, ['L', 'M', 'N'])
  })

  it('never reads the identically-named columns in the ACTUAL section', () => {
    const { columns } = scheduleColumns(pswTable())
    for (const entry of columns) {
      assert.equal(entry.column.section, 'installment')
    }
    // F, G and H are the ACTUAL Enroll. Fee, May and June. They record money
    // received, and reading them here is how an import doubles a student's plan.
    const letters = columns.map((entry) => entry.column.letter)
    for (const actual of ['F', 'G', 'H']) assert.equal(letters.includes(actual), false)
  })

  it('excludes the scheduled section’s own Total Fee', () => {
    const { columns, excluded } = scheduleColumns(pswTable())

    assert.equal(columns.some((entry) => entry.column.letter === 'K'), false)
    const total = excluded.find((entry) => entry.letter === 'K')
    assert.match(total?.reason ?? '', /total of the scheduled plan/)
  })

  it('creates no payment of any kind', () => {
    // Installments are a plan. Nothing in this module produces a payment, and
    // the planned rows carry a scheduled amount rather than an amount.
    const { installments } = planFor()
    for (const installment of installments) {
      assert.equal('amount' in installment, false)
      assert.equal(typeof installment.scheduledAmount === 'number', true)
    }
  })
})

describe('a blank schedule cell creates nothing', () => {
  it('skips the blank and counts it', () => {
    const { installments, blankCellCount } = planFor()

    // Row 3 schedules Enroll. Fee and May but leaves June blank; row 4 fills
    // all three. Five installments, one blank.
    assert.equal(installments.length, 5)
    assert.equal(blankCellCount, 1)
  })

  it('keeps an explicitly scheduled zero as zero', () => {
    const { installments } = planFor()
    const zero = installments.find(
      (installment) => installment.legacySourceRow === 4 && installment.legacyColumnName === 'June',
    )

    assert.equal(zero?.scheduledAmount, 0)
  })

  it('does not create a June instalment for the row that left it blank', () => {
    const { installments } = planFor()
    const june = installments.filter(
      (installment) => installment.legacySourceRow === 3 && installment.legacyColumnName === 'June',
    )

    assert.equal(june.length, 0)
  })
})

describe('no date is invented for a month column', () => {
  it('leaves installment_month null on every planned installment', () => {
    for (const installment of planFor().installments) {
      assert.equal(installment.installmentMonth, null)
    }
  })

  it('preserves the month label instead', () => {
    const may = planFor().installments.find(
      (installment) => installment.legacyColumnName === 'May' && installment.legacySourceRow === 3,
    )

    assert.equal(may?.installmentType, 'monthly')
    assert.equal(may?.monthNumber, 5)
    assert.equal(may?.defaultNote, 'May installment')
  })
})

describe('installment types and default notes', () => {
  it('names the enrolment fee', () => {
    assert.equal(defaultNoteFor('enrollment', 'Enroll. Fee', null), 'Enrolment fee')
  })

  it('names a monthly instalment by its month', () => {
    assert.equal(defaultNoteFor('monthly', 'Sept', 9), 'September installment')
  })

  it('keeps an ordinal ordinal rather than forcing it into a month', () => {
    assert.equal(defaultNoteFor('other', '1st Installment', null), '1st installment')
    assert.equal(defaultNoteFor('other', '2nd Installment', null), '2nd installment')
  })

  it('falls back to the source heading rather than inventing wording', () => {
    assert.equal(defaultNoteFor('other', 'Late fees', null), 'Late fees')
  })

  it('classifies the enrolment column as enrollment', () => {
    const enrolment = planFor().installments.find(
      (installment) => installment.legacyColumnName === 'Enroll. Fee',
    )
    assert.equal(enrolment?.installmentType, 'enrollment')
    assert.equal(enrolment?.defaultNote, 'Enrolment fee')
  })
})

describe('an ordinal roster creates no normalized installments', () => {
  const sheet = sheetFromRows([
    ['ELCE 25 & 26'],
    [],
    [
      'Sr. No. ',
      'Student ID ',
      'First Name ',
      'Total fees',
      'Enrollment fees',
      '1st Installment',
      '2nd Installment',
      'Late fees',
      'Total Paid',
      'Balance',
    ],
    [1, 121001, 'Asha', 3000, 500, 1000, BLANK, 50, 1550, BLANK],
  ])

  function elceTable() {
    const blocks = findBlocks(sheet, rangeOf(sheet))
    return buildSourceTable('ELCE 25 & 26', sheet, blocks[0], 'cohort_roster')
  }

  it('has no explicitly detected schedule section', () => {
    assert.equal(elceTable().hasInstallmentSection, false)
  })

  it('creates no installments from columns merely named "Installment"', () => {
    // These columns sit inside the range this sheet's Total Paid sums, which is
    // the same evidence that marks the PSW ACTUAL section as money received. A
    // column called "Installment" is not a schedule; a schedule section is.
    const { installments } = planInstallments(HASH, elceTable(), () => 'record:4')

    assert.equal(installments.length, 0)
  })

  it('creates none from the enrolment or late-fee columns either', () => {
    const { columns } = scheduleColumns(elceTable())
    assert.deepEqual(columns, [])
  })

  it('records why each monetary column was excluded', () => {
    const { excluded } = scheduleColumns(elceTable())
    const headers = excluded.map((entry) => entry.header)

    for (const heading of ['Enrollment fees', '1st Installment', '2nd Installment', 'Late fees']) {
      assert.equal(headers.includes(heading), true, heading)
    }
    assert.match(
      excluded.map((entry) => entry.reason).join(' '),
      /no explicitly detected INSTALLMENT FEE STRUCTURE section/,
    )
  })

  it('keeps those monetary values in the finance record instead', () => {
    const table = elceTable()
    const records = planBatchFinanceRecords(HASH, table, 'ECEA', 'batch', (row) =>
      row.studentNumber === null ? null : `student:${row.studentNumber}`,
    )
    const cells = records.records[0].legacyRawJson.cells as Record<string, { header: string }>

    // E is Enrollment fees, F the 1st Installment, H the Late fees.
    assert.equal(cells.E.header, 'Enrollment fees')
    assert.equal(cells.F.header, '1st Installment')
    assert.equal(cells.H.header, 'Late fees')
  })

  it('creates no payment from them either', () => {
    // Tracker Master remains the sole transaction source.
    const table = elceTable()
    const records = planBatchFinanceRecords(HASH, table, 'ECEA', 'batch', (row) =>
      row.studentNumber === null ? null : `student:${row.studentNumber}`,
    )

    for (const record of records.records) {
      assert.equal(Object.keys(record).includes('amount'), false)
      assert.equal(Object.keys(record).includes('source'), false)
    }
  })
})

describe('installments hang off a finance record', () => {
  it('creates none for a row that produced no record', () => {
    const { installments } = planFor()
    assert.equal(
      installments.some((installment) => installment.legacySourceRow === 5),
      false,
    )
  })

  it('preserves the source column heading and value text', () => {
    const may = planFor().installments.find(
      (installment) => installment.legacyColumnName === 'May' && installment.legacySourceRow === 3,
    )

    assert.equal(may?.legacyColumnName, 'May')
    assert.equal(may?.legacyValueText, '1000')
    assert.equal(may?.section, 'INSTALLMENT FEE STRUCTURE')
  })
})
