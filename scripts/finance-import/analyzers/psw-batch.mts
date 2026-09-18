/**
 * PSW batch sheets — one table per batch, two sections per table.
 *
 * The central question these sheets raise is which columns hold money that
 * arrived and which hold money that was merely scheduled. The same month name
 * appears on both sides of the table, so position alone cannot answer it.
 *
 * The answer is taken from the sheet's own arithmetic. "Total Paid" is a SUM
 * over a contiguous range; the columns inside that range are the ones the
 * workbook itself counts as received, and that range is reported per block —
 * including the rows where it disagrees with its neighbours, which happens.
 *
 * Nothing here recalculates a total, fills a blank month, or treats a blank
 * month cell as a zero payment.
 */

import { columnLetter, isBlank, numericValue, rawText, readCell } from '../lib/excel-values.mts'
import { formulaShape, parseSimpleSumRange, referencedColumns, tallyShapes } from '../lib/formulas.mts'
import { monthNumberFromHeader, roleForHeader } from '../lib/headers.mts'
import { profileColumn } from '../lib/profile.mts'
import { studentIdStorage, studentIdText } from '../lib/student-ids.mts'

import type { SheetBlock } from '../lib/blocks.mts'
import type { ColumnProfile } from '../lib/profile.mts'
import type { ColumnRole } from '../lib/headers.mts'
import type { WorkSheet } from 'xlsx'

/**
 * What a column contributes to an import.
 *
 * `actual_fee` and `actual_payment` are deliberately separate: one is the fee
 * agreed with the student, the other is money received. `scheduled_installment`
 * is neither — it is a plan.
 */
export type MappingTarget =
  | 'student_identity'
  | 'actual_fee'
  | 'actual_payment'
  | 'scheduled_installment'
  | 'derived_total'
  | 'derived_balance'
  | 'status_or_remarks'
  | 'unknown'

export interface ColumnMapping {
  letter: string
  column: number
  /** Heading exactly as stored. Null for a column with data but no heading. */
  header: string | null
  role: ColumnRole
  section: 'identity' | 'actual' | 'installment' | 'outside'
  target: MappingTarget
  /** Month the heading names, when it names one. */
  month: number | null
  /** Why this column got this target. */
  evidence: string
  /** True when the column is inside the range "Total Paid" sums. */
  insideTotalPaidSum: boolean
  nonBlankCount: number
  formulaCount: number
  errorCount: number
}

export interface ErrorCell {
  ref: string
  row: number
  column: string
  error: string
  formula: string | null
}

export interface BatchBlockAnalysis {
  sheetName: string
  /** Title exactly as stored. Never rewritten. */
  title: string | null
  titleRow: number | null
  headerRow: number | null
  /** Headings borrowed from an earlier block on the same sheet. */
  inheritedHeaders: { letter: string; original: string; fromRow: number }[]
  firstDataRow: number | null
  lastDataRow: number | null

  probableBatchDate: { iso: string | null; confidence: 'high' | 'low' | 'none'; note: string }

  actualSection: { firstLetter: string; lastLetter: string; evidence: string } | null
  installmentSection: { firstLetter: string; lastLetter: string; evidence: string } | null

  /**
   * The SUM range behind Total Paid, measured over student rows only.
   *
   * Most tables end with a totals line that has no student on it and whose
   * Total Paid cell sums down the column rather than across the row. Mixing
   * that row in would make every table look inconsistent for the wrong reason,
   * so it is counted separately.
   */
  totalPaidEvidence: {
    column: string | null
    rangesSeen: { range: string; rows: number }[]
    /** True when every student row sums the same span. */
    consistent: boolean
    /** Formula shapes found on rows that carry no student. */
    nonStudentRowFormulas: string[]
    note: string
  }

  columns: ColumnMapping[]
  unnamedColumnsWithData: { letter: string; nonBlankCount: number; formulaShapes: string[] }[]

  rowCount: number
  rowsWithStudentId: number
  rowsMissingStudentId: number
  rowsMissingName: number
  /** Rows carrying money but no identity at all — a totals line, most likely. */
  rowsWithoutIdentityButWithNumbers: number
  /** Rows in the data span that name no student. */
  nonStudentRowCount: number
  studentIdStorageCounts: Record<string, number>

  formulaCount: number
  errorCells: ErrorCell[]
  columnProfiles: ColumnProfile[]
}

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
]

/**
 * Reads a date out of a block title such as "PSW Morning Batch - 12th May 2025".
 *
 * Reports low confidence rather than a correction when the title is odd — the
 * workbook contains "January 026" and a sheet named "Aug 2026" whose title
 * says July. Neither is altered here.
 */
export function probableBatchDateFromTitle(title: string | null): {
  iso: string | null
  confidence: 'high' | 'low' | 'none'
  note: string
} {
  if (title === null) return { iso: null, confidence: 'none', note: 'no title' }

  const lower = title.toLowerCase()
  const monthIndex = MONTH_NAMES.findIndex((month) => lower.includes(month.slice(0, 3)))
  if (monthIndex === -1) return { iso: null, confidence: 'none', note: 'no month name in title' }

  const yearMatch = /\b(\d{2,4})\s*$/.exec(title.trim()) ?? /\b(20\d{2})\b/.exec(title)
  if (!yearMatch) {
    return { iso: null, confidence: 'none', note: 'month named but no year found in title' }
  }

  const rawYear = yearMatch[1]
  const dayMatch = /\b(\d{1,2})\s*(?:st|nd|rd|th)?\s+[A-Za-z]/.exec(title)

  if (rawYear.length !== 4) {
    return {
      iso: null,
      confidence: 'low',
      note: `year in title is ${JSON.stringify(rawYear)}, not four digits; left uninterpreted`,
    }
  }

  const year = Number(rawYear)
  const day = dayMatch ? Number(dayMatch[1]) : 1
  const iso = `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`

  return {
    iso,
    confidence: dayMatch ? 'high' : 'low',
    note: dayMatch ? 'day, month and year read from the title' : 'no day in title; first of month assumed',
  }
}

export function analyzeBatchBlock(
  sheetName: string,
  sheet: WorkSheet,
  block: SheetBlock,
  date1904: boolean,
): BatchBlockAnalysis {
  const rows: number[] = []
  for (let row = block.firstDataRow ?? 0; row <= (block.lastDataRow ?? -1); row += 1) rows.push(row)

  const headerByColumn = new Map(block.headers.map((header) => [header.column, header]))

  const actual = block.actualSection
  const installment = block.installmentSection

  // A row belongs to a student if it names one. The rest are the totals lines
  // most tables end with, and they are never treated as student rows.
  const idHeaderForRows = block.headers.find((header) => header.normalized === 'student id') ?? null
  const nameHeadersForRows = block.headers.filter((header) =>
    ['first_name', 'last_name', 'middle_name', 'student_name'].includes(
      roleForHeader(header.original),
    ),
  )

  const hasIdentity = (row: number): boolean => {
    if (idHeaderForRows && studentIdText(readCell(sheet, row - 1, idHeaderForRows.column)) !== null) {
      return true
    }
    return nameHeadersForRows.some((header) => !isBlank(readCell(sheet, row - 1, header.column)))
  }

  const studentRows = rows.filter((row) => hasIdentity(row))
  const nonStudentRows = rows.filter((row) => !hasIdentity(row))

  // --- What does Total Paid actually add up? ---------------------------------
  const totalPaidHeader = block.headers.find(
    (header) => roleForHeader(header.original) === 'total_paid',
  )

  const sumRanges = new Map<string, number>()
  let totalPaidSpan: { first: number; last: number } | null = null

  const nonStudentShapes = new Set<string>()

  if (totalPaidHeader) {
    for (const row of nonStudentRows) {
      const cell = readCell(sheet, row - 1, totalPaidHeader.column)
      if (cell?.formula) nonStudentShapes.add(formulaShape(cell.formula))
    }

    for (const row of studentRows) {
      const cell = readCell(sheet, row - 1, totalPaidHeader.column)
      if (!cell?.formula) continue
      const range = parseSimpleSumRange(cell.formula)
      const key = range ? `${range.firstLetter}:${range.lastLetter}` : formulaShape(cell.formula)
      sumRanges.set(key, (sumRanges.get(key) ?? 0) + 1)
      if (range) {
        totalPaidSpan = totalPaidSpan
          ? {
              first: Math.min(totalPaidSpan.first, range.firstColumn),
              last: Math.max(totalPaidSpan.last, range.lastColumn),
            }
          : { first: range.firstColumn, last: range.lastColumn }
      }
    }
  }

  const rangesSeen = [...sumRanges.entries()]
    .map(([range, count]) => ({ range, rows: count }))
    .sort((a, b) => b.rows - a.rows)

  const totalPaidEvidence = {
    column: totalPaidHeader ? totalPaidHeader.letter : null,
    rangesSeen,
    consistent: rangesSeen.length <= 1,
    nonStudentRowFormulas: [...nonStudentShapes],
    note: !totalPaidHeader
      ? 'no Total Paid heading in this block'
      : rangesSeen.length === 0
        ? 'Total Paid holds no formulas on the student rows of this block'
        : rangesSeen.length === 1
          ? `every student row sums ${rangesSeen[0].range}`
          : `the summed span differs between student rows: ${rangesSeen
              .map((entry) => `${entry.range} on ${entry.rows} row(s)`)
              .join('; ')}`,
  }

  // --- Column mapping --------------------------------------------------------
  const lastColumn = Math.max(
    installment?.lastColumn ?? 0,
    actual?.lastColumn ?? 0,
    ...block.headers.map((header) => header.column),
  )

  const columns: ColumnMapping[] = []
  const errorCells: ErrorCell[] = []
  let formulaCount = 0

  for (let column = 0; column <= lastColumn; column += 1) {
    const header = headerByColumn.get(column) ?? null
    const headerText = header?.original ?? null
    const role = headerText === null ? 'unknown' : roleForHeader(headerText)
    const month = headerText === null ? null : monthNumberFromHeader(headerText)

    let nonBlankCount = 0
    let columnFormulas = 0
    let columnErrors = 0
    const shapes: string[] = []

    for (const row of rows) {
      const cell = readCell(sheet, row - 1, column)
      if (!isBlank(cell)) nonBlankCount += 1
      if (cell?.formula) {
        columnFormulas += 1
        formulaCount += 1
        shapes.push(cell.formula)
      }
      if (cell?.isError) {
        columnErrors += 1
        errorCells.push({
          ref: cell.ref,
          row,
          column: columnLetter(column),
          error: rawText(cell) ?? '#UNKNOWN',
          formula: cell.formula ?? null,
        })
      }
    }

    if (nonBlankCount === 0 && header === null) continue

    const section: ColumnMapping['section'] =
      installment && column >= installment.firstColumn
        ? 'installment'
        : actual && column >= actual.firstColumn
          ? 'actual'
          : actual || installment
            ? 'identity'
            : 'outside'

    const insideTotalPaidSum =
      totalPaidSpan !== null && column >= totalPaidSpan.first && column <= totalPaidSpan.last

    const { target, evidence } = mapColumn({
      role,
      section,
      insideTotalPaidSum,
      header: headerText,
      month,
      formulas: shapes,
      totalPaidLetter: totalPaidEvidence.column,
    })

    columns.push({
      letter: columnLetter(column),
      column,
      header: headerText,
      role,
      section,
      target,
      month,
      evidence,
      insideTotalPaidSum,
      nonBlankCount,
      formulaCount: columnFormulas,
      errorCount: columnErrors,
    })
  }

  // --- Row-level counts ------------------------------------------------------
  const idHeader = idHeaderForRows
  const nameHeaders = nameHeadersForRows
  const moneyColumns = columns.filter(
    (candidate) => candidate.target === 'actual_payment' || candidate.target === 'actual_fee',
  )

  let rowsWithStudentId = 0
  let rowsMissingName = 0
  let rowsWithoutIdentityButWithNumbers = 0
  const idStorage: Record<string, number> = {}

  for (const row of rows) {
    const idCell = idHeader === null ? null : readCell(sheet, row - 1, idHeader.column)
    const id = studentIdText(idCell)
    if (id !== null) rowsWithStudentId += 1

    const storage = studentIdStorage(idCell)
    idStorage[storage] = (idStorage[storage] ?? 0) + 1

    const hasName = nameHeaders.some((header) => !isBlank(readCell(sheet, row - 1, header.column)))
    if (!hasName) rowsMissingName += 1

    if (id === null && !hasName) {
      const hasNumbers = moneyColumns.some(
        (candidate) => numericValue(readCell(sheet, row - 1, candidate.column)) !== null,
      )
      if (hasNumbers) rowsWithoutIdentityButWithNumbers += 1
    }
  }

  const unnamedColumnsWithData = columns
    .filter((candidate) => candidate.header === null && candidate.nonBlankCount > 0)
    .map((candidate) => {
      const formulas: string[] = []
      for (const row of rows) {
        const cell = readCell(sheet, row - 1, candidate.column)
        if (cell?.formula) formulas.push(cell.formula)
      }
      return {
        letter: candidate.letter,
        nonBlankCount: candidate.nonBlankCount,
        formulaShapes: tallyShapes(formulas).map((entry) => `${entry.shape} (${entry.count})`),
      }
    })

  return {
    sheetName,
    title: block.title,
    titleRow: block.titleRow,
    headerRow: block.headerRow,
    inheritedHeaders: block.inheritedHeaders.map((header) => ({
      letter: header.letter,
      original: header.original,
      fromRow: header.fromRow,
    })),
    firstDataRow: block.firstDataRow,
    lastDataRow: block.lastDataRow,
    probableBatchDate: probableBatchDateFromTitle(block.title),
    actualSection: actual
      ? { firstLetter: actual.firstLetter, lastLetter: actual.lastLetter, evidence: actual.evidence }
      : null,
    installmentSection: installment
      ? {
          firstLetter: installment.firstLetter,
          lastLetter: installment.lastLetter,
          evidence: installment.evidence,
        }
      : null,
    totalPaidEvidence,
    columns,
    unnamedColumnsWithData,
    rowCount: rows.length,
    rowsWithStudentId,
    rowsMissingStudentId: rows.length - rowsWithStudentId,
    rowsMissingName,
    rowsWithoutIdentityButWithNumbers,
    nonStudentRowCount: nonStudentRows.length,
    studentIdStorageCounts: idStorage,
    formulaCount,
    errorCells,
    columnProfiles: block.headers.map((header) =>
      profileColumn(sheet, header.column, rows, header.original, date1904),
    ),
  }
}

/**
 * Decides what a column would map to, and records why.
 *
 * The strongest evidence wins: membership of the Total Paid SUM range is a
 * statement by the sheet itself and outranks the heading's wording.
 */
function mapColumn(input: {
  role: ColumnRole
  section: ColumnMapping['section']
  insideTotalPaidSum: boolean
  header: string | null
  month: number | null
  formulas: string[]
  totalPaidLetter: string | null
}): { target: MappingTarget; evidence: string } {
  const { role, section, insideTotalPaidSum, header, formulas, totalPaidLetter } = input

  if (section === 'identity' || section === 'outside') {
    switch (role) {
      case 'serial_number':
        return { target: 'student_identity', evidence: 'row counter within the block' }
      case 'student_id':
      case 'first_name':
      case 'middle_name':
      case 'last_name':
      case 'student_name':
      case 'payer':
        return { target: 'student_identity', evidence: 'identity heading' }
      case 'graduated':
        return { target: 'status_or_remarks', evidence: 'outcome/status heading' }
      default:
        return header === null
          ? { target: 'unknown', evidence: 'no heading; left to review' }
          : { target: 'unknown', evidence: 'heading not recognised in the identity section' }
    }
  }

  if (section === 'installment') {
    switch (role) {
      case 'total_fee':
        return {
          target: 'scheduled_installment',
          evidence: 'total of the scheduled plan, inside the INSTALLMENT section',
        }
      case 'enrollment_fee':
        return {
          target: 'scheduled_installment',
          evidence: 'scheduled enrolment instalment, inside the INSTALLMENT section',
        }
      case 'month':
        return {
          target: 'scheduled_installment',
          evidence: 'month column inside the INSTALLMENT section: an amount due, not received',
        }
      default:
        if (formulas.length > 0) {
          return {
            target: 'derived_balance',
            evidence: `formula column reconciling the schedule (${tallyShapes(formulas)[0].shape})`,
          }
        }
        return { target: 'unknown', evidence: 'unrecognised column inside the INSTALLMENT section' }
    }
  }

  // section === 'actual'
  switch (role) {
    case 'total_fee':
      return {
        target: 'actual_fee',
        evidence: 'the fee agreed with the student, not a payment',
      }
    case 'enrollment_fee':
      return insideTotalPaidSum
        ? {
            target: 'actual_payment',
            evidence: `inside the range ${totalPaidLetter ?? 'Total Paid'} sums, so the sheet counts it as money received`,
          }
        : { target: 'unknown', evidence: 'enrolment fee outside the Total Paid sum; needs review' }
    case 'month':
      return insideTotalPaidSum
        ? {
            target: 'actual_payment',
            evidence: `month column inside the range ${totalPaidLetter ?? 'Total Paid'} sums: money received`,
          }
        : {
            target: 'unknown',
            evidence: 'month column in the actual section but outside the Total Paid sum; needs review',
          }
    case 'late_fees':
      return insideTotalPaidSum
        ? { target: 'actual_payment', evidence: 'late fee inside the Total Paid sum: money received' }
        : { target: 'unknown', evidence: 'late fee outside the Total Paid sum; needs review' }
    case 'total_paid':
      return { target: 'derived_total', evidence: 'SUM of the actual payment columns' }
    case 'outstanding':
    case 'balance':
      return { target: 'derived_balance', evidence: 'Total Paid minus Total Fee' }
    case 'remarks':
    case 'graduated':
      return { target: 'status_or_remarks', evidence: 'free text or status' }
    case 'discount':
      return {
        target: 'derived_balance',
        evidence: formulas.length > 0 ? `formula column (${tallyShapes(formulas)[0].shape})` : 'discount column',
      }
    default:
      if (header === null && formulas.length > 0) {
        const shape = tallyShapes(formulas)[0].shape
        const references = referencedColumns(formulas[0])
        return {
          target: 'derived_balance',
          evidence: `unnamed formula column ${shape}, referencing ${references.join(', ')}`,
        }
      }
      return header === null
        ? { target: 'unknown', evidence: 'no heading; left to review' }
        : { target: 'unknown', evidence: 'heading not recognised in the ACTUAL section' }
  }
}
