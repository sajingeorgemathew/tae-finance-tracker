/**
 * Sheet inventory: the shape of every worksheet, before anything is read into it.
 *
 * "Row count" here means the used range Excel reports, which is not the same as
 * the number of rows with data in them — one sheet in this workbook declares a
 * range nearly six hundred rows deep and stops carrying data around row forty.
 * Both numbers are reported, because the gap between them is what tells an
 * importer where to stop.
 */

import * as XLSX from 'xlsx'

import { isRowEmpty } from '../lib/blocks.mts'
import { columnLetter, rawText, readCell } from '../lib/excel-values.mts'

import type { SheetBlock } from '../lib/blocks.mts'
import type { SheetClassification } from '../lib/classify.mts'
import type { WorkBook, WorkSheet } from 'xlsx'

export interface SheetInventoryEntry {
  index: number
  name: string
  /** Used range as the file declares it, e.g. "A1:Z595". */
  usedRange: string | null
  declaredRowCount: number
  declaredColumnCount: number
  /** Last row with any value in it, which may be far above the declared range. */
  lastPopulatedRow: number | null
  /** Rows inside the used range with nothing in them. */
  emptyRowCount: number
  /** Runs of consecutive empty rows, as "firstRow-lastRow". */
  emptyRowRuns: string[]
  mergedRanges: string[]
  cellCount: number
  formulaCount: number
  errorCount: number
  errorCells: { ref: string; error: string; formula: string | null }[]
  hidden: boolean
  /** Rows that read as column headings, 1-based. */
  probableHeaderRows: number[]
  probableFirstDataRow: number | null
  probableLastMeaningfulRow: number | null
  blockCount: number
  blockTitles: (string | null)[]
  classification: SheetClassification
  classificationEvidence: string[]
}

/** Hidden state as recorded in the workbook's sheet list, when present. */
function isHidden(workbook: WorkBook, index: number): boolean {
  const entry = workbook.Workbook?.Sheets?.[index]
  return Boolean(entry && typeof entry.Hidden === 'number' && entry.Hidden > 0)
}

export function inventorySheet(
  workbook: WorkBook,
  index: number,
  name: string,
  sheet: WorkSheet,
  blocks: SheetBlock[],
  classification: SheetClassification,
  classificationEvidence: string[],
): SheetInventoryEntry {
  const ref = sheet['!ref'] ?? null

  if (ref === null) {
    return {
      index,
      name,
      usedRange: null,
      declaredRowCount: 0,
      declaredColumnCount: 0,
      lastPopulatedRow: null,
      emptyRowCount: 0,
      emptyRowRuns: [],
      mergedRanges: [],
      cellCount: 0,
      formulaCount: 0,
      errorCount: 0,
      errorCells: [],
      hidden: isHidden(workbook, index),
      probableHeaderRows: [],
      probableFirstDataRow: null,
      probableLastMeaningfulRow: null,
      blockCount: 0,
      blockTitles: [],
      classification,
      classificationEvidence,
    }
  }

  const range = XLSX.utils.decode_range(ref)

  let cellCount = 0
  let formulaCount = 0
  let errorCount = 0
  const errorCells: SheetInventoryEntry['errorCells'] = []

  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const cell = readCell(sheet, row, column)
      if (!cell) continue
      cellCount += 1
      if (cell.formula) formulaCount += 1
      if (cell.isError) {
        errorCount += 1
        errorCells.push({
          ref: cell.ref,
          error: rawText(cell) ?? '#UNKNOWN',
          formula: cell.formula ?? null,
        })
      }
    }
  }

  const emptyRows: number[] = []
  let lastPopulatedRow: number | null = null
  for (let row = range.s.r; row <= range.e.r; row += 1) {
    if (isRowEmpty(sheet, row, range)) emptyRows.push(row + 1)
    else lastPopulatedRow = row + 1
  }

  const probableHeaderRows = blocks
    .map((block) => block.headerRow)
    .filter((row): row is number => row !== null)

  const dataRows = blocks
    .map((block) => block.firstDataRow)
    .filter((row): row is number => row !== null)

  const lastRows = blocks.map((block) => block.lastDataRow).filter((row): row is number => row !== null)

  return {
    index,
    name,
    usedRange: ref,
    declaredRowCount: range.e.r - range.s.r + 1,
    declaredColumnCount: range.e.c - range.s.c + 1,
    lastPopulatedRow,
    emptyRowCount: emptyRows.length,
    emptyRowRuns: summariseRuns(emptyRows),
    mergedRanges: (sheet['!merges'] ?? []).map((merge) => XLSX.utils.encode_range(merge)),
    cellCount,
    formulaCount,
    errorCount,
    errorCells,
    hidden: isHidden(workbook, index),
    probableHeaderRows,
    probableFirstDataRow: dataRows.length > 0 ? Math.min(...dataRows) : null,
    probableLastMeaningfulRow: lastRows.length > 0 ? Math.max(...lastRows) : null,
    blockCount: blocks.length,
    blockTitles: blocks.map((block) => block.title),
    classification,
    classificationEvidence,
  }
}

/** Collapses [3,4,5,9] into ["3-5", "9"] so a report can state gaps compactly. */
export function summariseRuns(rows: readonly number[]): string[] {
  const runs: string[] = []
  let start: number | null = null
  let previous: number | null = null

  for (const row of rows) {
    if (start === null || previous === null) {
      start = row
      previous = row
      continue
    }
    if (row === previous + 1) {
      previous = row
      continue
    }
    runs.push(start === previous ? String(start) : `${start}-${previous}`)
    start = row
    previous = row
  }

  if (start !== null && previous !== null) {
    runs.push(start === previous ? String(start) : `${start}-${previous}`)
  }

  return runs
}

/** The widest column letter in use, for talking about a sheet in a report. */
export function lastColumnLetter(sheet: WorkSheet): string | null {
  const ref = sheet['!ref']
  if (!ref) return null
  return columnLetter(XLSX.utils.decode_range(ref).e.c)
}
