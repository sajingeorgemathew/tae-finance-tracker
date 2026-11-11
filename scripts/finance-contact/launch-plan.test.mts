import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { CollectionAssessment } from '../finance-cutover/readiness.mts'

import type { ContactImportRow } from './canonical.mts'
import {
  buildLaunchContactPlan,
  holdForIdentity,
  identityConflict,
  launchPlanHash,
  launchStatusOf,
  owingSummary,
  resolveLaunchScope,
  type LaunchScope,
} from './launch-plan.mts'
import { classifyRows, findDuplicateSourceNumbers, findSharedContacts, type HostedSnapshot, type HostedStudentLike } from './reconcile.mts'
import { parseTitleDate } from './adapters/title-date.mts'

/**
 * FINANCE-CONTACT-05B — the launch-cohort contact plan, on invented data only
 * (`example.test` addresses, 555 numbers, 9xxxxx student numbers, fixture UUIDs).
 */

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

function row(overrides: Partial<ContactImportRow>): ContactImportRow {
  const number = overrides.studentNumber === undefined ? '900001' : overrides.studentNumber
  const sourceRow = overrides.sourceRow ?? 1
  return {
    stagedRowId: `PSW:June 01:${sourceRow}`,
    sourceWorkbook: 'fixture-psw.xlsx',
    sourceSheet: 'June 01',
    sourceTable: 'PSW Morning Batch - June 1, 2026',
    sourceRow,
    programCode: 'PSW',
    studentNumber: number,
    studentNumberRaw: number,
    firstName: 'Fixture',
    middleName: null,
    lastName: 'Student',
    displayName: 'Fixture Student',
    emailRaw: 'fixture@example.test',
    emailNormalized: `s${number}@example.test`,
    emailStatus: 'valid',
    phoneRaw: '(416) 555-0100',
    phoneNormalized: `+141655${String(sourceRow).padStart(5, '0')}`,
    phoneStatus: 'valid_nanp',
    intakeLabel: 'June 1, 2026',
    intakeDate: '2026-06-01',
    session: 'Morning',
    sourceStartDate: null,
    sourceStatus: null,
    inOperationalScope: true,
    exclusionReason: null,
    ...overrides,
  }
}

function student(n: number, overrides: Partial<HostedStudentLike> = {}): HostedStudentLike {
  return {
    id: id(n),
    student_number: String(900000 + n),
    first_name: 'Fixture',
    middle_name: null,
    last_name: 'Student',
    display_name: null,
    legacy_name: null,
    email: null,
    phone: null,
    ...overrides,
  }
}

const programs = [{ id: 'p-psw', short_code: 'PSW' }]
const batches = [
  { id: 'b-jun-m', program_id: 'p-psw', name: '1st June, 2026 - Morning', legacy_sheet_name: '1st June 2026' },
  { id: 'b-aug-e', program_id: 'p-psw', name: '29th JULY 2026 - Evening', legacy_sheet_name: 'Aug 2026' },
  { id: 'b-sep-e', program_id: 'p-psw', name: '28th Sept, 2026 - Evening', legacy_sheet_name: '28 Sept 26' },
  { id: 'b-apr-e', program_id: 'p-psw', name: '27th April 2026 - Evening', legacy_sheet_name: '27 April 26' },
]
const cohortMonthOf = (text: string): string | null => parseTitleDate(text).yearMonth
const ONE_EACH = { 'PSW-2026-06': 1, 'PSW-2026-08': 1, 'PSW-2026-09': 1 }

describe('resolveLaunchScope', () => {
  const records = [
    { id: 'r1', student_id: id(1), batch_id: 'b-jun-m', collection_mode: 'installment' },
    { id: 'r2', student_id: id(2), batch_id: 'b-aug-e', collection_mode: 'installment' },
    { id: 'r3', student_id: id(3), batch_id: 'b-sep-e', collection_mode: 'installment' },
    { id: 'r4', student_id: id(4), batch_id: 'b-apr-e', collection_mode: null },
  ]

  it('uses the sheet month (Aug 2026 batches are named July) and falls back to the name for a two-digit-year sheet', () => {
    const scope = resolveLaunchScope({ programs, batches, records, cohortMonthOf, expected: ONE_EACH })
    assert.deepEqual(scope.problems, [])
    assert.deepEqual(scope.batchIdsByCohort, { 'PSW-2026-06': ['b-jun-m'], 'PSW-2026-08': ['b-aug-e'], 'PSW-2026-09': ['b-sep-e'] })
    assert.deepEqual(scope.members.map((m) => m.studentId), [id(1), id(2), id(3)])
  })

  it('stops on a count that differs from the applied cutover', () => {
    const scope = resolveLaunchScope({ programs, batches, records, cohortMonthOf, expected: { ...ONE_EACH, 'PSW-2026-09': 16 } })
    assert.ok(scope.problems.some((p) => p.includes('PSW September 2026: 1 students on hosted, expected 16')))
  })

  it('stops when an installment record sits outside the launch batches, or a launch record is not installment', () => {
    const bad = [...records.slice(0, 3).map((r, i) => (i === 0 ? { ...r, collection_mode: null } : r)), { ...records[3], collection_mode: 'installment' }]
    const scope = resolveLaunchScope({ programs, batches, records: bad, cohortMonthOf, expected: ONE_EACH })
    assert.ok(scope.problems.some((p) => p.includes('expected installment')))
    assert.ok(scope.problems.some((p) => p.includes('outside the launch batches')))
  })
})

describe('launchStatusOf', () => {
  const base = { hasStudentNumber: true, exactMasterRows: 1, hostedNumberHolders: 1, hostedEmailPresent: false, emailReason: 'SAFE_FILL', phoneReason: 'SAFE_FILL' }

  it('follows the precedence: number → duplicate → master → identity → already filled → email', () => {
    assert.equal(launchStatusOf({ ...base, hasStudentNumber: false }).status, 'MISSING_STUDENT_NUMBER')
    assert.equal(launchStatusOf({ ...base, hostedNumberHolders: 2 }).status, 'CONTACT_SHARED_REVIEW')
    assert.equal(launchStatusOf({ ...base, exactMasterRows: 0 }).status, 'CONTACT_MISSING')
    assert.equal(launchStatusOf({ ...base, emailReason: 'HELD_IDENTITY_CONFLICT' }).status, 'CONTACT_SHARED_REVIEW')
    assert.equal(launchStatusOf({ ...base, hostedEmailPresent: true, emailReason: 'ALREADY_MATCHES' }).status, 'ALREADY_FILLED')
    assert.equal(launchStatusOf({ ...base, hostedEmailPresent: true, emailReason: 'HELD_CONTACT_DIFFERENCE' }).status, 'ALREADY_FILLED')
    assert.equal(launchStatusOf(base).status, 'CONTACT_READY')
    assert.equal(launchStatusOf({ ...base, emailReason: 'HELD_SHARED_CONTACT' }).status, 'CONTACT_SHARED_REVIEW')
    assert.equal(launchStatusOf({ ...base, emailReason: 'HELD_INVALID_EMAIL' }).status, 'INVALID_CONTACT')
    assert.equal(launchStatusOf({ ...base, emailReason: 'HELD_SOURCE_CONFLICT' }).status, 'INVALID_CONTACT')
  })

  it('lets the phone decide only when the master has no email', () => {
    assert.equal(launchStatusOf({ ...base, emailReason: 'NO_SOURCE_VALUE', phoneReason: 'SAFE_FILL' }).status, 'CONTACT_MISSING')
    assert.equal(launchStatusOf({ ...base, emailReason: 'NO_SOURCE_VALUE', phoneReason: 'HELD_AMBIGUOUS_PHONE' }).status, 'INVALID_CONTACT')
    assert.equal(launchStatusOf({ ...base, emailReason: 'NO_SOURCE_VALUE', phoneReason: 'HELD_SHARED_CONTACT' }).status, 'CONTACT_SHARED_REVIEW')
    assert.equal(launchStatusOf({ ...base, phoneReason: 'HELD_AMBIGUOUS_PHONE' }).status, 'CONTACT_READY')
  })
})

describe('identityConflict', () => {
  const hosted = { first_name: 'Ada', middle_name: null, last_name: 'Fixture', display_name: null, legacy_name: 'ADA FIXTURE' }

  it('does not fire on a missing middle name or a typo that keeps one word', () => {
    assert.equal(identityConflict(hosted, [{ firstName: 'Ada', middleName: 'Byron', lastName: 'Fixture', displayName: 'ADA BYRON FIXTURE' }]), false)
    assert.equal(identityConflict(hosted, [{ firstName: 'Aad', middleName: null, lastName: 'Fixture', displayName: null }]), false)
  })

  it('fires when the names share no word at all', () => {
    assert.equal(identityConflict(hosted, [{ firstName: 'Other', middleName: null, lastName: 'Person', displayName: 'OTHER PERSON' }]), true)
  })

  it('never fires when a side has no name to compare', () => {
    assert.equal(identityConflict({ ...hosted, first_name: null, last_name: null, legacy_name: null }, [{ firstName: 'Other', middleName: null, lastName: 'Person', displayName: null }]), false)
  })
})

describe('buildLaunchContactPlan', () => {
  function build(students: HostedStudentLike[], rows: ContactImportRow[]) {
    const hosted: HostedSnapshot = { students, programs, batches: [], records: [], intakes: [] }
    const shared = findSharedContacts(rows)
    const assessments = classifyRows(rows, { hosted, duplicates: findDuplicateSourceNumbers(rows), shared, dateUnknownRowIds: new Set() })
    const scope: LaunchScope = {
      members: students.map((s, i) => ({ studentId: s.id, cohortId: 'PSW-2026-06', financeRecordId: `r${i + 1}`, batchId: 'b-jun-m' })),
      batchIdsByCohort: { 'PSW-2026-06': ['b-jun-m'] },
      problems: [],
    }
    return buildLaunchContactPlan({
      scope,
      assessments,
      allRows: rows,
      shared,
      hostedStudents: students,
      workbooks: [{ fileName: 'fixture-psw.xlsx', sha256: 'a'.repeat(64), adapterId: 'psw-masterclass-list' }],
      baseline: { projectRef: 'fixture', counts: { students: students.length, audit_log: 1 }, studentsWithEmail: 3, studentsWithPhone: 0 },
    })
  }

  it('classifies every launch student once and fills only NULL fields', () => {
    const students = [
      student(1),
      student(2, { email: 'kept@example.test' }),
      student(3, { student_number: null }),
      student(4),
      student(5, { first_name: 'Other', last_name: 'Person' }),
    ]
    const rows = [
      row({ studentNumber: '900001', sourceRow: 1 }),
      row({ studentNumber: '900002', sourceRow: 2 }),
      row({ studentNumber: '900005', sourceRow: 5 }),
    ]
    const plan = build(students, rows)
    const status = Object.fromEntries(plan.students.map((s) => [s.studentId, s.status]))
    assert.deepEqual(status, {
      [id(1)]: 'CONTACT_READY',
      [id(2)]: 'ALREADY_FILLED',
      [id(3)]: 'MISSING_STUDENT_NUMBER',
      [id(4)]: 'CONTACT_MISSING',
      [id(5)]: 'CONTACT_SHARED_REVIEW',
    })
    const byId = new Map(plan.candidates.map((c) => [c.studentId, c]))
    assert.equal(byId.get(id(2))?.emailAction, 'hold')
    assert.equal(byId.get(id(2))?.proposedEmail, null)
    assert.equal(byId.get(id(2))?.phoneAction, 'fill')
    assert.equal(byId.get(id(5))?.emailReason, 'HELD_IDENTITY_CONFLICT')
    assert.equal(byId.get(id(5))?.proposedPhone, null)
    assert.equal(plan.aggregate.emailFills, 1)
    assert.equal(plan.aggregate.phoneFills, 2)
    assert.equal(plan.aggregate.identityConflicts, 1)
    assert.equal(plan.aggregate.expectedAuditRows, 2)
    assert.equal(plan.aggregate.expectedEmailNonNullAfter, 4)
    assert.equal(plan.aggregate.nonNullFieldsOverwritten, 0)
    for (const candidate of plan.candidates) {
      const hosted = students.find((s) => s.id === candidate.studentId) as HostedStudentLike
      if (hosted.email !== null) assert.notEqual(candidate.emailAction, 'fill')
      if (hosted.phone !== null) assert.notEqual(candidate.phoneAction, 'fill')
    }
  })

  it('hashes deterministically and changes with the hosted baseline', () => {
    const students = [student(1)]
    const rows = [row({ studentNumber: '900001' })]
    const first = build(students, rows)
    assert.equal(launchPlanHash(first), launchPlanHash(build(students, rows)))
    const changed = { ...first, hostedBaseline: { ...first.hostedBaseline, studentsWithEmail: 4 } }
    assert.notEqual(launchPlanHash(first), launchPlanHash(changed))
  })

  it('holdForIdentity clears every proposed value', () => {
    const plan = build([student(1)], [row({ studentNumber: '900001' })])
    const held = holdForIdentity(plan.candidates[0])
    assert.equal(held.proposedEmail, null)
    assert.equal(held.proposedPhone, null)
    assert.equal(held.emailAction, 'hold')
    assert.ok(held.evidenceFlags.includes('IDENTITY_CONFLICT'))
  })
})

describe('owingSummary', () => {
  it('splits the amount due by whether the student gains an email', () => {
    const students = [
      { financeRecordId: 'r1', emailFill: true, hostedEmailPresent: false, status: 'CONTACT_READY' },
      { financeRecordId: 'r2', emailFill: false, hostedEmailPresent: false, status: 'CONTACT_MISSING' },
      { financeRecordId: 'r3', emailFill: true, hostedEmailPresent: false, status: 'CONTACT_READY' },
    ] as unknown as Parameters<typeof owingSummary>[0]
    const collections = [
      { financeRecordId: 'r1', status: 'AMOUNT_DUE_THROUGH_MONTH', amountDue: 100.1 },
      { financeRecordId: 'r2', status: 'AMOUNT_DUE_THROUGH_MONTH', amountDue: 50.2 },
      { financeRecordId: 'r3', status: 'CREDIT_AHEAD', amountDue: -20 },
    ] as unknown as CollectionAssessment[]
    const summary = owingSummary(students, collections)
    assert.equal(summary.owing, 2)
    assert.equal(summary.owingAmount, 150.3)
    assert.equal(summary.gainEmail, 1)
    assert.equal(summary.gainEmailAmount, 100.1)
    assert.equal(summary.stillWithoutEmail, 1)
    assert.equal(summary.stillWithoutEmailAmount, 50.2)
  })
})
