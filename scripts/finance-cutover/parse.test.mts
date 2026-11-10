import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { cutoverWorkbook, workbookFromSheets, pswSheet, student } from './fixtures.mts'
import { cohortMonthOf, namedRows, parseCutoverWorkbook, recognizeCutoverWorkbook, studentRows, type ParsedTable } from './parse.mts'

/**
 * FINANCE-CUTOVER-05A — reading the replacement workbook.
 *
 * Recognition is structural, cohorts are chosen by program and month (never
 * by sheet name), and every row of every table lands in exactly one class.
 */

const parsed = parseCutoverWorkbook(cutoverWorkbook())
const tablesOf = (cohortId: string): ParsedTable[] => parsed.tables.filter((table) => table.cohort?.id === cohortId)
const classesOf = (table: ParsedTable): string[] => table.rows.map((row) => `${row.row}:${row.rowClass}`)

describe('workbook recognition', () => {
  it('recognises cohort sheets with no Tracker Master', () => {
    assert.equal(recognizeCutoverWorkbook(cutoverWorkbook()).recognized, true)
  })

  it('refuses the superseded historical workbook (it carries Tracker Master)', () => {
    const workbook = workbookFromSheets({ 'Tracker Master': pswSheet('1st June, 2026', [student('1', 'A', 'B')], []), '1st June 2026': pswSheet('1st June, 2026', [student('2', 'A', 'B')], []) })
    const result = recognizeCutoverWorkbook(workbook)
    assert.equal(result.recognized, false)
    assert.match(result.reason, /Tracker Master/)
  })

  it('refuses a workbook with no PSW batch sheet', () => {
    const workbook = workbookFromSheets({ Notes: pswSheet('x', [], []) })
    delete workbook.Sheets.Notes['!ref']
    assert.equal(recognizeCutoverWorkbook(workbook).recognized, false)
  })
})

describe('target cohort filtering', () => {
  it('maps every launch table to its cohort and leaves the 2025 sheet out of scope', () => {
    assert.deepEqual(
      [...new Set(parsed.tables.map((table) => table.cohort?.id))].sort(),
      ['ECEA-CURRENT', 'FRENCH-CURRENT', 'PSW-2026-04', 'PSW-2026-06', 'PSW-2026-08', 'PSW-2026-09'],
    )
    assert.deepEqual(parsed.outOfScopeTables.map((table) => table.yearMonth), ['2025-03', '2025-03'])
    assert.deepEqual(parsed.unrecognizedSheets, [])
  })

  it('reads the month from the sheet name before the title (Aug 2026 holds the 29th July tables)', () => {
    assert.deepEqual(cohortMonthOf('Aug 2026', 'PSW Morning Batch - 29th JULY, 2026'), { yearMonth: '2026-08', evidence: 'sheet name "Aug 2026"' })
    assert.equal(cohortMonthOf('27 April 26', 'PSW Morning Batch - 27th April 2026').yearMonth, '2026-04')
    assert.equal(cohortMonthOf('28 Sept 26', 'PSW evening Batch - 28th Sept, 2026').yearMonth, '2026-09')
    assert.equal(tablesOf('PSW-2026-08')[0].startDate, '2026-07-29', 'the start date is still the title\'s own date')
  })

  it('reads an abbreviated "Sept" title date instead of leaving September undated', () => {
    assert.equal(tablesOf('PSW-2026-09')[0].startDate, '2026-09-28')
  })
})

describe('PSW tables: April, June, August, September', () => {
  it('splits every PSW sheet into a Morning and an Evening table', () => {
    for (const cohort of ['PSW-2026-04', 'PSW-2026-06', 'PSW-2026-08', 'PSW-2026-09']) {
      assert.deepEqual(tablesOf(cohort).map((table) => table.table.session), ['Morning', 'Evening'], cohort)
      assert.ok(tablesOf(cohort).every((table) => table.table.hasInstallmentSection), cohort)
    }
  })

  it('classifies students and the totals row (April)', () => {
    assert.deepEqual(classesOf(tablesOf('PSW-2026-04')[0]), ['3:student', '4:student', '5:totals'])
  })

  it('tells a placeholder seat (a template fee, nobody named) from the totals row (June)', () => {
    assert.deepEqual(classesOf(tablesOf('PSW-2026-06')[0]), ['3:student', '4:placeholder_seat', '5:totals'])
  })

  it('keeps a number-less named row as a student (June Evening)', () => {
    const [row] = studentRows(tablesOf('PSW-2026-06')[1])
    assert.equal(row.studentNumber, null)
    assert.equal(row.named, true)
  })

  it('treats a #REF! serial row with only formula results as an empty seat, never a student (August)', () => {
    assert.deepEqual(classesOf(tablesOf('PSW-2026-08')[0]), ['3:student', '4:empty_seat', '5:totals'])
  })

  it('does not adopt text typed under the totals row as a student (September)', () => {
    assert.deepEqual(classesOf(tablesOf('PSW-2026-09')[0]), ['3:student', '4:totals', '5:below_table'])
    assert.equal(studentRows(tablesOf('PSW-2026-09')[0]).length, 1)
  })

  it('keeps the student number as text, exactly as written', () => {
    assert.equal(studentRows(tablesOf('PSW-2026-04')[0])[0].studentNumber, '999901')
  })
})

describe('ECEA roster', () => {
  const [ecea] = tablesOf('ECEA-CURRENT')

  it('is a flat table with no schedule section', () => {
    assert.equal(ecea.table.hasInstallmentSection, false)
    assert.deepEqual(classesOf(ecea), ['4:student', '5:student', '6:student', '7:empty_seat', '8:totals'])
  })

  it('redacts the date-of-birth column by its heading', () => {
    assert.deepEqual(ecea.redactedColumns, [{ letter: 'G', header: 'YYYY/MM/DD' }])
  })

  it('never stores a number typed into a name column as a name', () => {
    const row = ecea.rows.find((candidate) => candidate.row === 6)
    assert.ok(row)
    assert.equal(row.lastName, null)
    assert.equal(row.firstName, 'Cara')
    assert.deepEqual(row.misplaced.map((value) => [value.letter, value.value]), [['E', 200], ['F', 650]])
  })

  it('captures a note typed past the last heading', () => {
    const row = ecea.rows.find((candidate) => candidate.row === 5)
    assert.deepEqual(row?.offTableCells.map((cell) => [cell.letter, cell.rawValue]), [['Q', '111.87 - vaccination']])
  })
})

describe('French roster', () => {
  const [french] = tablesOf('FRENCH-CURRENT')

  it('is its own program and keeps both named rows without numbers', () => {
    assert.equal(french.programShortCode, 'FRENCH')
    assert.equal(namedRows(french).length, 2)
    assert.ok(namedRows(french).every((row) => row.studentNumber === null))
  })

  it('does not read a serial-number formula as a typed figure', () => {
    assert.equal(french.rows.find((row) => row.row === 6)?.rowClass, 'empty_seat')
  })
})

describe('row conservation', () => {
  it('accounts for every row of every table exactly once', () => {
    for (const table of parsed.tables) {
      const span = (table.table.lastDataRow ?? 0) - (table.table.firstDataRow ?? 0) + 1
      assert.equal(table.rows.length, span, `${table.sheetName} ${table.table.key}`)
    }
  })

  it('counts named rows per cohort', () => {
    const named = Object.fromEntries(
      ['PSW-2026-04', 'PSW-2026-06', 'PSW-2026-08', 'PSW-2026-09', 'ECEA-CURRENT', 'FRENCH-CURRENT'].map((cohort) => [cohort, tablesOf(cohort).reduce((total, table) => total + namedRows(table).length, 0)]),
    )
    assert.deepEqual(named, { 'PSW-2026-04': 3, 'PSW-2026-06': 2, 'PSW-2026-08': 2, 'PSW-2026-09': 2, 'ECEA-CURRENT': 3, 'FRENCH-CURRENT': 2 })
  })
})
