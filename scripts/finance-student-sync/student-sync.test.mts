import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import * as XLSX from 'xlsx'

import { supersededRefusal } from '../finance-contact/launch-contact.mts'

import { InputError, parseStudentGrid, readStudentFile, type IncomingFile } from './input.mts'
import { buildSyncPlan, incomingMonth, incomingSession, nameConsistency, syncPlanHash, withinOneEdit, type LiveStudent, type ScopeCohort } from './reconcile.mts'
import { renderPreviewCsv, renderSummary } from './report.mts'
import { parseSyncArguments, syncApplyRefusal } from './student-sync.mts'

/**
 * FINANCE-STUDENT-SYNC-05B on invented data only: `example.test` addresses,
 * 555 numbers, 9xxxxx student numbers, fixture UUIDs. No database.
 */

const COHORTS: ScopeCohort[] = [
  { id: 'PSW-2026-06', label: 'PSW June 2026', programShortCode: 'PSW', yearMonth: '2026-06' },
  { id: 'PSW-2026-08', label: 'PSW August 2026', programShortCode: 'PSW', yearMonth: '2026-08' },
]
const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const HEAD = ['Student Number', 'Student Name', 'Email', 'Phone', 'Batch / Intake', 'Session']

function live(n: number, name: string, overrides: Partial<LiveStudent> = {}): LiveStudent {
  return {
    studentId: id(n),
    studentNumber: String(900000 + n),
    name,
    nameParts: [name],
    email: null,
    phone: null,
    cohortId: 'PSW-2026-06',
    batchId: 'b-jun-m',
    batchName: 'PSW June 2026 · 1st June, 2026 - Morning',
    acceptedMonths: ['2026-06'],
    session: 'Morning',
    ...overrides,
  }
}

function fileOf(rows: (string | null)[][]): IncomingFile {
  return { ...parseStudentGrid([HEAD, ...rows], { fileName: 'current.csv', sheet: 'Sheet1' }), sha256: 'f'.repeat(64) }
}

function plan(rows: (string | null)[][], students: LiveStudent[], outside: { studentNumber: string; label: string }[] = []) {
  return buildSyncPlan({
    scope: { id: 'test', cohorts: COHORTS },
    file: fileOf(rows),
    live: students,
    outside,
    baseline: { projectRef: 'fixture', counts: { students: students.length }, studentsWithEmail: 0, studentsWithPhone: 0 },
  })
}

const classOf = (p: ReturnType<typeof plan>, key: string) => p.rows.filter((r) => r.studentNumber === key || r.rowRef === key).map((r) => r.classification)

describe('input', () => {
  it('finds the header below a title, maps aliases and never reads sensitive columns', () => {
    const grid = [
      ['Current students — November'],
      [],
      ['Student No.', 'First Name', 'Last Name', 'E-mail', 'Mobile', 'Intake', 'Date of Birth', 'Password', 'Notes'],
      ['0900001', 'Ada', 'Fixture', ' Ada@Example.test ', '(416) 555-0101', 'June 2026', '1990-01-31', 'secret', 'x'],
      [null, null, null, null, null, null, null, null, null],
    ]
    const parsed = parseStudentGrid(grid, { fileName: 'f.xlsx', sheet: 'S' })
    assert.equal(parsed.header.headerRow, 3)
    assert.deepEqual(parsed.header.sensitiveNotRead, ['Date of Birth', 'Password'])
    assert.deepEqual(parsed.header.ignored, ['Notes'])
    assert.equal(parsed.blankRows, 1)
    const [row] = parsed.rows
    assert.equal(row.studentNumber, '0900001', 'leading zero kept: the number is exact')
    assert.equal(row.name, 'Ada Fixture')
    assert.equal(row.email.normalized, 'ada@example.test')
    assert.equal(row.phone.normalized, '+14165550101')
    assert.equal(row.rowRef, 'f.xlsx#S!4')
    assert.equal(JSON.stringify(row).includes('secret'), false)
  })

  it('refuses a file with no Student Number heading or no name column', () => {
    assert.throws(() => parseStudentGrid([['Name', 'Email']], { fileName: 'f', sheet: 's' }), InputError)
    assert.throws(() => parseStudentGrid([['Student Number', 'Email']], { fileName: 'f', sheet: 's' }), InputError)
  })

  it('reads a real .xlsx and keeps numbers as displayed text', async () => {
    const { mkdtempSync, writeFileSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([HEAD, [900001, 'Ada Fixture', 'a@example.test', 4165550101, 'June 2026', 'Morning']]), 'Sheet1')
    const file = join(mkdtempSync(join(tmpdir(), 'sync-')), 'current.xlsx')
    writeFileSync(file, XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }))
    const read = readStudentFile(file)
    assert.equal(read.rows[0].studentNumber, '900001')
    assert.equal(read.rows[0].phone.normalized, '+14165550101')
    assert.match(read.sha256, /^[0-9a-f]{64}$/)
  })
})

describe('rules', () => {
  it('withinOneEdit: one substitution, insertion, deletion or adjacent swap', () => {
    assert.equal(withinOneEdit('EDYLNE', 'EDLYNE'), true)
    assert.equal(withinOneEdit('SMITH', 'SMYTH'), true)
    assert.equal(withinOneEdit('SMITH', 'SMITHE'), true)
    assert.equal(withinOneEdit('SMITH', 'JONES'), false)
  })

  it('nameConsistency: middle names and typos are variants; a different person is a conflict', () => {
    assert.equal(nameConsistency(['ADA FIXTURE'], 'Ada Fixture'), 'SAME')
    assert.equal(nameConsistency(['ADA FIXTURE'], 'ADA BYRON FIXTURE'), 'VARIANT')
    assert.equal(nameConsistency(['EDYLNE LUBINA'], 'EDLYNE LUBINA'), 'VARIANT')
    assert.equal(nameConsistency(['ADA FIXTURE'], 'OTHER PERSON'), 'CONFLICT')
    assert.equal(nameConsistency(['ADA FIXTURE'], 'ADA JONES'), 'CONFLICT', 'one shared word is not enough')
    assert.equal(nameConsistency(['ADA FIXTURE'], null), 'INCOMING_MISSING')
  })

  it('reads intake months and sessions', () => {
    assert.equal(incomingMonth('June 2026'), '2026-06')
    assert.equal(incomingMonth('1st June, 2026 - Morning'), '2026-06')
    assert.equal(incomingMonth('2026-08-17'), '2026-08')
    assert.equal(incomingMonth('PSW August 2026'), '2026-08')
    assert.equal(incomingMonth('next one'), null)
    assert.equal(incomingSession(null, '1st June 2026 - Evening'), 'Evening')
    assert.equal(incomingSession('Morning', null), 'Morning')
  })
})

describe('buildSyncPlan', () => {
  const students = [
    live(1, 'ADA FIXTURE'),
    live(2, 'BEA FIXTURE', { email: 'bea@example.test' }),
    live(3, 'CAL FIXTURE'),
    live(4, 'DEE FIXTURE'),
    live(5, 'EVE FIXTURE', { email: 'eve.old@example.test' }),
    live(6, 'FAY FIXTURE'),
    live(7, 'GUS FIXTURE', { studentNumber: null }),
    live(8, 'HAL FIXTURE'),
    live(9, 'IDA FIXTURE', { cohortId: 'PSW-2026-08', acceptedMonths: ['2026-07', '2026-08'], session: 'Evening' }),
    live(10, 'JAY KAY FIXTURE'),
    live(11, 'LIA MAE FIXTURE'),
  ]
  const p = plan(
    [
      ['900001', 'Ada Fixture', 'ada@example.test', '416-555-0101', 'June 2026', 'Morning'], // SAFE_UPDATE
      ['900002', 'Bea Fixture', 'BEA@example.test', null, 'June 2026', 'Morning'], // NO_CHANGE
      ['900011', 'Lia Fixture', 'lia@example.test', null, 'June 2026', 'Morning'], // name variant: review; email still safe
      ['900099', 'Jay Kay Fixture', null, null, 'June 2026', 'Morning'], // proposed number change 900010 -> 900099
      ['900003', 'Other Person', 'cal@example.test', null, 'June 2026', 'Morning'], // CONFLICT: wrong number
      ['900004', 'Dee Fixture', 'not-an-email', null, 'June 2026', 'Morning'], // INVALID_CONTACT
      ['900005', 'Eve Fixture', 'eve.new@example.test', null, 'June 2026', 'Morning'], // CONFLICT: non-NULL differs
      ['900006', 'Fay Fixture', 'fay@example.test', null, 'August 2026', 'Morning'], // CONFLICT: batch move
      ['900100', 'New Person', 'new@example.test', null, 'June 2026', 'Evening'], // NEW_STUDENT
      ['900101', 'Old Cohort', null, null, 'March 2026', null], // OUT_OF_SCOPE
      [null, 'Gus Fixture', 'gus@example.test', null, 'June 2026', null], // MISSING_STUDENT_NUMBER
      ['900200', 'Twin One', 'x@example.test', null, 'June 2026', null], // DUPLICATE
      ['900200', 'Twin Two', 'y@example.test', null, 'June 2026', null], // DUPLICATE
      ['900009', 'Ida Fixture', 'ida@example.test', null, '29th July 2026', 'Evening'], // SAFE (July accepted for Aug cohort)
    ],
    students,
    [{ studentNumber: '900101', label: 'March 2026' }],
  )

  it('classifies every incoming row and every unmatched live student', () => {
    assert.deepEqual(classOf(p, '900001'), ['SAFE_UPDATE'])
    assert.deepEqual(classOf(p, '900002'), ['NO_CHANGE'])
    assert.deepEqual(classOf(p, '900003'), ['CONFLICT_REVIEW'])
    assert.deepEqual(classOf(p, '900004'), ['INVALID_CONTACT'])
    assert.deepEqual(classOf(p, '900005'), ['CONFLICT_REVIEW'])
    assert.deepEqual(classOf(p, '900006'), ['CONFLICT_REVIEW'])
    assert.deepEqual(classOf(p, '900100'), ['NEW_STUDENT'])
    assert.deepEqual(classOf(p, '900101'), ['OUT_OF_SCOPE'])
    assert.deepEqual(classOf(p, '900200'), ['DUPLICATE_STUDENT_NUMBER', 'DUPLICATE_STUDENT_NUMBER'])
    assert.deepEqual(classOf(p, '900009'), ['SAFE_UPDATE'])
    assert.deepEqual(classOf(p, '900008'), ['MISSING_FROM_CURRENT_LIST'])
    const numberless = p.rows.filter((r) => r.classification === 'MISSING_STUDENT_NUMBER')
    assert.deepEqual(numberless.map((r) => r.side).sort(), ['incoming', 'live'])
    assert.ok(numberless.find((r) => r.side === 'incoming')?.warnings.some((w) => w.includes('(no number)')))
    assert.deepEqual(classOf(p, '900011'), ['CONFLICT_REVIEW'])
    assert.deepEqual(classOf(p, '900099'), ['CONFLICT_REVIEW'])
    assert.deepEqual(classOf(p, '900010'), ['MISSING_FROM_CURRENT_LIST'])
    assert.ok(p.rows.find((r) => r.studentNumber === '900010')?.reasons.some((r) => r.includes('possibly listed under another number')))
    assert.equal(p.summary.liveScopedStudents, 11)
    assert.equal(p.summary.incomingRows, 14)
  })

  it('marks every field SAFE_CONTACT_UPDATE / IDENTITY_REVIEW_REQUIRED / NO_CHANGE', () => {
    const status = (number: string, field: string) => p.rows.find((r) => r.side === 'incoming' && r.studentNumber === number)?.fields.find((f) => f.field === field)?.status
    assert.equal(status('900001', 'email'), 'SAFE_CONTACT_UPDATE')
    assert.equal(status('900001', 'name'), 'NO_CHANGE')
    assert.equal(status('900001', 'studentNumber'), 'NO_CHANGE')
    assert.equal(status('900011', 'name'), 'IDENTITY_REVIEW_REQUIRED', 'name changes always need review')
    assert.equal(status('900011', 'email'), 'SAFE_CONTACT_UPDATE', 'a consistent identity keeps its safe NULL fill')
    assert.equal(status('900003', 'name'), 'IDENTITY_REVIEW_REQUIRED')
    assert.equal(status('900003', 'email'), 'IDENTITY_REVIEW_REQUIRED', 'held: identity not confirmed')
    assert.equal(status('900006', 'batch'), 'IDENTITY_REVIEW_REQUIRED')
    assert.equal(status('900006', 'email'), 'IDENTITY_REVIEW_REQUIRED')
    assert.equal(status('900005', 'email'), 'IDENTITY_REVIEW_REQUIRED', 'non-NULL difference')
    assert.equal(status('900004', 'email'), 'NO_CHANGE', 'invalid value is never used')
    assert.equal(status('900099', 'studentNumber'), 'IDENTITY_REVIEW_REQUIRED')
    for (const row of p.rows) for (const f of row.fields) if (f.status === 'SAFE_CONTACT_UPDATE') assert.ok(['email', 'phone'].includes(f.field))
  })

  it('safe changes are email/phone NULL fills only; everything else is a review item', () => {
    assert.deepEqual(
      p.safeChanges.map((c) => `${c.studentNumber}:${c.field}:${c.expectedCurrent}`).sort(),
      ['900001:email:null', '900001:phone:null', '900009:email:null', '900011:email:null'],
    )
    const items = p.reviewItems.map((c) => `${c.studentNumber}:${c.field}`).sort()
    for (const expected of ['900003:name', '900003:email', '900005:email', '900006:batch', '900011:name', '900099:studentNumber']) assert.ok(items.includes(expected), expected)
    const number = p.reviewItems.find((c) => c.field === 'studentNumber')!
    assert.deepEqual([number.current, number.incoming, number.studentId], ['900010', '900099', id(10)])
    assert.deepEqual(p.reviewItems.find((c) => c.studentNumber === '900005')!.current, 'eve.old@example.test')
    assert.equal(p.summary.proposedNumberChanges, 1)
  })

  it('never proposes a write for a conflicting identity, even where the field is NULL', () => {
    const wrong = p.rows.find((r) => r.studentNumber === '900003')!
    assert.ok(wrong.reasons.some((r) => r.includes('names materially conflict')))
    assert.equal(p.safeChanges.some((c) => c.studentNumber === '900003'), false)
  })

  it('holds a contact given for two student numbers', () => {
    const shared = plan(
      [
        ['900001', 'Ada Fixture', 'family@example.test', null, 'June 2026', null],
        ['900003', 'Cal Fixture', 'family@example.test', null, 'June 2026', null],
      ],
      [live(1, 'ADA FIXTURE'), live(3, 'CAL FIXTURE')],
    )
    assert.deepEqual(shared.rows.filter((r) => r.side === 'incoming').map((r) => r.classification), ['CONFLICT_REVIEW', 'CONFLICT_REVIEW'])
    assert.equal(shared.safeChanges.length, 0)
  })

  it('hashes deterministically; any source or hosted change voids the hash', () => {
    const rows = [['900001', 'Ada Fixture', 'ada@example.test', null, 'June 2026', null]]
    const a = plan(rows, [live(1, 'ADA FIXTURE')])
    assert.equal(syncPlanHash(a), syncPlanHash(plan(rows, [live(1, 'ADA FIXTURE')])))
    assert.notEqual(syncPlanHash(a), syncPlanHash(plan(rows, [live(1, 'ADA FIXTURE', { phone: '+14165550199' })])))
  })

  it('renders a CSV preview with every review column and a value-free summary', () => {
    const csv = renderPreviewCsv(p.rows)
    assert.ok(csv.startsWith('Student Number,Current Name,Incoming Name,Current Email,Incoming Email,Current Phone,Incoming Phone,Current Batch,Incoming Batch,Classification,Reason'))
    assert.equal(csv.trimEnd().split('\r\n').length, p.rows.length + 1)
    const summary = renderSummary(p, 'h'.repeat(64))
    assert.ok(summary.includes('| SAFE_UPDATE | 2 |'))
    assert.ok(summary.includes('| studentNumber |'))
    assert.ok(csv.includes('name: IDENTITY_REVIEW_REQUIRED; email: SAFE_CONTACT_UPDATE'))
    assert.ok(summary.includes('| finance rows that would change | 0 |'))
    assert.equal(summary.includes('example.test'), false)
  })
})

describe('apply gates', () => {
  it('the student sync refuses --apply in this ticket', () => {
    assert.match(syncApplyRefusal(parseSyncArguments(['--apply', `--plan-hash=${'a'.repeat(64)}`])) ?? '', /dry-run only/)
    assert.equal(syncApplyRefusal(parseSyncArguments(['--source=x.csv'])), null)
    assert.match(syncApplyRefusal(parseSyncArguments(['--bogus'])) ?? '', /unknown/)
  })

  it('the superseded 05B contact apply is refused whatever hash is given', () => {
    assert.match(supersededRefusal('apply') ?? '', /superseded/)
    assert.equal(supersededRefusal('dry-run'), null)
  })
})
