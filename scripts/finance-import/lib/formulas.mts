/**
 * Reading formulas as evidence.
 *
 * Which columns a sheet adds up to reach "Total Paid" is the most direct
 * statement the workbook makes about which columns hold money that actually
 * arrived. Rather than assume "Enroll. Fee" is a payment because it sits on the
 * left-hand side, the analysis reads the SUM range and reports what it covers.
 *
 * Formulas are parsed, never rewritten or repaired.
 */

import * as XLSX from 'xlsx'

/** A1-style reference, with optional $ anchors, e.g. `$H3` or `AA12`. */
const CELL_REFERENCE = /(\$?)([A-Z]{1,3})(\$?)(\d+)/g

/** A whole-formula SUM over a single contiguous range, e.g. `SUM(H3:O3)`. */
const SIMPLE_SUM = /^SUM\((\$?[A-Z]{1,3}\$?\d+):(\$?[A-Z]{1,3}\$?\d+)\)$/i

export interface SumRange {
  firstColumn: number
  lastColumn: number
  firstLetter: string
  lastLetter: string
}

function columnIndex(letter: string): number {
  return XLSX.utils.decode_col(letter.replace(/\$/g, ''))
}

/**
 * The column span of a formula that is exactly one SUM over one range.
 *
 * Returns null for anything more complicated — a SUM of several ranges, an
 * arithmetic expression, a literal — because only the simple case supports the
 * claim "these columns are what this total covers".
 */
export function parseSimpleSumRange(formula: string): SumRange | null {
  const match = SIMPLE_SUM.exec(formula.trim())
  if (!match) return null

  const first = /([A-Z]{1,3})/.exec(match[1].toUpperCase())
  const last = /([A-Z]{1,3})/.exec(match[2].toUpperCase())
  if (!first || !last) return null

  const firstColumn = columnIndex(first[1])
  const lastColumn = columnIndex(last[1])
  if (lastColumn < firstColumn) return null

  return {
    firstColumn,
    lastColumn,
    firstLetter: first[1],
    lastLetter: last[1],
  }
}

/** Every column letter a formula references, in order of appearance, deduplicated. */
export function referencedColumns(formula: string): string[] {
  const letters: string[] = []
  for (const match of formula.toUpperCase().matchAll(CELL_REFERENCE)) {
    const letter = match[2]
    if (!letters.includes(letter)) letters.push(letter)
  }
  return letters
}

/**
 * A formula with its row numbers replaced by `n`.
 *
 * `SUM(H3:O3)` and `SUM(H4:O4)` share the shape `SUM(Hn:On)`, which is what
 * makes it possible to say "this column is one formula repeated" or to spot
 * the rows where it is not.
 */
export function formulaShape(formula: string): string {
  return formula.replace(/(\$?[A-Z]{1,3}\$?)\d+/gi, '$1n')
}

/** Counts of each distinct formula shape, most common first. */
export function tallyShapes(formulas: readonly string[]): { shape: string; count: number }[] {
  const counts = new Map<string, number>()
  for (const formula of formulas) {
    const shape = formulaShape(formula)
    counts.set(shape, (counts.get(shape) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([shape, count]) => ({ shape, count }))
    .sort((a, b) => b.count - a.count || a.shape.localeCompare(b.shape))
}
