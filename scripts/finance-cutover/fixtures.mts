/**
 * Hand-built workbooks for the cutover tests.
 *
 * The real replacement workbook holds real names and balances and cannot be
 * committed, so these mirror its *shapes* with invented values: PSW sheets
 * with a Morning and an Evening table and an INSTALLMENT FEE STRUCTURE banner,
 * an unheaded balance formula, placeholder seats, a `#REF!` serial row, a
 * totals row, notes typed under the totals line; a flat ELCE roster with a
 * date-of-birth column, a number typed into a name column and a note typed
 * past the last heading; and a French roster with no student numbers.
 */

import * as XLSX from 'xlsx'

import { BLANK, sheetFromRows, type CellInput } from '../finance-import/importer/fixtures.mts'

import type { WorkBook, WorkSheet } from 'xlsx'

export interface PswFixtureStudent {
  number: string | null
  first: string | null
  last: string | null
  fee: number | null
  /** Enroll, May, June, Late — the ACTUAL money cells; null = blank. */
  paid: [number | null, number | null, number | null, number | null]
  /** Enroll, September, October; null = no schedule on this row. */
  schedule: [number, number, number] | null
}

const PSW_HEADER: CellInput[] = [
  'Sr. No. ', 'Student ID ', 'First Name', 'Last Name ', 'Payer', ' Total Fee  ', 'Enroll. Fee', 'May', 'June', 'Late Fees', 'Total Paid', BLANK, BLANK,
  'Total Fee ', 'Enroll. Fee', 'September', 'October',
]

/** Rows of one PSW table, starting at Excel row `startRow` (the title row). */
export function pswTableRows(
  startRow: number,
  title: string,
  students: readonly PswFixtureStudent[],
  extra: { placeholderFees?: number[]; refRow?: boolean; notesBelow?: string[] } = {},
): CellInput[][] {
  const rows: CellInput[][] = []
  const titleRow: CellInput[] = [title]
  titleRow[13] = 'INSTALLMENT FEE STRUCTURE'
  rows.push(titleRow, PSW_HEADER)
  let excel = startRow + 2
  const first = excel
  students.forEach((student, index) => {
    const paid = student.paid.reduce<number>((total, value) => total + (value ?? 0), 0)
    const row: CellInput[] = [
      index + 1,
      student.number,
      student.first,
      student.last,
      BLANK,
      student.fee,
      ...student.paid,
      { f: `SUM(G${excel}:J${excel})`, v: paid },
      { f: `K${excel}-F${excel}`, v: paid - (student.fee ?? 0) },
      BLANK,
    ]
    if (student.schedule !== null) {
      const [enroll, september, october] = student.schedule
      row.push(enroll + september + october, enroll, september, october, { f: `SUM(O${excel}:Q${excel})-N${excel}`, v: 0 })
    }
    rows.push(row)
    excel += 1
  })
  for (const fee of extra.placeholderFees ?? []) {
    rows.push([students.length + rows.length - 1, BLANK, BLANK, BLANK, BLANK, fee, BLANK, BLANK, BLANK, BLANK, { f: `SUM(G${excel}:J${excel})`, v: 0 }, { f: `K${excel}-F${excel}`, v: -fee }])
    excel += 1
  }
  if (extra.refRow) {
    rows.push([{ error: '#REF!', f: '#REF!+1' }, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, { f: `SUM(G${excel}:J${excel})`, v: 0 }])
    excel += 1
  }
  const last = excel - 1
  const totals: CellInput[] = [BLANK, BLANK, BLANK, BLANK, BLANK]
  for (const letter of ['F', 'G', 'H', 'I', 'J']) totals.push({ f: `SUM(${letter}${first}:${letter}${last})`, v: 0 })
  totals.push({ f: `SUM(G${excel}:J${excel})`, v: 0 })
  rows.push(totals)
  for (const note of extra.notesBelow ?? []) rows.push([BLANK, BLANK, note])
  return rows
}

/** A PSW sheet with a Morning table and an Evening table. */
export function pswSheet(dateLabel: string, morning: readonly PswFixtureStudent[], evening: readonly PswFixtureStudent[], extra: Parameters<typeof pswTableRows>[3] = {}): WorkSheet {
  const top = pswTableRows(1, `PSW Morning Batch - ${dateLabel}`, morning, extra)
  const gap: CellInput[][] = [[], []]
  const bottom = pswTableRows(top.length + gap.length + 1, `PSW Evening Batch - ${dateLabel}`, evening)
  return sheetFromRows([...top, ...gap, ...bottom])
}

export function student(number: string | null, first: string | null, last: string | null, overrides: Partial<PswFixtureStudent> = {}): PswFixtureStudent {
  return { number, first, last, fee: 5365, paid: [865, 900, BLANK, BLANK], schedule: [865, 900, 900], ...overrides }
}

const ROSTER_HEADER: CellInput[] = [
  'Sr. No. ', 'Student ID ', 'First Name ', 'Middle Name', 'Last Name ', 'Start Date', 'YYYY/MM/DD', 'Payee', 'WKD/WKND', 'Total fees', 'Enrollment fees',
  '1st Installment', '2nd Installment', 'Late fees', ' Total Paid ', 'Balance',
]

/** The flat ELCE roster: a heading row, students, an empty serial row and a totals row. */
export function eceaSheet(): WorkSheet {
  return sheetFromRows([
    ['Early Learning and Childhood Education ', BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, '(ELCE) Batch - Fixture'],
    [],
    ROSTER_HEADER,
    [1, '99901', 'Ama', BLANK, 'Fixture', BLANK, '1/1/90', BLANK, BLANK, 1953.77, 823.77, 1130, BLANK, BLANK, { f: 'SUM(K4:N4)', v: 1953.77 }],
    [2, '99902', 'Bea', BLANK, 'Fixture', BLANK, '2/2/91', BLANK, BLANK, 1953.77, 823.77, BLANK, BLANK, BLANK, BLANK, BLANK, '111.87 - vaccination'],
    [3, BLANK, 'Cara', BLANK, 200, 650],
    [4],
    [BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, { f: 'SUM(J4:J7)', v: 3907.54 }, { f: 'SUM(K4:K7)', v: 1647.54 }, { f: 'SUM(L4:L7)', v: 1130 }, BLANK, BLANK, { f: 'SUM(K8:N8)', v: 2777.54 }],
  ])
}

const FRENCH_HEADER: CellInput[] = [...ROSTER_HEADER.slice(0, 13), 'sept', 'oct', ' Total Paid ', 'Balance']

export function frenchSheet(): WorkSheet {
  return sheetFromRows([
    ['FRENCH- 2026'],
    [],
    FRENCH_HEADER,
    [1, BLANK, 'Dana ', BLANK, 'Fixture', BLANK, BLANK, BLANK, BLANK, BLANK, 125, 250, 125, 125, 125],
    [2, BLANK, 'Eli', BLANK, 'Fixture', BLANK, BLANK, BLANK, BLANK, BLANK, 450, BLANK, BLANK, 450],
    [{ f: 'A5+1', v: 3 }],
    [BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, BLANK, { f: 'SUM(J4:J6)', v: 0 }, { f: 'SUM(K4:K6)', v: 575 }, { f: 'SUM(L4:L6)', v: 250 }, { f: 'SUM(M4:M6)', v: 125 }, { f: 'SUM(N4:N6)', v: 575 }, BLANK, { f: 'SUM(K7:N7)', v: 1525 }],
  ])
}

export function workbookFromSheets(sheets: Record<string, WorkSheet>): WorkBook {
  const workbook = XLSX.utils.book_new()
  for (const [name, sheet] of Object.entries(sheets)) XLSX.utils.book_append_sheet(workbook, sheet, name)
  return workbook
}

/** The full launch-scope fixture: four PSW intakes, ELCE, French, and one out-of-scope sheet. */
export function cutoverWorkbook(): WorkBook {
  return workbookFromSheets({
    '27 April 26': pswSheet(
      '27th April 2026',
      [student('999901', 'Asha', 'Fixture'), student('999902', 'Bo', 'Fixture', { paid: [865, 900, 900, 100] })],
      [student('999903', 'Cy', 'Fixture', { schedule: null })],
    ),
    '1st June 2026': pswSheet('1st June, 2026', [student('999904', 'Di', 'Fixture')], [student(null, 'Ed', 'Fixture')], { placeholderFees: [5365] }),
    'Aug 2026': pswSheet('29th JULY, 2026', [student('999905', 'Fa', 'Fixture')], [student('999901', 'Asha', 'Fixture')], { refRow: true }),
    '28 Sept 26': pswSheet('28th Sept, 2026', [student('999906', 'Gi', 'Fixture', { paid: [865, BLANK, BLANK, BLANK] })], [student('999907', 'Hu', 'Fixture')], { notesBelow: ['Referral note'] }),
    'ELCE 25 & 26': eceaSheet(),
    French: frenchSheet(),
    '17th March 2025': pswSheet('17th March 2025', [student('999900', 'Old', 'Fixture')], [student('999899', 'Older', 'Fixture')]),
  })
}
