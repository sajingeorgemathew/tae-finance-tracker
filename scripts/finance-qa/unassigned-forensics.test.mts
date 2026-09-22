import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import {
  assessBatchEvidence,
  assessIdentity,
  batchMatchesMonthText,
  bucketPaymentCounts,
  classifyOrigin,
  conservePayments,
  nameFold,
  reconcileRouting,
  stageLosses,
  type PlannedRow,
} from './unassigned-forensics.mts'

/**
 * FINANCE-RECONCILE-04A — the grading rules of the unassigned audit.
 *
 * Fixtures are shaped like the hosted import: one unassigned record per
 * student per program, several Tracker Master rows behind one record, and
 * the single amount-less row that became an import exception instead of a
 * payment. Nothing here touches a database.
 */

describe('conservePayments', () => {
  it('splits every payment between batch and unassigned records and proves the sum', () => {
    const result = conservePayments({
      records: [
        { id: 'r-batch', batch_id: 'b1' },
        { id: 'r-unassigned', batch_id: null },
      ],
      payments: [
        { id: 'p1', student_finance_record_id: 'r-batch' },
        { id: 'p2', student_finance_record_id: 'r-batch' },
        { id: 'p3', student_finance_record_id: 'r-unassigned' },
      ],
    })
    assert.deepEqual(result, { total: 3, assigned: 2, unassigned: 1, orphaned: 0, conserved: true })
  })

  it('counts a payment whose record is missing as orphaned rather than losing it', () => {
    const result = conservePayments({
      records: [{ id: 'r', batch_id: null }],
      payments: [{ id: 'p', student_finance_record_id: 'gone' }],
    })
    assert.equal(result.orphaned, 1)
    assert.equal(result.conserved, true)
  })
})

describe('bucketPaymentCounts', () => {
  it('buckets 0, 1 and 2+', () => {
    assert.deepEqual(bucketPaymentCounts([0, 1, 1, 2, 7]), { zero: 1, one: 2, twoPlus: 2 })
  })
})

describe('reconcileRouting', () => {
  const rows: PlannedRow[] = [
    { sourceRow: 2, routing: 'unique_batch', plansPayment: true, unresolved: null, financeRecordId: 'batch-rec' },
    { sourceRow: 3, routing: 'ambiguous_batch', plansPayment: true, unresolved: null, financeRecordId: 'u1' },
    { sourceRow: 4, routing: 'ambiguous_batch', plansPayment: true, unresolved: null, financeRecordId: 'u1' },
    { sourceRow: 5, routing: 'batch_not_found', plansPayment: true, unresolved: null, financeRecordId: 'u2' },
    { sourceRow: 6, routing: 'missing_student_id', plansPayment: false, unresolved: 'missing_amount', financeRecordId: 'u3' },
    { sourceRow: 7, routing: 'missing_student_id', plansPayment: true, unresolved: null, financeRecordId: 'u4' },
  ]

  it('explains why transaction rows outnumber finance records', () => {
    const result = reconcileRouting(rows, new Set(['u1', 'u2', 'u3', 'u4']))
    assert.deepEqual(result.rowsByRouting, { unique_batch: 1, ambiguous_batch: 2, batch_not_found: 1, missing_student_id: 2 })
    assert.deepEqual(result.unassignedRowsByRouting, { ambiguous_batch: 2, batch_not_found: 1, missing_student_id: 2 })
    assert.deepEqual(result.unassignedRecordsByRouting, { ambiguous_batch: 1, batch_not_found: 1, missing_student_id: 2 })
    assert.equal(result.unassignedRows, 5)
    assert.equal(result.unassignedRecords, 4)
    assert.equal(result.unassignedRowsThatBecamePayments, 4)
    assert.equal(result.unassignedRowsPreservedAsExceptions, 1)
    assert.equal(result.recordsAggregatingSeveralRows, 1)
    assert.equal(result.recordsWithMixedRouting, 0)
    assert.match(result.explanation, /5 Tracker Master rows/)
    assert.match(result.explanation, /resolve to 4 records/)
    assert.match(result.explanation, /1 was preserved as an import exception/)
  })

  it('notices a record whose rows disagree on routing', () => {
    const mixed: PlannedRow[] = [
      { sourceRow: 1, routing: 'ambiguous_batch', plansPayment: true, unresolved: null, financeRecordId: 'u' },
      { sourceRow: 2, routing: 'batch_not_found', plansPayment: true, unresolved: null, financeRecordId: 'u' },
    ]
    const result = reconcileRouting(mixed, new Set(['u']))
    assert.equal(result.recordsWithMixedRouting, 1)
    assert.deepEqual(result.unassignedRecordsByRouting, { 'ambiguous_batch+batch_not_found': 1 })
  })
})

describe('classifyOrigin', () => {
  const base = {
    studentNumber: '125001',
    unassignedReason: 'batch_not_found',
    paymentCount: 2,
    plannedRows: 2,
    plannedPaymentRows: 2,
    plannedExceptionRows: 0,
    hasBatchSnapshot: false,
    hasFee: true,
    hasPaid: false,
    hasBalance: false,
    paymentCountDisagreesWithPlan: false,
    reasonDisagreesWithPlan: false,
    uiLoss: false,
    hasAnyIdentity: true,
  }

  it('is A for a numbered student with transactions and an unresolved batch', () => {
    assert.deepEqual(classifyOrigin(base).categories, ['A'])
  })

  it('is A and C for a number-less student with a payment', () => {
    assert.deepEqual(classifyOrigin({ ...base, studentNumber: null, unassignedReason: 'missing_student_id' }).categories, ['A', 'C'])
  })

  it('is C, G and D for the amount-less exception row with no figures at all', () => {
    const origin = classifyOrigin({
      ...base,
      studentNumber: null,
      unassignedReason: 'missing_student_id',
      paymentCount: 0,
      plannedRows: 1,
      plannedPaymentRows: 0,
      plannedExceptionRows: 1,
      hasFee: false,
    })
    assert.deepEqual(origin.categories, ['C', 'G', 'D'])
    assert.match(origin.explanation, /import exception/)
    assert.match(origin.explanation, /no payment and no fee/)
  })

  it('keeps G without D when the exception row still states a fee', () => {
    const origin = classifyOrigin({ ...base, paymentCount: 0, plannedRows: 1, plannedPaymentRows: 0, plannedExceptionRows: 1 })
    assert.deepEqual(origin.categories, ['G'])
  })

  it('is E when the hosted rows and the plan disagree, or when nothing explains the record', () => {
    assert.ok(classifyOrigin({ ...base, paymentCountDisagreesWithPlan: true }).categories.includes('E'))
    assert.ok(classifyOrigin({ ...base, reasonDisagreesWithPlan: true }).categories.includes('E'))
    assert.deepEqual(classifyOrigin({ ...base, paymentCount: 0, plannedRows: 0, plannedPaymentRows: 0, hasFee: false }).categories, ['D', 'E'])
  })

  it('is F when payments exist and a UI stage drops them', () => {
    assert.deepEqual(classifyOrigin({ ...base, uiLoss: true }).categories, ['A', 'F'])
  })

  it('adds E for a record whose source row names nobody at all', () => {
    const origin = classifyOrigin({
      ...base,
      studentNumber: null,
      unassignedReason: 'missing_student_id',
      paymentCount: 0,
      plannedRows: 1,
      plannedPaymentRows: 0,
      plannedExceptionRows: 1,
      hasFee: false,
      hasAnyIdentity: false,
    })
    assert.deepEqual(origin.categories, ['C', 'G', 'D', 'E'])
    assert.match(origin.explanation, /represents no identifiable person/)
  })
})

describe('batchMatchesMonthText', () => {
  it('matches a dated batch on month and two-digit year', () => {
    assert.equal(batchMatchesMonthText({ name: '18th August 2025 - Morning', start_date: '2025-08-18' }, 'Aug-25'), true)
    assert.equal(batchMatchesMonthText({ name: '18th August 2025 - Morning', start_date: '2025-08-18' }, 'Aug-26'), false)
    assert.equal(batchMatchesMonthText({ name: '18th August 2025 - Morning', start_date: '2025-08-18' }, 'Sep-25'), false)
  })

  it('matches an undated batch on the month and year its workbook sheet states', () => {
    assert.equal(batchMatchesMonthText({ name: 'December - Evening', start_date: null, legacy_sheet_name: 'Dec 2025' }, 'Dec-25'), true)
    assert.equal(batchMatchesMonthText({ name: 'December - Evening', start_date: null, legacy_sheet_name: 'Dec 2025' }, 'Dec-26'), false)
    assert.equal(batchMatchesMonthText({ name: 'December 2025 - Morning', start_date: null, legacy_sheet_name: 'Dec 2025' }, 'Dec-25'), true)
    assert.equal(batchMatchesMonthText({ name: 'January 026 - Evening', start_date: null, legacy_sheet_name: 'Jan 2026' }, 'Jan-26'), true)
    assert.equal(batchMatchesMonthText({ name: 'March 26 - Morning', start_date: null, legacy_sheet_name: 'March 26' }, 'Mar-26'), true)
    assert.equal(batchMatchesMonthText({ name: 'March 26 - Morning', start_date: null, legacy_sheet_name: 'March 26' }, 'May-26'), false)
  })

  it('falls back to the batch name only when no sheet name exists, and then cannot check the year', () => {
    assert.equal(batchMatchesMonthText({ name: 'December - Evening', start_date: null }, 'Dec-25'), true)
    assert.equal(batchMatchesMonthText({ name: 'December - Evening', start_date: null }, 'Dec-26'), true)
    assert.equal(batchMatchesMonthText({ name: 'December 2025 - Morning', start_date: null }, 'Dec-26'), false)
  })

  it('refuses text that is not a month and year', () => {
    assert.equal(batchMatchesMonthText({ name: 'December - Evening', start_date: null }, '2025-12-01'), false)
    assert.equal(batchMatchesMonthText({ name: 'December - Evening', start_date: null }, ''), false)
  })
})

describe('assessBatchEvidence', () => {
  const morning = { id: 'b-am', name: '18th August 2025 - Morning', start_date: '2025-08-18' }
  const evening = { id: 'b-pm', name: '18 August 2025 - Evening', start_date: '2025-08-18' }
  const april = { id: 'b-apr', name: '27th April 2026 - Morning', start_date: '2026-04-27' }
  const programBatches = [morning, evening, april]

  it('grades a student listed in two batch tables as human-assignable with strong candidates', () => {
    const result = assessBatchEvidence({
      studentNumber: '125001',
      appearances: [
        { batch: evening, sheetName: '18th August 2025', tableKey: 'title@22', sourceRow: 30 },
        { batch: april, sheetName: '27 April 26', tableKey: 'title@3', sourceRow: 9 },
      ],
      trackerHints: [{ text: 'Aug-25', iso: '2025-08-01' }],
      programBatches,
    })
    assert.equal(result.assessment, 'human_assignable')
    assert.equal(result.listedTwiceInOneTable, false)
    assert.deepEqual(
      result.candidates.map((candidate) => [candidate.batchName, candidate.strength]),
      [
        ['18 August 2025 - Evening', 'strong'],
        ['27th April 2026 - Morning', 'strong'],
        ['18th August 2025 - Morning', 'month'],
        ['18 August 2025 - Evening', 'month'],
      ],
    )
  })

  it('keeps both rows when one table lists the number twice, and says the batch is clear but the record is not', () => {
    const result = assessBatchEvidence({
      studentNumber: '125005',
      appearances: [
        { batch: morning, sheetName: '18th August 2025', tableKey: 'title@1', sourceRow: 8 },
        { batch: morning, sheetName: '18th August 2025', tableKey: 'title@1', sourceRow: 19 },
      ],
      trackerHints: [],
      programBatches,
    })
    assert.equal(result.assessment, 'human_assignable')
    assert.equal(result.listedTwiceInOneTable, true)
    assert.equal(result.candidates.length, 1)
    assert.deepEqual(result.candidates[0].sourceRows, [8, 19])
    assert.match(result.candidates[0].evidence, /row 8, row 19/)
    assert.match(result.note, /target record is not/)
  })

  it('grades a month that names a Morning/Evening pair as a hint only', () => {
    const result = assessBatchEvidence({
      studentNumber: '125002',
      appearances: [],
      trackerHints: [{ text: 'Aug-25', iso: '2025-08-01' }],
      programBatches,
    })
    assert.equal(result.assessment, 'month_hint_only')
    assert.equal(result.candidates.length, 2)
    assert.ok(result.candidates.every((candidate) => candidate.strength === 'month'))
    assert.match(result.note, /cannot tell Morning from Evening/)
  })

  it('ranks an exact start-date match above a month match, and still not as strong', () => {
    const result = assessBatchEvidence({
      studentNumber: '125003',
      appearances: [],
      trackerHints: [{ text: 'Aug-25', iso: '2025-08-18' }],
      programBatches,
    })
    assert.equal(result.assessment, 'month_hint_only')
    assert.deepEqual(result.candidates.map((candidate) => candidate.strength), ['day', 'day'])
  })

  it('is genuinely unresolved when the month matches no batch', () => {
    const result = assessBatchEvidence({
      studentNumber: '125004',
      appearances: [],
      trackerHints: [{ text: 'Feb-24', iso: '2024-02-01' }],
      programBatches,
    })
    assert.equal(result.assessment, 'genuinely_unresolved')
    assert.equal(result.candidates.length, 0)
  })

  it('is missing identity for a number-less student even when a month matches', () => {
    const result = assessBatchEvidence({
      studentNumber: null,
      appearances: [],
      trackerHints: [{ text: 'Aug-25', iso: null }],
      programBatches,
    })
    assert.equal(result.assessment, 'missing_identity')
    assert.equal(result.candidates.length, 2)
  })
})

describe('assessIdentity', () => {
  const numbered = [
    { studentId: 's1', studentNumber: '125001', names: ['Ada Lovelace', 'Lovelace Ada'] },
    { studentId: 's2', studentNumber: '125002', names: ['Grace Hopper'] },
    { studentId: 's3', studentNumber: '125003', names: ['Grace  Hopper'] },
  ]

  it('is numbered when a student number exists', () => {
    assert.equal(assessIdentity({ studentNumber: '125001', sourceName: 'x', email: null, phone: null, numberedStudents: numbered }).status, 'numbered')
  })

  it('reports one exact spelling match, folded for case and whitespace, without merging', () => {
    const result = assessIdentity({ studentNumber: null, sourceName: '  ada   LOVELACE ', email: null, phone: null, numberedStudents: numbered })
    assert.equal(result.status, 'exact_name_match')
    assert.deepEqual(result.exactMatches, [{ studentId: 's1', studentNumber: '125001', name: 'Ada Lovelace' }])
    assert.match(result.note, /not a merge/)
  })

  it('reports several exact matches as still unresolved', () => {
    const result = assessIdentity({ studentNumber: null, sourceName: 'Grace Hopper', email: null, phone: null, numberedStudents: numbered })
    assert.equal(result.status, 'several_exact_name_matches')
    assert.equal(result.exactMatches.length, 2)
  })

  it('never matches on a partial or reordered name', () => {
    const result = assessIdentity({ studentNumber: null, sourceName: 'Ada', email: null, phone: null, numberedStudents: numbered })
    assert.equal(result.status, 'unresolved')
    assert.equal(result.exactMatches.length, 0)
    assert.match(result.note, /no email or phone was imported/)
  })

  it('lists another number-less record spelling the same name as a peer, without joining them', () => {
    const result = assessIdentity({
      studentNumber: null,
      sourceName: 'Pat Q',
      email: null,
      phone: null,
      numberedStudents: numbered,
      unresolvedPeers: [
        { financeRecordId: 'self', sourceName: 'Other Person' },
        { financeRecordId: 'peer', sourceName: 'pat  q' },
        { financeRecordId: 'nameless', sourceName: null },
      ],
    })
    assert.equal(result.status, 'unresolved')
    assert.deepEqual(result.exactUnresolvedPeers, ['peer'])
    assert.match(result.note, /1 other number-less record spells the same name/)
    assert.match(result.note, /cannot resolve into one person or two/)
  })

  it('notes a contact identifier when one was imported', () => {
    const result = assessIdentity({ studentNumber: null, sourceName: 'Nobody', email: 'x@example.test', phone: null, numberedStudents: numbered })
    assert.equal(result.hasContactIdentifier, true)
  })

  it('folds names for comparison only', () => {
    assert.equal(nameFold('  Ada   Lovelace '), 'ada lovelace')
    assert.equal(nameFold('   '), null)
    assert.equal(nameFold(null), null)
  })
})

describe('stageLosses', () => {
  it('reports zero loss when every stage carries every payment', () => {
    const result = stageLosses({ database: ['p1', 'p2'], loader: ['p1', 'p2'], viewModel: ['p2', 'p1'], browserRows: 2 })
    assert.equal(result.unexplainedLoss, 0)
    assert.deepEqual(result.lostAtLoader, [])
    assert.deepEqual(result.lostAtViewModel, [])
    assert.equal(result.lostAtBrowser, 0)
  })

  it('names the payment lost at each stage', () => {
    const result = stageLosses({ database: ['p1', 'p2', 'p3'], loader: ['p1', 'p2'], viewModel: ['p1'], browserRows: 0 })
    assert.deepEqual(result.lostAtLoader, ['p3'])
    assert.deepEqual(result.lostAtViewModel, ['p2'])
    assert.equal(result.lostAtBrowser, 1)
    assert.equal(result.unexplainedLoss, 3)
  })

  it('treats a stage that did not run as unmeasured, not as a loss', () => {
    const result = stageLosses({ database: ['p1'], loader: null, viewModel: null, browserRows: null })
    assert.equal(result.loader, null)
    assert.equal(result.browser, null)
    assert.equal(result.unexplainedLoss, 0)
  })
})
