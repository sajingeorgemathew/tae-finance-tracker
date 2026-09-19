/**
 * Synthetic worksheets for the importer tests.
 *
 * The real workbook holds real students' finances and is Git-ignored, so the
 * mapping rules are tested against sheets built here instead. They are built to
 * the same *shape* the real sheets have — a titled batch table split into an
 * ACTUAL and an INSTALLMENT section, a totals line with no student on it, a
 * flat transaction list — so the tests exercise the real block detection and
 * column resolution rather than a simplified stand-in.
 *
 * Not a test file: the `*.test.mts` glob does not pick it up.
 */

import * as XLSX from 'xlsx'

import type { WorkSheet } from 'xlsx'

/** A blank cell. Distinct from a cell holding 0, which is a value. */
export const BLANK = null

/** A cell holding a formula, and the value Excel last calculated for it. */
export interface FormulaCell {
  f: string
  v: number
}

/** A cell holding a spreadsheet error, e.g. `#REF!`. */
export interface ErrorCell {
  error: string
  f?: string
}

export type CellInput = string | number | boolean | FormulaCell | ErrorCell | null

/** SheetJS error codes, keyed by the text Excel displays. */
const ERROR_CODES: Record<string, number> = {
  '#NULL!': 0x00,
  '#DIV/0!': 0x07,
  '#VALUE!': 0x0f,
  '#REF!': 0x17,
  '#NAME?': 0x1d,
  '#NUM!': 0x24,
  '#N/A': 0x2a,
}

function isFormula(value: CellInput): value is FormulaCell {
  return typeof value === 'object' && value !== null && 'f' in value && 'v' in value
}

function isError(value: CellInput): value is ErrorCell {
  return typeof value === 'object' && value !== null && 'error' in value
}

/**
 * Builds a worksheet from rows of cell inputs.
 *
 * The declared `!ref` spans the full grid including trailing blanks, matching
 * how Excel writes a sheet whose used range is wider than its data.
 */
export function sheetFromRows(rows: readonly (readonly CellInput[])[]): WorkSheet {
  const sheet: WorkSheet = {}

  const lastRow = Math.max(rows.length - 1, 0)
  const lastColumn = Math.max(...rows.map((row) => row.length), 1) - 1

  rows.forEach((row, r) => {
    row.forEach((value, c) => {
      if (value === null || value === undefined) return
      const ref = XLSX.utils.encode_cell({ r, c })

      if (isError(value)) {
        sheet[ref] = {
          t: 'e',
          v: ERROR_CODES[value.error] ?? 0x17,
          w: value.error,
          ...(value.f === undefined ? {} : { f: value.f }),
        }
        return
      }

      if (isFormula(value)) {
        sheet[ref] = { t: 'n', v: value.v, f: value.f, w: String(value.v) }
        return
      }

      if (typeof value === 'number') {
        sheet[ref] = { t: 'n', v: value, w: String(value) }
        return
      }

      if (typeof value === 'boolean') {
        sheet[ref] = { t: 'b', v: value }
        return
      }

      sheet[ref] = { t: 's', v: value }
    })
  })

  sheet['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: lastRow, c: lastColumn },
  })

  return sheet
}

/** The full range of a fixture sheet, for passing to `findBlocks`. */
export function rangeOf(sheet: WorkSheet): XLSX.Range {
  return XLSX.utils.decode_range(sheet['!ref'] as string)
}

/**
 * A PSW-shaped batch sheet: a titled table split into an ACTUAL and an
 * INSTALLMENT section by a repeated "Total Fee" heading, ending in a totals
 * line that carries money but no student.
 *
 * Columns:
 *   A Sr. No.  B Student ID  C First Name  D Last Name
 *   E Total Fee  F Enroll. Fee  G May  H June  I Total Paid  J (unheaded balance)
 *   K Total Fee  L Enroll. Fee  M May  N June
 *
 * `I` sums `F:H`, which is what establishes the ACTUAL columns as money
 * received, and `J` is the unheaded `Total Paid − Total Fee` column the real
 * sheets carry.
 */
export function pswBatchSheet(
  title = 'PSW Morning Batch - 12th May 2025',
): WorkSheet {
  return sheetFromRows([
    [title],
    [
      'Sr. No. ',
      'Student ID ',
      'First Name ',
      'Last Name ',
      'Total Fee',
      'Enroll. Fee',
      'May',
      'June',
      'Total Paid',
      BLANK,
      'Total Fee',
      'Enroll. Fee',
      'May',
      'June',
    ],
    // A student who paid an enrolment fee and one month, with June still blank
    // on both sides. The blank June cells must create nothing.
    [
      1,
      125001,
      'Asha',
      'Rao',
      5000,
      500,
      1000,
      BLANK,
      { f: 'SUM(F3:H3)', v: 1500 },
      { f: 'I3-E3', v: -3500 },
      5000,
      500,
      1000,
      BLANK,
    ],
    // A student whose scheduled June instalment is explicitly zero. Zero is a
    // value and must survive as 0, not be confused with the blank above.
    [
      2,
      125002,
      'Bina',
      'Shah',
      4000,
      400,
      800,
      200,
      { f: 'SUM(F4:H4)', v: 1400 },
      { f: 'I4-E4', v: -2600 },
      4000,
      400,
      800,
      0,
    ],
    // The totals line: money, no student. Its Total Paid sums DOWN the column.
    [
      BLANK,
      BLANK,
      BLANK,
      BLANK,
      9000,
      900,
      1800,
      200,
      { f: 'SUM(I3:I4)', v: 2900 },
      BLANK,
      9000,
      900,
      1800,
      0,
    ],
  ])
}

/**
 * A Tracker Master-shaped transaction list.
 *
 * Headings carry the real workbook's trailing space on "Student ID ", and
 * `Balance Fees` is a formula on every row, as it is in the real file.
 */
export function trackerMasterSheet(
  rows: readonly (readonly CellInput[])[],
): WorkSheet {
  return sheetFromRows([
    [
      'Payment No',
      'Batch',
      'Student ID ',
      'Student Name',
      'Amount Paid',
      'Paid Date',
      'Mode of Payment',
      'Receipt Sent',
      'Enrollment Total Fees',
      'Program',
      'REMARKS',
      'VIKAS REMARKS',
      'Balance Fees',
    ],
    ...rows,
  ])
}

/** One Tracker Master transaction row, in column order. */
export function trackerRow(options: {
  paymentNo?: CellInput
  batch?: CellInput
  studentId?: CellInput
  studentName?: CellInput
  amount?: CellInput
  paidDate?: CellInput
  method?: CellInput
  receiptSent?: CellInput
  totalFee?: CellInput
  program?: CellInput
  remarks?: CellInput
  vikasRemarks?: CellInput
  balance?: CellInput
}): CellInput[] {
  return [
    options.paymentNo ?? 1,
    options.batch ?? BLANK,
    options.studentId ?? BLANK,
    options.studentName ?? BLANK,
    options.amount ?? BLANK,
    options.paidDate ?? BLANK,
    options.method ?? BLANK,
    options.receiptSent ?? BLANK,
    options.totalFee ?? BLANK,
    options.program ?? BLANK,
    options.remarks ?? BLANK,
    options.vikasRemarks ?? BLANK,
    options.balance ?? BLANK,
  ]
}
