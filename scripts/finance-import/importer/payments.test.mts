import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { planPayments, resolveTrackerColumns } from './payments.mts'
import { buildSourceTable } from './source-tables.mts'
import { findBlocks } from '../lib/blocks.mts'
import { resolveProgramLabel } from './programs.mts'
import { BLANK, rangeOf, trackerMasterSheet, trackerRow } from './fixtures.mts'

import type { CellInput } from './fixtures.mts'
import type { PaymentPlanInput, RoutingCandidate } from './payments.mts'

const HASH = '62d53173ebc357428351b4429b55779ca5acf0896840f3faab8d0b20af0894b2'

/** Excel serial for 2025-05-12 in the 1900 system. */
const MAY_12_2025 = 45789

function candidate(
  studentNumber: string,
  sheetName: string,
  programShortCode = 'PSW',
): RoutingCandidate {
  return {
    financeRecordSourceKey: `record:${studentNumber}:${sheetName}`,
    batchSourceKey: `batch:${sheetName}`,
    programShortCode,
    sheetName,
    tableKey: 'title@1',
  }
}

function run(
  rows: readonly CellInput[][],
  candidates: Record<string, RoutingCandidate[]> = {},
) {
  const sheet = trackerMasterSheet(rows)
  const blocks = findBlocks(sheet, rangeOf(sheet))
  const table = buildSourceTable('Tracker Master', sheet, blocks[0], 'transaction_master')

  const unassigned = new Map<string, string>()

  const input: PaymentPlanInput = {
    workbookHash: HASH,
    table,
    columns: resolveTrackerColumns(table),
    date1904: false,
    candidatesFor: (studentNumber) => candidates[studentNumber] ?? [],
    resolveProgram: (label) => {
      const resolved = resolveProgramLabel(label)
      return {
        shortCode: resolved.status === 'mapped' ? resolved.shortCode : null,
        sourceLabel:
          resolved.status === 'blank' ? null : (resolved as { sourceLabel: string }).sourceLabel,
        deferred: resolved.status === 'deferred',
      }
    },
    studentKeyFor: (studentNumber) => `student:${studentNumber}`,
    unresolvedStudentKeyFor: (row) => `unresolved-student:${row}`,
    unassignedRecordFor: (studentSourceKey, _number, program) => {
      const key = `unassigned:${studentSourceKey}:${program}`
      unassigned.set(key, key)
      return key
    },
  }

  return { ...planPayments(input), unassignedKeys: [...unassigned.keys()] }
}

describe('routing a payment to a batch', () => {
  it('routes to the batch record when the student is in exactly one table', () => {
    const result = run(
      [trackerRow({ studentId: 125001, amount: 500, program: 'PSW' })],
      { '125001': [candidate('125001', 'Dec 2025')] },
    )

    assert.equal(result.counts.uniqueBatch, 1)
    assert.equal(result.payments[0].routing, 'unique_batch')
    assert.equal(result.payments[0].financeRecordSourceKey, 'record:125001:Dec 2025')
  })

  it('refuses to guess when the student is in more than one table', () => {
    const result = run(
      [trackerRow({ studentId: 125001, amount: 500, program: 'PSW' })],
      { '125001': [candidate('125001', 'Dec 2025'), candidate('125001', 'Jan 2026')] },
    )

    assert.equal(result.counts.ambiguousBatch, 1)
    assert.equal(result.payments[0].routing, 'ambiguous_batch')
    // It still lands somewhere: an unassigned record with batch_id null.
    assert.match(result.payments[0].financeRecordSourceKey ?? '', /^unassigned:/)
    assert.match(result.payments[0].routingNote, /not guessed/)
  })

  it('routes to an unassigned record when no table holds the student', () => {
    const result = run([trackerRow({ studentId: 125001, amount: 500, program: 'PSW' })])

    assert.equal(result.counts.batchNotFound, 1)
    assert.equal(result.payments[0].routing, 'batch_not_found')
    assert.match(result.payments[0].financeRecordSourceKey ?? '', /^unassigned:/)
  })

  it('does not route across programs', () => {
    // The student's only batch table is ECEA; the payment says PSW.
    const result = run(
      [trackerRow({ studentId: 121001, amount: 500, program: 'PSW' })],
      { '121001': [candidate('121001', 'ELCE 25 & 26', 'ECEA')] },
    )

    assert.equal(result.payments[0].routing, 'batch_not_found')
  })

  it('never uses the Batch date serial to choose a table', () => {
    const withBatch = run(
      [trackerRow({ studentId: 125001, amount: 500, program: 'PSW', batch: MAY_12_2025 })],
      { '125001': [candidate('125001', 'Dec 2025'), candidate('125001', 'Jan 2026')] },
    )

    // A Batch value that happens to match a table's date changes nothing: it is
    // still ambiguous, because a date cannot tell Morning from Evening.
    assert.equal(withBatch.payments[0].routing, 'ambiguous_batch')
    const raw = withBatch.payments[0].legacyRawJson.batch as { raw_value: unknown }
    assert.equal(raw.raw_value, MAY_12_2025)
  })

  it('shares one unassigned record between a student’s unroutable payments', () => {
    const result = run([
      trackerRow({ studentId: 125001, amount: 500, program: 'PSW' }),
      trackerRow({ studentId: 125001, amount: 300, program: 'PSW' }),
    ])

    assert.equal(result.unassignedKeys.length, 1)
    assert.equal(
      result.payments[0].financeRecordSourceKey,
      result.payments[1].financeRecordSourceKey,
    )
  })
})

describe('rows with no student number', () => {
  it('routes each to its own unresolved student without name matching', () => {
    const result = run([
      trackerRow({ studentId: BLANK, studentName: 'Asha Rao', amount: 500, program: 'PSW' }),
      trackerRow({ studentId: BLANK, studentName: 'Asha Rao', amount: 300, program: 'PSW' }),
    ])

    assert.equal(result.counts.missingStudentId, 2)
    // Identical names, two separate students. Never merged.
    assert.notEqual(result.payments[0].studentSourceKey, result.payments[1].studentSourceKey)
    assert.notEqual(
      result.payments[0].financeRecordSourceKey,
      result.payments[1].financeRecordSourceKey,
    )
  })

  it('still preserves the payment', () => {
    const result = run([
      trackerRow({ studentId: BLANK, studentName: 'Asha Rao', amount: 500, program: 'PSW' }),
    ])

    assert.equal(result.payments[0].unresolved, null)
    assert.equal(result.payments[0].amount, 500)
    assert.equal(result.payments[0].studentNumber, null)
  })
})

describe('program resolution', () => {
  it('maps ELCE to ECEA while preserving the source label', () => {
    const result = run([trackerRow({ studentId: 121001, amount: 500, program: 'ELCE' })])

    assert.equal(result.payments[0].programShortCode, 'ECEA')
    assert.equal(result.payments[0].sourceProgramLabel, 'ELCE')
    assert.equal(result.payments[0].legacyRawJson.program, 'ELCE')
  })

  it('infers a blank program from the student’s only batch program, and records it', () => {
    const result = run(
      [trackerRow({ studentId: 125001, amount: 500, program: BLANK })],
      { '125001': [candidate('125001', 'Dec 2025')] },
    )

    assert.equal(result.payments[0].programShortCode, 'PSW')
    assert.equal(result.payments[0].programInferred, true)
    assert.match(String(result.payments[0].legacyRawJson.program_resolution), /inferred/)
  })

  it('leaves a blank program unresolved when the batches disagree', () => {
    const result = run(
      [trackerRow({ studentId: 125001, amount: 500, program: BLANK })],
      {
        '125001': [
          candidate('125001', 'Dec 2025', 'PSW'),
          candidate('125001', 'ELCE 25 & 26', 'ECEA'),
        ],
      },
    )

    assert.equal(result.payments[0].unresolved, 'unresolved_program')
    assert.equal(result.payments[0].financeRecordSourceKey, null)
  })

  it('never infers a program from the student name', () => {
    const result = run([
      trackerRow({ studentId: 125001, studentName: 'PSW Student', amount: 500, program: BLANK }),
    ])

    assert.equal(result.payments[0].unresolved, 'unresolved_program')
  })
})

describe('Balance Fees is preserved, never mapped to a finance-record balance', () => {
  it('keeps the raw value, the formula and a note in legacy_raw_json', () => {
    const result = run([
      trackerRow({
        studentId: 125001,
        amount: 500,
        program: 'PSW',
        balance: { f: 'I2-E2', v: -500 },
      }),
    ])

    const balance = result.payments[0].legacyRawJson.balance_fees as Record<string, unknown>
    assert.equal(balance.raw_value, -500)
    assert.equal(balance.formula, 'I2-E2')
    assert.match(String(balance.note), /never mapped to legacy_balance/)
  })

  it('puts no balance anywhere on the payment itself', () => {
    const result = run([
      trackerRow({ studentId: 125001, amount: 500, program: 'PSW', balance: { f: 'I2-E2', v: -500 } }),
    ])

    assert.equal('balance' in result.payments[0], false)
    assert.equal('legacyBalance' in result.payments[0], false)
  })
})

describe('historical values are preserved exactly', () => {
  it('does not normalise payment method spellings', () => {
    const result = run([
      trackerRow({ studentId: 125001, amount: 500, program: 'PSW', method: 'Etransfer' }),
      trackerRow({ studentId: 125002, amount: 500, program: 'PSW', method: 'E-Transfer' }),
      trackerRow({ studentId: 125003, amount: 500, program: 'PSW', method: 'ETRANSFER' }),
      trackerRow({ studentId: 125004, amount: 500, program: 'PSW', method: 'MASTER CARD' }),
    ])

    assert.deepEqual(
      result.payments.map((payment) => payment.paymentMethod),
      ['Etransfer', 'E-Transfer', 'ETRANSFER', 'MASTER CARD'],
    )
  })

  it('preserves Receipt Sent without creating a receipt', () => {
    const result = run([
      trackerRow({ studentId: 125001, amount: 500, program: 'PSW', receiptSent: 'YES' }),
      trackerRow({ studentId: 125002, amount: 500, program: 'PSW', receiptSent: 'NO' }),
      trackerRow({ studentId: 125003, amount: 500, program: 'PSW', receiptSent: BLANK }),
    ])

    assert.deepEqual(
      result.payments.map(
        (payment) => (payment.legacyRawJson.receipt_sent as string | null),
      ),
      ['YES', 'NO', null],
    )

    for (const payment of result.payments) {
      // Nothing on a payment references a receipt, a receipt number or a PDF.
      const keys = Object.keys(payment)
      assert.equal(keys.some((key) => /receipt/i.test(key)), false)
      const status = payment.legacyRawJson.legacy_receipt_status as Record<string, unknown>
      assert.match(String(status.note), /historical metadata only/)
    }
  })

  it('keeps remarks labelled by the column they came from', () => {
    const result = run([
      trackerRow({
        studentId: 125001,
        amount: 500,
        program: 'PSW',
        remarks: 'partial',
        vikasRemarks: 'checked',
      }),
    ])

    assert.equal(result.payments[0].note, 'REMARKS: partial\nVIKAS REMARKS: checked')
    assert.equal(result.payments[0].legacyRawJson.remarks, 'partial')
    assert.equal(result.payments[0].legacyRawJson.vikas_remarks, 'checked')
  })

  it('imports a negative amount as stated', () => {
    const result = run([trackerRow({ studentId: 125001, amount: -250, program: 'PSW' })])
    assert.equal(result.payments[0].amount, -250)
    assert.equal(result.payments[0].unresolved, null)
  })

  it('parses a paid date but keeps the serial', () => {
    const result = run([
      trackerRow({ studentId: 125001, amount: 500, program: 'PSW', paidDate: MAY_12_2025 }),
    ])

    assert.equal(result.payments[0].paymentDate, '2025-05-12')
    const paid = result.payments[0].legacyRawJson.paid_date as Record<string, unknown>
    assert.equal(paid.raw_serial, MAY_12_2025)
  })

  it('leaves a missing paid date null rather than inventing one', () => {
    const result = run([
      trackerRow({ studentId: 125001, amount: 500, program: 'PSW', paidDate: BLANK }),
    ])
    assert.equal(result.payments[0].paymentDate, null)
  })

  it('plans no payment for a row with no amount, rather than importing a zero', () => {
    const result = run([trackerRow({ studentId: 125001, amount: BLANK, program: 'PSW' })])

    assert.equal(result.payments[0].amount, null)
    assert.equal(result.payments[0].plansPayment, false)
    assert.equal(result.payments[0].unresolved, 'missing_amount')
  })

  it('still resolves the student and finance record for that row', () => {
    // The row establishes that the student exists and which program they are
    // in, even though it states no money. Only the payment is withheld.
    const result = run([trackerRow({ studentId: 125001, amount: BLANK, program: 'PSW' })])

    assert.equal(result.payments[0].studentSourceKey, 'student:125001')
    assert.equal(result.payments[0].programShortCode, 'PSW')
    assert.notEqual(result.payments[0].financeRecordSourceKey, null)
  })

  it('plans no record when the program cannot be resolved either', () => {
    // student_finance_records.program_id is NOT NULL and no program is guessed.
    const result = run([trackerRow({ studentId: 125001, amount: 500, program: 'NOPE' })])

    assert.equal(result.payments[0].unresolved, 'unresolved_program')
    assert.equal(result.payments[0].financeRecordSourceKey, null)
  })
})

describe('duplicate candidates are preserved, not removed', () => {
  it('keeps every row and reports the group', () => {
    const result = run([
      trackerRow({ studentId: 125001, amount: 500, paidDate: MAY_12_2025, program: 'PSW' }),
      trackerRow({ studentId: 125001, amount: 500, paidDate: MAY_12_2025, program: 'PSW' }),
    ])

    assert.equal(result.payments.length, 2)
    assert.equal(result.preservedDuplicateCandidates.length, 1)
    assert.deepEqual(result.preservedDuplicateCandidates[0].rows, [2, 3])
    // Two rows, two distinct payments: nothing was collapsed.
    assert.notEqual(result.payments[0].sourceKey, result.payments[1].sourceKey)
  })

  it('does not group rows that differ on the date', () => {
    const result = run([
      trackerRow({ studentId: 125001, amount: 500, paidDate: MAY_12_2025, program: 'PSW' }),
      trackerRow({ studentId: 125001, amount: 500, paidDate: MAY_12_2025 + 1, program: 'PSW' }),
    ])

    assert.equal(result.preservedDuplicateCandidates.length, 0)
  })
})

describe('every transaction row is accounted for', () => {
  it('produces one planned payment per source row', () => {
    const result = run([
      trackerRow({ studentId: 125001, amount: 500, program: 'PSW' }),
      trackerRow({ studentId: BLANK, studentName: 'No Number', amount: 300, program: 'PSW' }),
      trackerRow({ studentId: 125002, amount: BLANK, program: 'PSW' }),
    ])

    assert.equal(result.payments.length, 3)
    assert.equal(result.counts.total, 3)
    // Routing outcomes partition the rows exactly.
    const { uniqueBatch, ambiguousBatch, batchNotFound, missingStudentId } = result.counts
    assert.equal(uniqueBatch + ambiguousBatch + batchNotFound + missingStudentId, 3)
  })

  it('marks which rows will actually be inserted', () => {
    const result = run([
      trackerRow({ studentId: 125001, amount: 500, program: 'PSW' }),
      trackerRow({ studentId: 125002, amount: BLANK, program: 'PSW' }),
    ])

    assert.deepEqual(
      result.payments.map((payment) => payment.plansPayment),
      [true, false],
    )
  })

  it('records the source sheet and row on every payment', () => {
    const result = run([trackerRow({ studentId: 125001, amount: 500, program: 'PSW' })])

    assert.equal(result.payments[0].legacySourceSheet, 'Tracker Master')
    assert.equal(result.payments[0].legacySourceRow, 2)
    assert.equal(result.payments[0].source, 'legacy_import')
  })
})
