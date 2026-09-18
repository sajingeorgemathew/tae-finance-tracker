/**
 * Finding the tables inside a sheet, and the sections inside a table.
 *
 * Two things in this workbook defeat "row 1 is the header, everything below is
 * data":
 *
 *  1. Every dated PSW sheet holds *two* tables — a Morning batch and an
 *     Evening batch — stacked vertically, each with its own title and its own
 *     header row. A sheet is not a batch.
 *  2. Each table is split left-to-right into an ACTUAL FEE STRUCTURE section
 *     (money that came in) and an INSTALLMENT FEE STRUCTURE section (money
 *     that was scheduled). The same month name appears in both. They are
 *     different concepts and are kept apart here and everywhere downstream.
 *
 * Detection records its own evidence. Where a banner is missing and the split
 * had to be inferred, or where a second table reuses the first table's
 * headings instead of repeating them, the block says so — so the report can
 * flag it for review instead of presenting a guess as a fact.
 */

import { columnLetter, isBlank, rawText, readCell } from './excel-values.mts'
import { looksLikeHeaderRow, normalizeHeader, roleForHeader } from './headers.mts'

import type { RawCell } from './excel-values.mts'
import type { HeaderCell } from './headers.mts'
import type { Range, WorkSheet } from 'xlsx'

/** A title that names a batch, e.g. "PSW Morning Batch - 12th May 2025". */
const BATCH_TITLE = /\bbatch\b/i

const ACTUAL_BANNER = /^actual fee structure$/i
const INSTALLMENT_BANNER = /^installment fee structure$/i

/** How a section's column span was established. */
export type SectionEvidence =
  /** An explicit ACTUAL/INSTALLMENT banner cell was found above the headings. */
  | 'banner'
  /** No banner: inferred from the heading row repeating "Total Fee". */
  | 'repeated-total-fee-header'
  /** Bounded by the other section's banner and the first "Total Fee" heading. */
  | 'header-position'

export interface SectionSpan {
  /** Inclusive zero-based column bounds. */
  firstColumn: number
  lastColumn: number
  firstLetter: string
  lastLetter: string
  evidence: SectionEvidence
  /** The banner text exactly as stored, when there was one. */
  bannerText?: string
  bannerRef?: string
}

/** A heading a block borrowed from an earlier block in the same sheet. */
export interface InheritedHeader extends HeaderCell {
  /** 1-based row the heading was actually read from. */
  fromRow: number
}

export interface SheetBlock {
  /** 1-based row of the title, when the block has one. */
  titleRow: number | null
  /** The title exactly as stored. Never rewritten. */
  title: string | null
  /** 1-based row carrying the column headings. */
  headerRow: number | null
  /**
   * Headings this block does not state itself, taken from the nearest earlier
   * block at the same column. An observation, not a repair: the block is
   * reported with these listed separately so a reviewer sees exactly what was
   * borrowed and from which row.
   */
  inheritedHeaders: InheritedHeader[]
  /** 1-based first and last data rows, inclusive. Null when the block has no data. */
  firstDataRow: number | null
  lastDataRow: number | null
  /** Headings stated by this block's own header row. */
  ownHeaders: HeaderCell[]
  /** Own headings plus inherited ones, ordered by column. The working view. */
  headers: HeaderCell[]
  /** The money-received section. Null when the block has no actual/scheduled split. */
  actualSection: SectionSpan | null
  /** The scheduled-installment section. Null when the block has no split. */
  installmentSection: SectionSpan | null
}

/** Every string cell in a row, indexed by offset from the range start. */
function rowStrings(sheet: WorkSheet, row: number, range: Range): (string | null)[] {
  const values: (string | null)[] = []
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    const cell = readCell(sheet, row, column)
    values.push(cell && cell.type === 's' ? rawText(cell) : null)
  }
  return values
}

/** True when a row has no value in any column of the range. */
export function isRowEmpty(sheet: WorkSheet, row: number, range: Range): boolean {
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    if (!isBlank(readCell(sheet, row, column))) return false
  }
  return true
}

/**
 * The headings on a row, skipping columns with no heading text.
 *
 * `skipColumn` drops the cell a block title occupies, for the sheets where the
 * title and the headings share one row.
 */
export function readHeaderRow(
  sheet: WorkSheet,
  row: number,
  range: Range,
  skipColumn?: number,
): HeaderCell[] {
  const headers: HeaderCell[] = []
  for (let column = range.s.c; column <= range.e.c; column += 1) {
    if (column === skipColumn) continue
    const cell = readCell(sheet, row, column)
    const text = cell && cell.type === 's' ? rawText(cell) : null
    if (text === null || text.trim() === '') continue
    headers.push({
      column,
      letter: columnLetter(column),
      original: text,
      normalized: normalizeHeader(text),
    })
  }
  return headers
}

/** A banner cell found above a table, with the merge span it covers. */
interface Banner {
  row: number
  column: number
  text: string
  ref: string
  /** Last column of the merged range the banner sits in, when merged. */
  mergedLastColumn: number | null
}

function findBanners(sheet: WorkSheet, range: Range, pattern: RegExp): Banner[] {
  const merges = sheet['!merges'] ?? []
  const banners: Banner[] = []

  for (let row = range.s.r; row <= range.e.r; row += 1) {
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      const cell = readCell(sheet, row, column)
      if (!cell || cell.type !== 's') continue
      const text = rawText(cell)
      if (text === null || !pattern.test(text.trim())) continue

      const merge = merges.find((m) => m.s.r === row && m.s.c === column)
      banners.push({ row, column, text, ref: cell.ref, mergedLastColumn: merge ? merge.e.c : null })
    }
  }

  return banners
}

function span(
  firstColumn: number,
  lastColumn: number,
  evidence: SectionEvidence,
  banner?: Banner,
): SectionSpan {
  const section: SectionSpan = {
    firstColumn,
    lastColumn,
    firstLetter: columnLetter(firstColumn),
    lastLetter: columnLetter(lastColumn),
    evidence,
  }
  if (banner) {
    section.bannerText = banner.text
    section.bannerRef = banner.ref
  }
  return section
}

/**
 * Splits a block's columns into the actual and installment sections.
 *
 * A block only has sections when there is evidence of a split: an INSTALLMENT
 * banner, or a heading row that opens a second table with "Total Fee" a second
 * time. Sheets with a single flat table (Tracker Master, ELCE, French) get no
 * sections at all rather than an invented one.
 */
function detectSections(
  sheet: WorkSheet,
  range: Range,
  headers: HeaderCell[],
  bannerSearchFirstRow: number,
  bannerSearchLastRow: number,
): { actual: SectionSpan | null; installment: SectionSpan | null } {
  const bannerRange: Range = {
    s: { r: bannerSearchFirstRow, c: range.s.c },
    e: { r: bannerSearchLastRow, c: range.e.c },
  }

  const actualBanner = findBanners(sheet, bannerRange, ACTUAL_BANNER)[0] ?? null
  const installmentBanner = findBanners(sheet, bannerRange, INSTALLMENT_BANNER)[0] ?? null

  // "Total Fee" opens both sections on every batch sheet in this workbook, so a
  // second occurrence marks where the scheduled side begins when no banner does.
  const totalFeeColumns = headers
    .filter((header) => roleForHeader(header.original) === 'total_fee')
    .map((header) => header.column)

  const hasSplit = Boolean(installmentBanner) || totalFeeColumns.length >= 2
  if (!hasSplit) return { actual: null, installment: null }

  const lastHeaderColumn = headers.length > 0 ? headers[headers.length - 1].column : range.e.c

  let installment: SectionSpan | null = null
  if (installmentBanner) {
    installment = span(
      installmentBanner.column,
      Math.max(installmentBanner.mergedLastColumn ?? installmentBanner.column, lastHeaderColumn),
      'banner',
      installmentBanner,
    )
  } else {
    installment = span(
      totalFeeColumns[1],
      Math.max(lastHeaderColumn, range.e.c),
      'repeated-total-fee-header',
    )
  }

  let actual: SectionSpan | null = null
  if (actualBanner) {
    actual = span(
      actualBanner.column,
      actualBanner.mergedLastColumn ?? installment.firstColumn - 1,
      'banner',
      actualBanner,
    )
  } else if (totalFeeColumns.length >= 1) {
    actual = span(
      totalFeeColumns[0],
      installment.firstColumn - 1,
      installment.evidence === 'repeated-total-fee-header'
        ? 'repeated-total-fee-header'
        : 'header-position',
    )
  }

  // A banner's merge often stops short of the columns actually used — the
  // unlabelled "outstanding" column sits outside it on most sheets. Widen the
  // actual section up to the installment section so no column falls in the gap
  // between the two and goes unclassified.
  if (actual && actual.lastColumn < installment.firstColumn - 1) {
    actual = span(actual.firstColumn, installment.firstColumn - 1, actual.evidence)
    if (actualBanner) {
      actual.bannerText = actualBanner.text
      actual.bannerRef = actualBanner.ref
    }
  }

  return { actual, installment }
}

export interface FindBlocksOptions {
  /**
   * Rows to consider when looking for the header of a sheet that has no batch
   * titles at all (Tracker Master, ELCE, French). Defaults to the whole sheet.
   */
  maxHeaderSearchRows?: number
}

/**
 * Finds every table in a sheet.
 *
 * A sheet with batch titles yields one block per title. A sheet without them
 * yields at most one block, headed by the first row that reads as a header.
 */
export function findBlocks(
  sheet: WorkSheet,
  range: Range,
  options: FindBlocksOptions = {},
): SheetBlock[] {
  const titleRows: { row: number; column: number; title: string }[] = []
  const headerRows = new Set<number>()

  for (let row = range.s.r; row <= range.e.r; row += 1) {
    const strings = rowStrings(sheet, row, range)

    const offset = strings.findIndex((value) => value !== null && value.trim() !== '')
    if (offset !== -1 && BATCH_TITLE.test(strings[offset] as string)) {
      titleRows.push({ row, column: range.s.c + offset, title: strings[offset] as string })
    }

    if (looksLikeHeaderRow(strings)) headerRows.add(row)
  }

  if (titleRows.length === 0) {
    return findSingleBlock(sheet, range, headerRows, options)
  }

  const blocks: SheetBlock[] = []

  titleRows.forEach((title, index) => {
    const nextTitleRow = titleRows[index + 1]?.row ?? range.e.r + 1
    const blockLastRow = nextTitleRow - 1

    // The title row and the header row are the same row on some sheets and one
    // or two rows apart on others.
    let headerRow: number | null = null
    for (let row = title.row; row <= Math.min(title.row + 2, blockLastRow); row += 1) {
      if (headerRows.has(row)) {
        headerRow = row
        break
      }
    }

    const ownHeaders =
      headerRow === null
        ? []
        : readHeaderRow(sheet, headerRow, range, headerRow === title.row ? title.column : undefined)

    const { headers, inheritedHeaders } = withInheritedHeaders(ownHeaders, blocks)

    const firstCandidateRow = (headerRow ?? title.row) + 1
    const { firstDataRow, lastDataRow } = trimDataRows(sheet, range, firstCandidateRow, blockLastRow)

    const sections = detectSections(sheet, range, headers, title.row, headerRow ?? title.row)

    blocks.push({
      titleRow: title.row + 1,
      title: title.title,
      headerRow: headerRow === null ? null : headerRow + 1,
      inheritedHeaders,
      firstDataRow,
      lastDataRow,
      ownHeaders,
      headers,
      actualSection: sections.actual,
      installmentSection: sections.installment,
    })
  })

  return blocks
}

/**
 * Fills the columns a block leaves unheaded from the nearest earlier block.
 *
 * On several sheets the second table repeats only part of the heading row —
 * Dec 2025 restates the scheduled side and leaves the actual side to line up
 * with the table above it. Borrowed headings are returned separately from the
 * block's own so nothing downstream can mistake one for the other.
 */
function withInheritedHeaders(
  ownHeaders: HeaderCell[],
  earlierBlocks: SheetBlock[],
): { headers: HeaderCell[]; inheritedHeaders: InheritedHeader[] } {
  const previous = earlierBlocks[earlierBlocks.length - 1]
  if (!previous || previous.headerRow === null) {
    return { headers: [...ownHeaders], inheritedHeaders: [] }
  }

  const stated = new Set(ownHeaders.map((header) => header.column))
  const inheritedHeaders: InheritedHeader[] = previous.headers
    .filter((header) => !stated.has(header.column))
    .map((header) => ({ ...header, fromRow: previous.headerRow as number }))

  const headers = [...ownHeaders, ...inheritedHeaders].sort((a, b) => a.column - b.column)
  return { headers, inheritedHeaders }
}

function findSingleBlock(
  sheet: WorkSheet,
  range: Range,
  headerRows: Set<number>,
  options: FindBlocksOptions,
): SheetBlock[] {
  const limit =
    options.maxHeaderSearchRows === undefined
      ? range.e.r
      : Math.min(range.s.r + options.maxHeaderSearchRows - 1, range.e.r)

  let headerRow: number | null = null
  for (let row = range.s.r; row <= limit; row += 1) {
    if (headerRows.has(row)) {
      headerRow = row
      break
    }
  }

  if (headerRow === null) return []

  const headers = readHeaderRow(sheet, headerRow, range)
  const { firstDataRow, lastDataRow } = trimDataRows(sheet, range, headerRow + 1, range.e.r)
  const sections = detectSections(sheet, range, headers, range.s.r, headerRow)

  return [
    {
      titleRow: null,
      title: null,
      headerRow: headerRow + 1,
      inheritedHeaders: [],
      firstDataRow,
      lastDataRow,
      ownHeaders: headers,
      headers,
      actualSection: sections.actual,
      installmentSection: sections.installment,
    },
  ]
}

/**
 * Narrows a candidate row span to the rows that actually carry something.
 *
 * Trailing empty rows are excluded from the reported span, but nothing inside
 * the span is skipped: a blank row *between* two populated rows stays part of
 * the block and is counted, because a gap in the middle of a table is a
 * finding, not noise.
 */
function trimDataRows(
  sheet: WorkSheet,
  range: Range,
  firstCandidateRow: number,
  lastCandidateRow: number,
): { firstDataRow: number | null; lastDataRow: number | null } {
  let first: number | null = null
  let last: number | null = null

  for (let row = firstCandidateRow; row <= lastCandidateRow; row += 1) {
    if (isRowEmpty(sheet, row, range)) continue
    if (first === null) first = row
    last = row
  }

  return {
    firstDataRow: first === null ? null : first + 1,
    lastDataRow: last === null ? null : last + 1,
  }
}

/** Every populated cell of a row inside a column span, keyed by column index. */
export function readRowCells(
  sheet: WorkSheet,
  row: number,
  firstColumn: number,
  lastColumn: number,
): Map<number, RawCell> {
  const cells = new Map<number, RawCell>()
  for (let column = firstColumn; column <= lastColumn; column += 1) {
    const cell = readCell(sheet, row, column)
    if (cell) cells.set(column, cell)
  }
  return cells
}
