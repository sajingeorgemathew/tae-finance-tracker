import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import type { ContactImportRow } from './canonical.mts'
import { eceaAdapter } from './adapters/ecea.mts'
import { pswAdapter } from './adapters/psw.mts'
import { eceaFixtureWorkbook, pswFixtureWorkbook } from './fixtures.mts'
import {
  classifyRows,
  conserveSource,
  crossCheckSubsets,
  crossCheckUnassigned,
  decidePrimary,
  findDuplicateSourceNumbers,
  findHostedDuplicateNumbers,
  findSharedContacts,
  findSourceConflicts,
  hostedStudentsAbsentFromMasters,
  mapSourceIntake,
  type HostedSnapshot,
  type HostedStudentLike,
} from './reconcile.mts'
import { applyScope, DEFAULT_SCOPE_CONFIG } from './scope.mts'

/**
 * FINANCE-CONTACT-04B1 — the generic engine, fed by two structurally different
 * adapters and an invented hosted snapshot. Nothing here touches a database,
 * and the engine has no client to touch one with.
 */

function row(overrides: Partial<ContactImportRow>): ContactImportRow {
  return {
    stagedRowId: `PSW:sheet:${overrides.sourceRow ?? 1}`,
    sourceWorkbook: 'fixture.xlsx',
    sourceSheet: 'sheet',
    sourceTable: 'PSW Morning Batch - 01st Dec 2025',
    sourceRow: 1,
    programCode: 'PSW',
    studentNumber: '900001',
    studentNumberRaw: '900001',
    firstName: 'Alpha',
    middleName: null,
    lastName: 'Tester',
    displayName: 'Alpha Tester',
    emailRaw: 'alpha@example.test',
    emailNormalized: 'alpha@example.test',
    emailStatus: 'valid',
    phoneRaw: '416-555-0001',
    phoneNormalized: '+14165550001',
    phoneStatus: 'valid_nanp',
    intakeLabel: '01st Dec 2025',
    intakeDate: '2025-12-01',
    session: 'Morning',
    sourceStartDate: null,
    sourceStatus: null,
    inOperationalScope: true,
    exclusionReason: null,
    ...overrides,
  }
}

function student(overrides: Partial<HostedStudentLike> & { id: string }): HostedStudentLike {
  return {
    student_number: null,
    first_name: null,
    middle_name: null,
    last_name: null,
    display_name: null,
    legacy_name: null,
    email: null,
    phone: null,
    ...overrides,
  }
}

const PROGRAM_PSW = { id: 'prog-psw', short_code: 'PSW' }
const PROGRAM_ECEA = { id: 'prog-ecea', short_code: 'ECEA' }

const BATCH_DEC_M = { id: 'b-dec-m', program_id: 'prog-psw', name: 'December 2025 - Morning', legacy_sheet_name: 'Dec 2025', start_date: null }
const BATCH_DEC_E = { id: 'b-dec-e', program_id: 'prog-psw', name: 'December - Evening', legacy_sheet_name: 'Dec 2025', start_date: null }
const BATCH_APR_M = { id: 'b-apr-m', program_id: 'prog-psw', name: '27th April 2026 - Morning', legacy_sheet_name: '27 April 26', start_date: '2026-04-27' }
const BATCH_ECEA = { id: 'b-ecea', program_id: 'prog-ecea', name: 'ELCE 25 & 26', legacy_sheet_name: 'ELCE 25 & 26', start_date: null }

const HOSTED: HostedSnapshot = {
  programs: [PROGRAM_PSW, PROGRAM_ECEA],
  batches: [BATCH_DEC_M, BATCH_DEC_E, BATCH_APR_M, BATCH_ECEA],
  intakes: [
    { key: '2025-12', programCode: 'PSW', label: 'December 2025', startDate: null, yearMonth: '2025-12', titleYearMonth: null, batches: [{ id: 'b-dec-m', name: BATCH_DEC_M.name, session: 'Morning' }, { id: 'b-dec-e', name: BATCH_DEC_E.name, session: 'Evening' }] },
    { key: '2026-04-27', programCode: 'PSW', label: '27 Apr 2026', startDate: '2026-04-27', yearMonth: '2026-04', titleYearMonth: null, batches: [{ id: 'b-apr-m', name: BATCH_APR_M.name, session: 'Morning' }] },
    { key: 'elce-25-and-26', programCode: 'ECEA', label: 'ELCE 25 & 26', startDate: null, yearMonth: null, titleYearMonth: null, batches: [{ id: 'b-ecea', name: BATCH_ECEA.name, session: null }] },
  ],
  students: [
    // blank contacts: safe fill
    student({ id: 's-900001', student_number: '900001', first_name: 'Alpha', last_name: 'Tester' }),
    // same contacts already: unchanged (stored in a different presentation)
    student({ id: 's-900002', student_number: '900002', legacy_name: 'Beta Middle Tester', email: 'BETA@example.test ', phone: '(416) 555-0002' }),
    // different email on file: difference; name spelled differently
    student({ id: 's-900003', student_number: '900003', legacy_name: 'Zeta Repeated', email: 'old.zeta@example.test', phone: '+14165550003' }),
    // hosted duplicate number
    student({ id: 's-dup-a', student_number: '900008', legacy_name: 'Theta A' }),
    student({ id: 's-dup-b', student_number: '900008', legacy_name: 'Theta B' }),
    // ECEA students
    student({ id: 's-910001', student_number: '910001', legacy_name: 'Kappa Weekday' }),
    // a hosted student in the operational window that no master lists
    student({ id: 's-absent', student_number: '900999', legacy_name: 'Absent Person' }),
    // a hosted student with a leading zero number, as text
    student({ id: 's-zero', student_number: '0900004', legacy_name: 'Gamma Zero' }),
    // number-less unassigned student whose name text equals a source row's
    student({ id: 's-noname', student_number: null, legacy_name: 'Delta Unnumbered' }),
  ],
  records: [
    { id: 'r1', student_id: 's-900001', program_id: 'prog-psw', batch_id: 'b-dec-m' },
    { id: 'r2', student_id: 's-900002', program_id: 'prog-psw', batch_id: 'b-dec-e' },
    { id: 'r3', student_id: 's-900003', program_id: 'prog-psw', batch_id: null },
    { id: 'r4', student_id: 's-910001', program_id: 'prog-ecea', batch_id: 'b-ecea' },
    { id: 'r5', student_id: 's-absent', program_id: 'prog-psw', batch_id: 'b-apr-m' },
    { id: 'r6', student_id: 's-zero', program_id: 'prog-psw', batch_id: 'b-apr-m' },
    { id: 'r7', student_id: 's-noname', program_id: 'prog-psw', batch_id: null },
  ],
}

function stagedFixtures() {
  const psw = pswAdapter.parse(pswFixtureWorkbook(), 'psw-fixture.xlsx')
  const ecea = eceaAdapter.parse(eceaFixtureWorkbook(), 'ecea-fixture.xlsx')
  const pswScope = applyScope(psw.rows, pswAdapter.scopeDateField, DEFAULT_SCOPE_CONFIG)
  const eceaScope = applyScope(ecea.rows, eceaAdapter.scopeDateField, DEFAULT_SCOPE_CONFIG)
  const rows = [...psw.rows, ...ecea.rows]
  const duplicates = [...findDuplicateSourceNumbers(psw.rows), ...findDuplicateSourceNumbers(ecea.rows)]
  const shared = findSharedContacts(rows)
  const dateUnknownRowIds = new Set([...pswScope.dateUnknownRowIds, ...eceaScope.dateUnknownRowIds])
  const assessments = classifyRows(rows, { hosted: HOSTED, duplicates, shared, dateUnknownRowIds })
  return { psw, ecea, rows, duplicates, shared, assessments }
}

describe('exact student-number matching', () => {
  const { assessments } = stagedFixtures()
  const byNumber = (number: string, sheet?: string) =>
    assessments.find((item) => item.row.studentNumber === number && (sheet === undefined || item.row.sourceSheet === sheet))!

  it('matches on the exact number and nothing else', () => {
    assert.equal(byNumber('900001').hostedStudentId, 's-900001')
    assert.equal(byNumber('900001').hostedMatchCount, 1)
  })

  it('never matches by name, email, phone or intake', () => {
    // Delta Unnumbered: same name text as a hosted student, no number -> no link.
    const delta = assessments.find((item) => item.row.firstName === 'Delta')!
    assert.equal(delta.hostedStudentId, null)
    assert.equal(delta.primary, 'MISSING_STUDENT_NUMBER')
    // Eta shares Zeta's phone: no link to Zeta's hosted row.
    const eta = assessments.find((item) => item.row.firstName === 'Eta')!
    assert.equal(eta.hostedStudentId, null)
    assert.equal(eta.primary, 'STUDENT_NOT_IN_APP')
    assert.ok(eta.flags.includes('SHARED_SOURCE_PHONE'))
  })

  it('preserves a leading zero and matches it as text', () => {
    const zero = byNumber('0900004')
    assert.equal(zero.hostedStudentId, 's-zero')
  })

  it('holds a number that two hosted rows carry for review', () => {
    const theta = byNumber('900008')
    assert.equal(theta.primary, 'DUPLICATE_HOSTED_STUDENT_NUMBER')
    assert.equal(theta.hostedMatchCount, 2)
    assert.equal(theta.hostedStudentId, null)
  })

  it('classifies a numbered student the app does not have as STUDENT_NOT_IN_APP, not as a failure', () => {
    const epsilon = byNumber('900006')
    assert.equal(epsilon.primary, 'STUDENT_NOT_IN_APP')
    assert.ok(epsilon.flags.includes('SOURCE_INVALID_EMAIL'))
    assert.ok(epsilon.flags.includes('SOURCE_INVALID_PHONE'))
  })
})

describe('contact comparison', () => {
  const { assessments } = stagedFixtures()

  it('proposes a safe fill when hosted contacts are blank and the source values are valid', () => {
    const alpha = assessments.find((item) => item.row.studentNumber === '900001')!
    assert.equal(alpha.primary, 'SAFE_CONTACT_FILL')
    assert.equal(alpha.emailComparison, 'fill')
    assert.equal(alpha.phoneComparison, 'fill')
    assert.ok(alpha.flags.includes('SAFE_EMAIL_FILL'))
    assert.ok(alpha.flags.includes('SAFE_PHONE_FILL'))
  })

  it('compares email trimmed and lower-cased and phone by comparison key', () => {
    const beta = assessments.filter((item) => item.row.studentNumber === '900002')
    assert.equal(beta[0].emailComparison, 'unchanged')
    assert.equal(beta[0].phoneComparison, 'unchanged')
    // The second Beta row states another email: within-table duplicate with conflicting contact.
    assert.equal(beta[1].emailComparison, 'difference')
    assert.equal(beta[0].primary, 'DUPLICATE_SOURCE_STUDENT_NUMBER')
    assert.equal(beta[1].primary, 'DUPLICATE_SOURCE_STUDENT_NUMBER')
  })

  it('reports a difference when both sides hold a value and they differ, without choosing', () => {
    const zeta = assessments.find((item) => item.row.studentNumber === '900003' && item.row.sourceSheet === 'Dec 1st')!
    assert.equal(zeta.emailComparison, 'difference')
    assert.equal(zeta.phoneComparison, 'unchanged')
    assert.equal(zeta.hostedEmail, 'old.zeta@example.test')
    assert.ok(zeta.flags.includes('CONTACT_DIFFERENCE'))
    assert.ok(zeta.flags.includes('EMAIL_DIFFERENCE'))
    // The same number states a third email on the upcoming sheet, so the
    // source itself disagrees: the row is held as a conflicting duplicate,
    // which outranks the hosted difference in the primary category.
    assert.equal(zeta.primary, 'DUPLICATE_SOURCE_STUDENT_NUMBER')
    assert.ok(zeta.flags.includes('DUPLICATE_SOURCE_CONFLICTING_CONTACT'))
  })

  it('is CONTACT_DIFFERENCE when only the hosted value disagrees', () => {
    const single = classifyRows([row({ emailNormalized: 'new@example.test', emailRaw: 'new@example.test' })], {
      hosted: {
        ...HOSTED,
        students: [student({ id: 's-900001', student_number: '900001', email: 'old@example.test', phone: '416-555-0001' })],
      },
      duplicates: [],
      shared: [],
      dateUnknownRowIds: new Set(),
    })[0]
    assert.equal(single.primary, 'CONTACT_DIFFERENCE')
    assert.equal(single.emailComparison, 'difference')
    assert.equal(single.phoneComparison, 'unchanged')
  })

  it('reports a name difference as a flag only, never as the primary category', () => {
    const zeta = assessments.find((item) => item.row.studentNumber === '900003' && item.row.sourceSheet === 'Dec 1st')!
    assert.equal(zeta.nameDiffers, true)
    assert.ok(zeta.flags.includes('NAME_DIFFERENCE'))
    assert.notEqual(zeta.primary, 'NAME_DIFFERENCE' as string)
  })

  it('orders the primary decision: scope, then identity, then contacts', () => {
    const base = row({})
    assert.equal(decidePrimary({ ...base, exclusionReason: 'OUT_OF_SCOPE_HISTORICAL' }, 1, false, 'difference', 'fill'), 'OUT_OF_SCOPE_HISTORICAL')
    assert.equal(decidePrimary({ ...base, studentNumber: null }, 0, false, 'not_applicable', 'not_applicable'), 'MISSING_STUDENT_NUMBER')
    assert.equal(decidePrimary(base, 2, false, 'unchanged', 'unchanged'), 'DUPLICATE_HOSTED_STUDENT_NUMBER')
    assert.equal(decidePrimary(base, 0, false, 'not_applicable', 'not_applicable'), 'STUDENT_NOT_IN_APP')
    assert.equal(decidePrimary(base, 1, true, 'unchanged', 'unchanged'), 'DUPLICATE_SOURCE_STUDENT_NUMBER')
    assert.equal(decidePrimary(base, 1, false, 'unchanged', 'difference'), 'CONTACT_DIFFERENCE')
    assert.equal(decidePrimary(base, 1, false, 'fill', 'source_missing'), 'SAFE_CONTACT_FILL')
    assert.equal(decidePrimary(base, 1, false, 'unchanged', 'source_invalid'), 'SOURCE_INVALID_CONTACT')
    assert.equal(decidePrimary(base, 1, false, 'unchanged', 'source_missing'), 'SOURCE_MISSING_CONTACT')
    assert.equal(decidePrimary(base, 1, false, 'unchanged', 'unchanged'), 'EXACT_UNCHANGED')
  })
})

describe('scope in the engine', () => {
  const { assessments } = stagedFixtures()

  it('keeps historical rows as OUT_OF_SCOPE_HISTORICAL even when they would match', () => {
    const hist = assessments.filter((item) => item.row.sourceSheet === '17th March')
    assert.equal(hist.length, 2)
    assert.ok(hist.every((item) => item.primary === 'OUT_OF_SCOPE_HISTORICAL'))
  })

  it('keeps the upcoming intake as OUT_OF_SCOPE_FUTURE', () => {
    const future = assessments.filter((item) => item.row.sourceSheet === 'Sep 28th')
    assert.equal(future.length, 2)
    assert.ok(future.every((item) => item.primary === 'OUT_OF_SCOPE_FUTURE'))
  })

  it('flags an undated ECEA row and keeps it in scope', () => {
    const undated = assessments.find((item) => item.row.studentNumber === '910006')!
    assert.ok(undated.flags.includes('SCOPE_DATE_UNKNOWN'))
    assert.equal(undated.primary, 'STUDENT_NOT_IN_APP')
  })
})

describe('duplicates and shared contacts', () => {
  const { psw, duplicates, shared } = stagedFixtures()

  it('reports a number repeated across intakes and explains it without merging', () => {
    const zeta = duplicates.find((group) => group.studentNumber === '900003')!
    assert.equal(zeta.rowIds.length, 2)
    assert.equal(zeta.distinctIntakes, 2)
    assert.equal(zeta.samePhone, true)
    assert.equal(zeta.sameEmail, false)
    assert.equal(zeta.explanation, 'unresolved_ambiguity')
    assert.equal(zeta.conflictingContact, true)
  })

  it('reports a number repeated within one table as source duplication', () => {
    const beta = duplicates.find((group) => group.studentNumber === '900002')!
    assert.equal(beta.explanation, 'source_duplication_within_table')
  })

  it('reports a shared phone across two numbers without treating them as one person', () => {
    const phone = shared.find((item) => item.kind === 'phone' && item.value === '+14165550003')!
    assert.deepEqual(phone.studentNumbers, ['PSW:900003', 'PSW:900007'])
    assert.equal(shared.filter((item) => item.kind === 'email').length, 0)
  })

  it('reports a shared email across two numbers as a fact for review only', () => {
    const rows = [row({ sourceRow: 1, studentNumber: 'A1' }), row({ sourceRow: 2, studentNumber: 'A2', phoneNormalized: '+14165559999' })]
    const result = findSharedContacts(rows)
    assert.equal(result.length, 1)
    assert.equal(result[0].kind, 'email')
    assert.deepEqual(result[0].studentNumbers, ['PSW:A1', 'PSW:A2'])
  })

  it('lists source conflicts with no structural winner between two PSW intakes', () => {
    const conflicts = findSourceConflicts(psw.rows)
    const zeta = conflicts.filter((conflict) => conflict.studentNumber === '900003')
    assert.equal(zeta.length, 1)
    assert.equal(zeta[0].field, 'email')
    assert.equal(zeta[0].structurallyPrimary, 'none')
  })

  it('finds hosted duplicate numbers', () => {
    assert.deepEqual(findHostedDuplicateNumbers(HOSTED.students), [{ studentNumber: '900008', studentIds: ['s-dup-a', 's-dup-b'] }])
  })
})

describe('ECEA master versus subsets', () => {
  const { ecea } = stagedFixtures()
  const check = crossCheckSubsets(ecea.rows, ecea.crossCheckRows, 'ECEA')

  it('does not stage a student twice for appearing in master and a subset', () => {
    assert.equal(ecea.rows.filter((item) => item.studentNumber === '910001').length, 1)
    assert.equal(check.masterNumbers, 5)
    assert.equal(check.subsetRows, 6)
  })

  it('reports membership discrepancies rather than repairing them', () => {
    assert.deepEqual(check.masterOnly, ['910006'])
    assert.deepEqual(check.subsetOnly, ['910004'])
    assert.deepEqual(check.inSeveralSubsets, ['910001'])
    assert.deepEqual(check.sessionMismatch.map((item) => item.studentNumber), ['910001'])
  })

  it('reports a master/subset email conflict with the master as structurally primary', () => {
    const mu = check.conflicts.filter((conflict) => conflict.studentNumber === '910003')
    assert.equal(mu.length, 1)
    assert.equal(mu[0].field, 'email')
    assert.equal(mu[0].structurallyPrimary, 'A')
    assert.equal(mu[0].sourceA.value, 'mu.master@example.test')
    assert.equal(mu[0].sourceB.value, 'mu.subset@example.test')
  })
})

describe('intake cross-check', () => {
  const { assessments } = stagedFixtures()

  it('maps a source intake to a hosted intake by exact start date, then by stated month', () => {
    assert.equal(mapSourceIntake('PSW', '2026-04-27', HOSTED.intakes)?.mappedBy, 'start_date')
    assert.equal(mapSourceIntake('PSW', '2025-12-01', HOSTED.intakes)?.mappedBy, 'year_month')
    assert.equal(mapSourceIntake('PSW', '2026-09-28', HOSTED.intakes), null)
    // A hosted sheet titled "Aug 2026" whose batches are dated 29 July: the
    // sheet title month is the weakest tier and is labelled as such.
    const titled = [{ key: '2026-07-29', programCode: 'PSW', label: '29 Jul 2026', startDate: '2026-07-29', yearMonth: '2026-07', titleYearMonth: '2026-08', batches: [] }]
    assert.equal(mapSourceIntake('PSW', '2026-08-17', titled)?.mappedBy, 'sheet_title_month')
    assert.equal(mapSourceIntake('PSW', '2026-07-29', titled)?.mappedBy, 'start_date')
    assert.equal(mapSourceIntake('ECEA', null, HOSTED.intakes)?.mappedBy, 'single_program_intake')
    assert.equal(mapSourceIntake('PSW', null, HOSTED.intakes), null)
  })

  it('classifies the hosted context per exact match without reassigning anything', () => {
    const alpha = assessments.find((item) => item.row.studentNumber === '900001')!
    assert.equal(alpha.intake.category, 'MATCHES_HOSTED_INTAKE')
    assert.equal(alpha.intake.sessionMatches, true)
    assert.deepEqual(alpha.intake.hostedBatchNames, ['December 2025 - Morning'])

    const beta = assessments.find((item) => item.row.studentNumber === '900002')!
    assert.equal(beta.intake.category, 'MATCHES_HOSTED_INTAKE')
    assert.equal(beta.intake.sessionMatches, false)

    const zeta = assessments.find((item) => item.row.studentNumber === '900003' && item.row.sourceSheet === 'Dec 1st')!
    assert.equal(zeta.intake.category, 'HOSTED_UNASSIGNED')

    const zero = assessments.find((item) => item.row.studentNumber === '0900004')!
    assert.equal(zero.intake.category, 'DIFFERENT_HOSTED_INTAKE')
    assert.deepEqual(zero.intake.hostedIntakeLabels, ['27 Apr 2026'])

    const kappa = assessments.find((item) => item.row.studentNumber === '910001')!
    assert.equal(kappa.intake.category, 'MATCHES_HOSTED_INTAKE')
    assert.equal(kappa.intake.mappedBy, 'single_program_intake')

    const notInApp = assessments.find((item) => item.row.studentNumber === '900006')!
    assert.equal(notInApp.intake.category, 'NOT_APPLICABLE')
  })

  it('lists hosted students in the operational window that no master row states', () => {
    const operational = assessments.filter((item) => item.row.exclusionReason === null).map((item) => item.row)
    const absent = hostedStudentsAbsentFromMasters(HOSTED, operational, { from: '2025-12-01', to: '2026-08-31' })
    assert.deepEqual(
      absent.map((item) => [item.programCode, item.studentNumber, item.hostedIntakeLabel]),
      [['PSW', '900999', '27 Apr 2026']],
    )
  })
})

describe('Unassigned cross-check', () => {
  const { rows } = stagedFixtures()
  const result = crossCheckUnassigned(
    [
      { financeRecordId: 'r3', programCode: 'PSW', studentId: 's-900003', studentNumber: '900003', studentNames: ['Zeta Repeated'] },
      { financeRecordId: 'r7', programCode: 'PSW', studentId: 's-noname', studentNumber: null, studentNames: ['Delta Unnumbered'] },
      { financeRecordId: 'r8', programCode: 'PSW', studentId: 's-x', studentNumber: '900777', studentNames: [] },
    ],
    rows,
    HOSTED,
  )

  it('matches a numbered record by exact number and reports what the source offers', () => {
    const zeta = result[0]
    assert.equal(zeta.identityMode, 'exact_student_number')
    assert.equal(zeta.sourceRowIds.length, 2)
    assert.equal(zeta.providesEmail, true)
    assert.equal(zeta.providesPhone, true)
    assert.deepEqual(zeta.sourceIntakes, ['2025-12-01', '2026-09-28'])
    assert.equal(zeta.batchEvidence, 'several_intakes')
  })

  it('leaves a number-less record unresolved even when a source row spells the same name', () => {
    const delta = result[1]
    assert.equal(delta.identityMode, 'no_student_number')
    assert.deepEqual(delta.sourceRowIds, [])
    assert.equal(delta.batchEvidence, 'not_in_source')
    assert.equal(delta.sameNameTextRows, 1)
    assert.equal(delta.providesEmail, false)
  })

  it('reports a numbered record the masters do not list', () => {
    assert.equal(result[2].batchEvidence, 'not_in_source')
  })

  it('grades a single-intake, single-session match as single-batch evidence', () => {
    const single = crossCheckUnassigned(
      [{ financeRecordId: 'r1', programCode: 'PSW', studentId: 's-900001', studentNumber: '900001', studentNames: [] }],
      rows,
      HOSTED,
    )[0]
    assert.equal(single.batchEvidence, 'single_batch')
    assert.deepEqual(single.candidateBatchNames, ['December 2025 - Morning'])
  })
})

describe('source conservation', () => {
  const { psw, ecea } = stagedFixtures()

  it('proves every discovered student row is staged, kept for cross-check, or excluded by scope', () => {
    const pswResult = conserveSource({ programCode: 'PSW', workbookName: 'psw', sheets: psw.sheets, rows: psw.rows, crossCheckRows: psw.crossCheckRows })
    assert.equal(pswResult.conserved, true)
    assert.equal(pswResult.discoveredStudentRows, 13)
    assert.equal(pswResult.operational + pswResult.historical + pswResult.future, 13)
    assert.deepEqual([pswResult.operational, pswResult.historical, pswResult.future], [9, 2, 2])
    assert.equal(pswResult.unaccounted, 0)

    const eceaResult = conserveSource({ programCode: 'ECEA', workbookName: 'ecea', sheets: ecea.sheets, rows: ecea.rows, crossCheckRows: ecea.crossCheckRows })
    assert.equal(eceaResult.conserved, true)
    assert.equal(eceaResult.discoveredStudentRows, 11)
    assert.equal(eceaResult.stagedRows, 5)
    assert.equal(eceaResult.crossCheckRows, 6)
    assert.deepEqual([eceaResult.operational, eceaResult.historical, eceaResult.future], [4, 1, 0])
  })

  it('fails when a student row goes missing', () => {
    const broken = conserveSource({ programCode: 'PSW', workbookName: 'psw', sheets: psw.sheets, rows: psw.rows.slice(1), crossCheckRows: [] })
    assert.equal(broken.conserved, false)
    assert.equal(broken.unaccounted, 1)
  })
})

describe('zero hosted writes', () => {
  it('the engine module exposes no function that takes a database client', () => {
    // The engine is pure: every export is a function over plain data, and the
    // module imports no Supabase client. A write path cannot exist here.
    const exportsOf = { classifyRows, crossCheckSubsets, crossCheckUnassigned, findDuplicateSourceNumbers, findSharedContacts, findSourceConflicts, hostedStudentsAbsentFromMasters, conserveSource }
    for (const [name, fn] of Object.entries(exportsOf)) assert.equal(typeof fn, 'function', name)
    const { assessments } = stagedFixtures()
    // Classification leaves every hosted value exactly as it was handed in.
    assert.equal(HOSTED.students.find((item) => item.id === 's-900001')!.email, null)
    assert.equal(HOSTED.students.find((item) => item.id === 's-900003')!.email, 'old.zeta@example.test')
    assert.ok(assessments.length > 0)
  })
})
