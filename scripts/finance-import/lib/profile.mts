/**
 * Column profiling: what is actually in a column, counted rather than judged.
 *
 * A profile answers "how does this column behave?" — how often it is filled,
 * what types it holds, how many cells are formulas, whether the numbers read
 * like Excel date serials. It never rewrites a value and never decides that a
 * column is wrong.
 *
 * Distinct values are collected up to a cap. Whether any of them may be shown
 * in a committed document is the caller's decision, not this module's: a
 * Program column is safe to print, a Payer column is not.
 */

import {
  columnLetter,
  interpretDateCell,
  isBlank,
  isExplicitZero,
  numericValue,
  rawText,
  readCell,
} from './excel-values.mts'
import { roleForHeader } from './headers.mts'

import type { DateInterpretationStatus } from './excel-values.mts'
import type { ColumnRole } from './headers.mts'
import type { WorkSheet } from 'xlsx'

/** Above this many distinct values, only the count is kept. */
const DISTINCT_VALUE_CAP = 60

export interface NumericSummary {
  count: number
  min: number
  max: number
  /** Negative values are preserved and counted, never discarded. */
  negativeCount: number
  /** Cells holding exactly 0, which is not the same as a blank cell. */
  zeroCount: number
  /** Values with more than two decimal places, which money should not have. */
  subCentCount: number
}

export interface ColumnProfile {
  column: number
  letter: string
  /** Heading exactly as stored, or null for a column with no heading. */
  header: string | null
  role: ColumnRole
  rowsExamined: number
  blankCount: number
  nonBlankCount: number
  formulaCount: number
  errorCount: number
  /** Cell-type histogram, keyed by SheetJS type letter. */
  typeCounts: Record<string, number>
  distinctCount: number
  /** Up to DISTINCT_VALUE_CAP distinct values, as text. Null once capped. */
  distinctValues: string[] | null
  numeric: NumericSummary | null
  /** How the column's values read if treated as Excel date serials. */
  dateStatusCounts: Record<DateInterpretationStatus, number>
  /** Formula sources seen, capped, for spotting a column-wide pattern. */
  formulaSamples: string[]
}

function emptyDateStatusCounts(): Record<DateInterpretationStatus, number> {
  return {
    ok: 0,
    'ambiguous-1900-leap-bug': 0,
    'implausible-range': 0,
    'has-time-component': 0,
    'not-a-serial': 0,
    blank: 0,
  }
}

/**
 * Profiles one column over a row span.
 *
 * `rows` is the exact set of 1-based rows to look at, so a caller can profile
 * a single block of a sheet rather than the whole column.
 */
export function profileColumn(
  sheet: WorkSheet,
  column: number,
  rows: readonly number[],
  header: string | null,
  date1904 = false,
): ColumnProfile {
  const typeCounts: Record<string, number> = {}
  const distinct = new Set<string>()
  const formulaSamples = new Set<string>()
  const dateStatusCounts = emptyDateStatusCounts()

  let blankCount = 0
  let nonBlankCount = 0
  let formulaCount = 0
  let errorCount = 0

  let numericCount = 0
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let negativeCount = 0
  let zeroCount = 0
  let subCentCount = 0

  for (const row of rows) {
    const cell = readCell(sheet, row - 1, column)

    if (cell) {
      typeCounts[cell.type] = (typeCounts[cell.type] ?? 0) + 1
      if (cell.formula) {
        formulaCount += 1
        if (formulaSamples.size < 8) formulaSamples.add(cell.formula)
      }
      if (cell.isError) errorCount += 1
    }

    if (isBlank(cell) && !isExplicitZero(cell)) {
      blankCount += 1
      dateStatusCounts.blank += 1
      continue
    }

    nonBlankCount += 1

    const text = rawText(cell)
    if (text !== null) distinct.add(text)

    const value = numericValue(cell)
    if (value !== null) {
      numericCount += 1
      if (value < min) min = value
      if (value > max) max = value
      if (value < 0) negativeCount += 1
      if (value === 0) zeroCount += 1
      if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-6) subCentCount += 1
    }

    dateStatusCounts[interpretDateCell(cell, date1904).status] += 1
  }

  const capped = distinct.size > DISTINCT_VALUE_CAP

  return {
    column,
    letter: columnLetter(column),
    header,
    role: header === null ? 'unknown' : roleForHeader(header),
    rowsExamined: rows.length,
    blankCount,
    nonBlankCount,
    formulaCount,
    errorCount,
    typeCounts,
    distinctCount: distinct.size,
    distinctValues: capped ? null : [...distinct].sort((a, b) => a.localeCompare(b)),
    numeric:
      numericCount === 0
        ? null
        : { count: numericCount, min, max, negativeCount, zeroCount, subCentCount },
    dateStatusCounts,
    formulaSamples: [...formulaSamples],
  }
}

/**
 * Whether a column's numbers behave like Excel date serials.
 *
 * Reported as a ratio and a verdict rather than a conversion: the caller still
 * stores the raw value, and a column that looks like dates is a hypothesis for
 * a reviewer, not a transformation.
 */
export function dateLikeness(profile: ColumnProfile): {
  serialLikeRatio: number
  verdict: 'date-serials' | 'mixed' | 'not-dates'
} {
  const considered = profile.nonBlankCount
  if (considered === 0) return { serialLikeRatio: 0, verdict: 'not-dates' }

  const serialLike =
    profile.dateStatusCounts.ok +
    profile.dateStatusCounts['has-time-component'] +
    profile.dateStatusCounts['ambiguous-1900-leap-bug']

  const ratio = serialLike / considered

  if (ratio >= 0.95) return { serialLikeRatio: ratio, verdict: 'date-serials' }
  if (ratio > 0) return { serialLikeRatio: ratio, verdict: 'mixed' }
  return { serialLikeRatio: ratio, verdict: 'not-dates' }
}
