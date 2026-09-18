/**
 * ELCE and French — flat cohort sheets with a two-instalment plan.
 *
 * These sheets share a layout with each other and with nothing else in the
 * workbook: no ACTUAL/INSTALLMENT split, no month columns, a named 1st and 2nd
 * Installment instead. They are analysed on their own terms rather than being
 * folded into the PSW monthly model.
 *
 * Two things are reported and deliberately not resolved here:
 *
 *  * The sheet named "ELCE 25 & 26" and the program configured in the database
 *    as ECEA may or may not be the same program. Both names are left exactly as
 *    they are and the question is raised for a human.
 *  * The column headed "YYYY/MM/DD" holds serials that read as dates decades
 *    before any batch start. What they mean is not decided here.
 */

import { interpretDateCell, isBlank, numericValue, rawText, readCell } from '../lib/excel-values.mts'
import { roleForHeader } from '../lib/headers.mts'
import { profileColumn } from '../lib/profile.mts'
import { studentIdPrefix, studentIdText } from '../lib/student-ids.mts'

import type { SheetBlock } from '../lib/blocks.mts'
import type { ColumnProfile } from '../lib/profile.mts'
import type { ColumnRole } from '../lib/headers.mts'
import type { WorkSheet } from 'xlsx'

export interface RosterAnalysis {
  sheetName: string
  /** Title text above the table, exactly as stored. */
  titleText: string[]
  headerRow: number | null
  firstDataRow: number | null
  lastDataRow: number | null

  headers: { letter: string; original: string; role: ColumnRole }[]
  columnProfiles: ColumnProfile[]

  rowsInSpan: number
  /** Rows carrying a student number, a name, or any money. */
  meaningfulRowCount: number
  /** Rows with a serial number but nothing else at all. */
  skeletonRowCount: number

  rowsWithStudentId: number
  rowsWithAnyName: number
  rowsWithAnyMoney: number
  rowsWithTotalFees: number
  rowsWithEnrollmentFee: number
  rowsWithAnyInstallment: number
  rowsWithTotalPaid: number
  rowsWithBalance: number

  studentIdPrefixCounts: Record<string, number>

  /** How the "YYYY/MM/DD" column behaves, without deciding what it means. */
  dateColumnFindings: {
    letter: string | null
    header: string | null
    nonBlankCount: number
    interpretedISORange: [string, string] | null
    note: string
  }

  hasScheduleData: boolean
  hasPaymentData: boolean
}

export function analyzeRosterSheet(
  sheetName: string,
  sheet: WorkSheet,
  block: SheetBlock,
  date1904: boolean,
): RosterAnalysis {
  const rows: number[] = []
  for (let row = block.firstDataRow ?? 0; row <= (block.lastDataRow ?? -1); row += 1) rows.push(row)

  const byNormalized = (normalized: string) =>
    block.headers.find((header) => header.normalized === normalized) ?? null

  const idHeader = byNormalized('student id')
  const nameHeaders = block.headers.filter((header) =>
    ['first_name', 'middle_name', 'last_name'].includes(roleForHeader(header.original)),
  )
  const totalFees = byNormalized('total fees')
  const enrollmentFees = byNormalized('enrollment fees')
  const installmentHeaders = block.headers.filter(
    (header) => roleForHeader(header.original) === 'installment_ordinal',
  )
  const lateFees = byNormalized('late fees')
  const totalPaid = byNormalized('total paid')
  const balance = byNormalized('balance')
  const dateColumn = byNormalized('yyyy/mm/dd')
  const serialHeader = byNormalized('sr. no')

  const moneyHeaders = [totalFees, enrollmentFees, ...installmentHeaders, lateFees, totalPaid, balance].filter(
    (header): header is NonNullable<typeof header> => header !== null,
  )

  const has = (row: number, header: { column: number } | null) =>
    header !== null && !isBlank(readCell(sheet, row - 1, header.column))

  let meaningfulRowCount = 0
  let skeletonRowCount = 0
  let rowsWithStudentId = 0
  let rowsWithAnyName = 0
  let rowsWithAnyMoney = 0
  let rowsWithTotalFees = 0
  let rowsWithEnrollmentFee = 0
  let rowsWithAnyInstallment = 0
  let rowsWithTotalPaid = 0
  let rowsWithBalance = 0

  const prefixCounts: Record<string, number> = {}

  for (const row of rows) {
    const id = studentIdText(idHeader === null ? null : readCell(sheet, row - 1, idHeader.column))
    const hasName = nameHeaders.some((header) => has(row, header))
    const hasMoney = moneyHeaders.some(
      (header) => numericValue(readCell(sheet, row - 1, header.column)) !== null,
    )

    if (id !== null) {
      rowsWithStudentId += 1
      const prefix = studentIdPrefix(id) ?? '(no prefix)'
      prefixCounts[prefix] = (prefixCounts[prefix] ?? 0) + 1
    }
    if (hasName) rowsWithAnyName += 1
    if (hasMoney) rowsWithAnyMoney += 1
    if (has(row, totalFees)) rowsWithTotalFees += 1
    if (has(row, enrollmentFees)) rowsWithEnrollmentFee += 1
    if (installmentHeaders.some((header) => has(row, header))) rowsWithAnyInstallment += 1
    if (has(row, totalPaid)) rowsWithTotalPaid += 1
    if (has(row, balance)) rowsWithBalance += 1

    if (id !== null || hasName || hasMoney) meaningfulRowCount += 1
    else if (has(row, serialHeader)) skeletonRowCount += 1
  }

  const dateISOs = dateColumn === null
    ? []
    : rows
        .map((row) => interpretDateCell(readCell(sheet, row - 1, dateColumn.column), date1904).iso)
        .filter((iso): iso is string => iso !== null)
        .sort()

  const dateNonBlank = dateColumn === null
    ? 0
    : rows.filter((row) => !isBlank(readCell(sheet, row - 1, dateColumn.column))).length

  // Anything above the header row, kept verbatim for the record.
  const titleText: string[] = []
  for (let row = 1; row < (block.headerRow ?? 1); row += 1) {
    for (let column = 0; column <= 15; column += 1) {
      const text = rawText(readCell(sheet, row - 1, column))
      if (text !== null && text.trim() !== '') titleText.push(text)
    }
  }

  return {
    sheetName,
    titleText,
    headerRow: block.headerRow,
    firstDataRow: block.firstDataRow,
    lastDataRow: block.lastDataRow,
    headers: block.headers.map((header) => ({
      letter: header.letter,
      original: header.original,
      role: roleForHeader(header.original),
    })),
    columnProfiles: block.headers.map((header) =>
      profileColumn(sheet, header.column, rows, header.original, date1904),
    ),
    rowsInSpan: rows.length,
    meaningfulRowCount,
    skeletonRowCount,
    rowsWithStudentId,
    rowsWithAnyName,
    rowsWithAnyMoney,
    rowsWithTotalFees,
    rowsWithEnrollmentFee,
    rowsWithAnyInstallment,
    rowsWithTotalPaid,
    rowsWithBalance,
    studentIdPrefixCounts: prefixCounts,
    dateColumnFindings: {
      letter: dateColumn?.letter ?? null,
      header: dateColumn?.original ?? null,
      nonBlankCount: dateNonBlank,
      interpretedISORange: dateISOs.length === 0 ? null : [dateISOs[0], dateISOs[dateISOs.length - 1]],
      note:
        dateISOs.length === 0
          ? 'no interpretable values'
          : `serials read as ${dateISOs[0]} to ${dateISOs[dateISOs.length - 1]}; the heading gives a format, not a meaning`,
    },
    hasScheduleData: rowsWithAnyInstallment > 0 || rowsWithEnrollmentFee > 0,
    hasPaymentData: rowsWithTotalPaid > 0,
  }
}
