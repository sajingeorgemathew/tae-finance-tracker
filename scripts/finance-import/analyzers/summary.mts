/**
 * Summary — treated as derived until the evidence says otherwise.
 *
 * The question is narrow: does this sheet hold anything that cannot be
 * reconstructed from Tracker Master? If every student and every total on it
 * also appears there, it is a view of the data rather than a source of it, and
 * importing it would create a second, competing record of the same money.
 *
 * The comparison below is evidence for that decision, not the decision itself.
 */

import { isBlank, numericValue, rawText, readCell } from '../lib/excel-values.mts'
import { profileColumn } from '../lib/profile.mts'
import { studentIdText } from '../lib/student-ids.mts'

import type { SheetBlock } from '../lib/blocks.mts'
import type { ColumnProfile } from '../lib/profile.mts'
import type { WorkSheet } from 'xlsx'

export interface SummaryAnalysis {
  sheetName: string
  headerRow: number | null
  firstDataRow: number | null
  lastDataRow: number | null
  headers: { letter: string; original: string }[]
  columnProfiles: ColumnProfile[]

  rowsInSpan: number
  meaningfulRowCount: number
  distinctStudentIdCount: number

  /** A pivot cache holds values, not formulas. */
  formulaCount: number
  looksLikePivotOutput: boolean
  pivotEvidence: string[]

  /** Rows above the header, e.g. the stray "Values" label a pivot leaves behind. */
  preHeaderText: string[]

  comparisonWithTrackerMaster: {
    studentIdsOnlyInSummary: number
    studentIdsOnlyInTrackerMaster: number
    studentIdsInBoth: number
    /** Summary totals that differ from the same student's Tracker Master sum. */
    studentsWhereAmountPaidDiffers: number
    /** Largest absolute difference seen, for a sense of scale. */
    largestAmountDifference: number
    note: string
  }

  uniqueInformation: string[]
}

export function analyzeSummary(
  sheetName: string,
  sheet: WorkSheet,
  block: SheetBlock,
  date1904: boolean,
  trackerTotalsByStudentId: Map<string, number>,
): SummaryAnalysis {
  const rows: number[] = []
  for (let row = block.firstDataRow ?? 0; row <= (block.lastDataRow ?? -1); row += 1) rows.push(row)

  const byNormalized = (normalized: string) =>
    block.headers.find((header) => header.normalized === normalized) ?? null

  const idHeader = byNormalized('student id')
  const amountHeader = byNormalized('sum of amount paid')
  const balanceHeader = byNormalized('sum of balance fees')

  let meaningfulRowCount = 0
  let formulaCount = 0
  let differing = 0
  let largestDifference = 0
  let inBoth = 0
  let onlyInSummary = 0

  const summaryIds = new Set<string>()

  for (const row of rows) {
    const idCell = idHeader === null ? null : readCell(sheet, row - 1, idHeader.column)
    const id = studentIdText(idCell)
    const amount = amountHeader === null ? null : numericValue(readCell(sheet, row - 1, amountHeader.column))

    for (const header of block.headers) {
      if (readCell(sheet, row - 1, header.column)?.formula) formulaCount += 1
    }

    const populated = block.headers.some((header) => !isBlank(readCell(sheet, row - 1, header.column)))
    if (populated) meaningfulRowCount += 1

    if (id === null) continue
    summaryIds.add(id)

    const trackerTotal = trackerTotalsByStudentId.get(id)
    if (trackerTotal === undefined) {
      onlyInSummary += 1
      continue
    }

    inBoth += 1
    if (amount !== null) {
      const difference = Math.abs(amount - trackerTotal)
      if (difference > 0.005) {
        differing += 1
        largestDifference = Math.max(largestDifference, difference)
      }
    }
  }

  const onlyInTracker = [...trackerTotalsByStudentId.keys()].filter((id) => !summaryIds.has(id)).length

  const preHeaderText: string[] = []
  for (let row = 1; row < (block.headerRow ?? 1); row += 1) {
    for (let column = 0; column <= 5; column += 1) {
      const text = rawText(readCell(sheet, row - 1, column))
      if (text !== null && text.trim() !== '') preHeaderText.push(text)
    }
  }

  const pivotEvidence: string[] = []
  if (formulaCount === 0) {
    pivotEvidence.push('no cell in the data range holds a formula: the values are stored, not computed live')
  }
  if (block.headers.some((header) => header.normalized.startsWith('sum of'))) {
    pivotEvidence.push('headings are of the form "Sum of ...", the shape Excel gives a pivot value field')
  }
  if (preHeaderText.some((text) => text.trim().toLowerCase() === 'values')) {
    pivotEvidence.push('a stray "Values" label sits above the headings, left by a pivot layout')
  }

  const uniqueInformation: string[] = []
  if (onlyInSummary > 0) {
    uniqueInformation.push(
      `${onlyInSummary} student number(s) appear here but not in Tracker Master`,
    )
  }
  if (balanceHeader !== null) {
    uniqueInformation.push(
      'carries a per-student balance total, which Tracker Master states per transaction row rather than per student',
    )
  }

  return {
    sheetName,
    headerRow: block.headerRow,
    firstDataRow: block.firstDataRow,
    lastDataRow: block.lastDataRow,
    headers: block.headers.map((header) => ({ letter: header.letter, original: header.original })),
    columnProfiles: block.headers.map((header) =>
      profileColumn(sheet, header.column, rows, header.original, date1904),
    ),
    rowsInSpan: rows.length,
    meaningfulRowCount,
    distinctStudentIdCount: summaryIds.size,
    formulaCount,
    looksLikePivotOutput: pivotEvidence.length >= 2,
    pivotEvidence,
    preHeaderText,
    comparisonWithTrackerMaster: {
      studentIdsOnlyInSummary: onlyInSummary,
      studentIdsOnlyInTrackerMaster: onlyInTracker,
      studentIdsInBoth: inBoth,
      studentsWhereAmountPaidDiffers: differing,
      largestAmountDifference: largestDifference,
      note:
        differing === 0
          ? 'every shared student number totals the same as the sum of that student’s Tracker Master rows'
          : `${differing} student(s) total differently from the sum of their Tracker Master rows`,
    },
    uniqueInformation,
  }
}
