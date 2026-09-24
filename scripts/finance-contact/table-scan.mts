/**
 * A generic roster-table scanner — the one piece of sheet reading every
 * adapter shares.
 *
 * A roster sheet is a sequence of: a title row ("PSW Morning Batch - …"), a
 * heading row ("Sr. No. | Student ID | …"), student rows, and assorted
 * non-student rows (blank lines, a colour legend, pre-numbered empty rows).
 * An adapter supplies what is specific to its workbook — how to recognize a
 * title, how headings map onto canonical fields — and this module walks the
 * sheet, classifies every row, and produces canonical rows.
 *
 * Two rules protect the allowlist:
 *
 *  1. A cell is read only through the heading map. A column whose heading is
 *     not mapped is never read; its *heading text* is recorded so the report
 *     can say what was ignored, its values never leave the workbook buffer.
 *  2. A heading that matches `SENSITIVE_HEADING_PATTERNS` is refused as a map
 *     target, so a mistaken adapter map cannot stage a password or a date of
 *     birth.
 *
 * Every row in the sheet's used range receives exactly one kind, so the
 * per-sheet conservation (`counts`) adds up to the range height.
 */

import * as XLSX from 'xlsx'

import type { CellObject, WorkSheet } from 'xlsx'

import { serialToISODate } from '../finance-import/lib/excel-values.mts'

import {
  isSensitiveHeading,
  normalizeHeading,
  type AllowedField,
  type ContactImportRow,
  type SourceSession,
} from './canonical.mts'
import {
  cleanNamePart,
  joinNameParts,
  normalizeEmail,
  normalizePhone,
  normalizeStudentNumber,
} from './normalize.mts'

// -----------------------------------------------------------------------------
// What an adapter tells the scanner
// -----------------------------------------------------------------------------

/** What a recognized table title states. Nothing is inferred beyond the text. */
export interface TableTitle {
  /** The title text exactly. */
  text: string
  intakeLabel: string | null
  /** ISO date when the title states a full day, month and year. */
  intakeDate: string | null
  session: SourceSession | null
}

export interface ScanOptions {
  workbookName: string
  programCode: string
  /** Returns the table title a cell states, or null when the text is not a title. */
  recognizeTitle(text: string): TableTitle | null
  /**
   * Normalized heading -> canonical field. Only these columns are read.
   * A heading matching a sensitive pattern is refused even if listed.
   */
  headingMap: Readonly<Record<string, AllowedField>>
  /** Normalized heading of the serial-number column, used only to spot placeholder rows. */
  serialHeading?: RegExp
  /** Maps a raw session cell value to a session name, when a column states it. */
  sessionValue?(raw: string): SourceSession | null
  date1904: boolean
}

// -----------------------------------------------------------------------------
// Results
// -----------------------------------------------------------------------------

export type RowKind =
  | 'title'
  | 'header'
  | 'student'
  | 'placeholder'
  | 'legend'
  | 'blank'
  | 'other'

export const ROW_KINDS: readonly RowKind[] = ['title', 'header', 'student', 'placeholder', 'legend', 'blank', 'other']

export interface ScannedRow {
  row: number
  kind: RowKind
  /** Column letters carrying values on a non-student row. Letters only, never values. */
  note?: string
}

export interface ScannedTable {
  title: TableTitle | null
  titleRow: number | null
  headerRow: number
  /** Canonical field -> 0-based column index. */
  columns: Partial<Record<AllowedField, number>>
  /** Heading texts present but not mapped (names only). */
  ignoredHeadings: string[]
  /** Ignored headings that matched a sensitive pattern. Names only. */
  sensitiveHeadings: string[]
  rows: ContactImportRow[]
  placeholderRows: number
}

export interface SheetScan {
  sheetName: string
  /** Rows in the used range (1-based first and last). */
  firstRow: number
  lastRow: number
  rangeRows: number
  tables: ScannedTable[]
  rowKinds: ScannedRow[]
  counts: Record<RowKind, number>
  ignoredHeadings: string[]
  sensitiveHeadings: string[]
}

// -----------------------------------------------------------------------------
// Cell access — only through the map
// -----------------------------------------------------------------------------

function cellAt(sheet: WorkSheet, row: number, column: number): CellObject | undefined {
  return sheet[XLSX.utils.encode_cell({ r: row, c: column })] as CellObject | undefined
}

/** Whether a cell holds anything at all. Does not return the value. */
function hasValue(sheet: WorkSheet, row: number, column: number): boolean {
  const cell = cellAt(sheet, row, column)
  if (!cell || cell.v === undefined || cell.v === null) return false
  if (typeof cell.v === 'string') return cell.v.trim() !== ''
  return true
}

/** The text Excel would show for a cell: the formatted text for numbers, so no digit is reformatted. */
function textOf(sheet: WorkSheet, row: number, column: number): string | null {
  const cell = cellAt(sheet, row, column)
  if (!cell || cell.v === undefined || cell.v === null) return null
  if (typeof cell.v === 'string') return cell.v
  if (typeof cell.w === 'string' && cell.w.trim() !== '') return cell.w
  if (cell.t === 'b') return cell.v ? 'TRUE' : 'FALSE'
  return String(cell.v)
}

/** ISO date from a date cell: a serial with the workbook's epoch, or ISO text. */
function isoDateOf(sheet: WorkSheet, row: number, column: number, date1904: boolean): string | null {
  const cell = cellAt(sheet, row, column)
  if (!cell || cell.v === undefined || cell.v === null) return null
  if (cell.t === 'n' && typeof cell.v === 'number') return serialToISODate(cell.v, date1904)
  if (cell.t === 'd' && cell.v instanceof Date) return cell.v.toISOString().slice(0, 10)
  const text = String(cell.v).trim()
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  return iso ? `${iso[1]}-${iso[2]}-${iso[3]}` : null
}

// -----------------------------------------------------------------------------
// Heading rows
// -----------------------------------------------------------------------------

const DEFAULT_SERIAL_HEADING = /^(sr\.? ?no\.?|s\.? ?no\.?|serial( no\.?)?|#)$/

interface HeaderLayout {
  columns: Partial<Record<AllowedField, number>>
  serialColumn: number | null
  ignoredHeadings: string[]
  sensitiveHeadings: string[]
}

function readHeader(sheet: WorkSheet, row: number, lastColumn: number, options: ScanOptions): HeaderLayout {
  const columns: Partial<Record<AllowedField, number>> = {}
  const ignored: string[] = []
  const sensitive: string[] = []
  let serialColumn: number | null = null
  const serialHeading = options.serialHeading ?? DEFAULT_SERIAL_HEADING

  for (let column = 0; column <= lastColumn; column += 1) {
    const heading = textOf(sheet, row, column)
    if (heading === null || heading.trim() === '') continue
    const normalized = normalizeHeading(heading)
    if (normalized === '') continue

    if (serialHeading.test(normalized)) {
      serialColumn = column
      continue
    }

    const field = options.headingMap[normalized]
    if (field !== undefined && !isSensitiveHeading(normalized)) {
      // First occurrence wins: a repeated heading (a second STATUS block, a
      // second placement block) is never allowed to overwrite the roster one.
      if (columns[field] === undefined) columns[field] = column
      else ignored.push(heading.trim())
      continue
    }

    if (isSensitiveHeading(normalized)) sensitive.push(heading.trim())
    ignored.push(heading.trim())
  }

  return { columns, serialColumn, ignoredHeadings: ignored, sensitiveHeadings: sensitive }
}

function isHeaderRow(sheet: WorkSheet, row: number, lastColumn: number, options: ScanOptions): boolean {
  // A heading row states the student-number heading somewhere in it. That is
  // the one column every roster must have, whatever else it carries.
  for (let column = 0; column <= lastColumn; column += 1) {
    const heading = textOf(sheet, row, column)
    if (heading === null) continue
    if (options.headingMap[normalizeHeading(heading)] === 'studentNumber') return true
  }
  return false
}

// -----------------------------------------------------------------------------
// The scan
// -----------------------------------------------------------------------------

function emptyCounts(): Record<RowKind, number> {
  return { title: 0, header: 0, student: 0, placeholder: 0, legend: 0, blank: 0, other: 0 }
}

function lettersOf(columns: readonly number[]): string {
  return columns.map((column) => XLSX.utils.encode_col(column)).join(',')
}

export function scanSheet(sheet: WorkSheet, sheetName: string, options: ScanOptions): SheetScan {
  const ref = sheet['!ref']
  const scan: SheetScan = {
    sheetName,
    firstRow: 0,
    lastRow: 0,
    rangeRows: 0,
    tables: [],
    rowKinds: [],
    counts: emptyCounts(),
    ignoredHeadings: [],
    sensitiveHeadings: [],
  }
  if (!ref) return scan

  const range = XLSX.utils.decode_range(ref)
  scan.firstRow = range.s.r + 1
  scan.lastRow = range.e.r + 1
  scan.rangeRows = range.e.r - range.s.r + 1

  let pendingTitle: { title: TableTitle; row: number } | null = null
  let current: (ScannedTable & { layout: HeaderLayout }) | null = null

  const record = (row: number, kind: RowKind, note?: string): void => {
    scan.rowKinds.push(note === undefined ? { row: row + 1, kind } : { row: row + 1, kind, note })
    scan.counts[kind] += 1
  }

  for (let row = range.s.r; row <= range.e.r; row += 1) {
    const filled: number[] = []
    for (let column = range.s.c; column <= range.e.c; column += 1) {
      if (hasValue(sheet, row, column)) filled.push(column)
    }

    if (filled.length === 0) {
      record(row, 'blank')
      continue
    }

    // A title: recognized from the first filled cell's text. Titles sit in a
    // merged cell at the left, so the first filled cell is the title text.
    const firstText = textOf(sheet, row, filled[0])
    const title = firstText === null ? null : options.recognizeTitle(firstText)
    if (title !== null) {
      pendingTitle = { title, row: row + 1 }
      current = null
      record(row, 'title')
      continue
    }

    if (isHeaderRow(sheet, row, range.e.c, options)) {
      const layout = readHeader(sheet, row, range.e.c, options)
      current = {
        title: pendingTitle?.title ?? null,
        titleRow: pendingTitle?.row ?? null,
        headerRow: row + 1,
        columns: layout.columns,
        ignoredHeadings: layout.ignoredHeadings,
        sensitiveHeadings: layout.sensitiveHeadings,
        rows: [],
        placeholderRows: 0,
        layout,
      }
      scan.tables.push(current)
      pendingTitle = null
      record(row, 'header')
      continue
    }

    if (current === null) {
      // Outside any table: a lone text cell is a legend or a note.
      record(row, filled.length === 1 ? 'legend' : 'other', lettersOf(filled))
      continue
    }

    const mapped = new Set(Object.values(current.columns))
    const filledMapped = filled.filter((column) => mapped.has(column))

    // A lone text cell inside a table that is neither a number nor a contact
    // is not a student: it is the colour legend ("Withdrawal", "Enrollment
    // Pending", "Other Reason") that the PSW sheets write into the name
    // column below each Morning table, or a stray note.
    const identifying = new Set(
      [current.columns.studentNumber, current.columns.email, current.columns.phone].filter(
        (column): column is number => column !== undefined,
      ),
    )
    if (filled.length === 1 && filledMapped.length === 1 && !identifying.has(filled[0])) {
      record(row, 'legend', lettersOf(filled))
      continue
    }

    if (filledMapped.length === 0) {
      const onlySerial = filled.length === 1 && filled[0] === current.layout.serialColumn
      if (onlySerial) {
        current.placeholderRows += 1
        record(row, 'placeholder')
      } else if (filled.length === 1) {
        record(row, 'legend', lettersOf(filled))
      } else {
        record(row, 'other', lettersOf(filled))
      }
      continue
    }

    scan.counts.student += 1
    scan.rowKinds.push({ row: row + 1, kind: 'student' })
    current.rows.push(buildRow(sheet, row, current, options, sheetName))
  }

  const ignored = new Set<string>()
  const sensitive = new Set<string>()
  for (const table of scan.tables) {
    for (const heading of table.ignoredHeadings) ignored.add(heading)
    for (const heading of table.sensitiveHeadings) sensitive.add(heading)
  }
  scan.ignoredHeadings = [...ignored].sort()
  scan.sensitiveHeadings = [...sensitive].sort()

  return scan
}

function buildRow(
  sheet: WorkSheet,
  row: number,
  table: ScannedTable,
  options: ScanOptions,
  sheetName: string,
): ContactImportRow {
  const columns = table.columns
  const read = (field: AllowedField): string | null => {
    const column = columns[field]
    return column === undefined ? null : textOf(sheet, row, column)
  }

  const studentNumberRaw = read('studentNumber')
  const studentNumber = normalizeStudentNumber(studentNumberRaw)

  const firstName = cleanNamePart(read('firstName'))
  const middleName = cleanNamePart(read('middleName'))
  const lastName = cleanNamePart(read('lastName'))
  const explicitDisplay = cleanNamePart(read('displayName'))
  const displayName = explicitDisplay ?? joinNameParts(firstName, middleName, lastName)

  const email = normalizeEmail(read('email'))
  const phone = normalizePhone(read('phone'))

  const sessionCell = read('session')
  const sessionFromColumn =
    sessionCell !== null && options.sessionValue ? options.sessionValue(sessionCell.trim()) : null

  const startColumn = columns.sourceStartDate
  const sourceStartDate =
    startColumn === undefined ? null : isoDateOf(sheet, row, startColumn, options.date1904)

  const status = cleanNamePart(read('sourceStatus'))

  return {
    stagedRowId: `${options.programCode}:${sheetName}:${row + 1}`,
    sourceWorkbook: options.workbookName,
    sourceSheet: sheetName,
    sourceTable: table.title?.text ?? null,
    sourceRow: row + 1,
    programCode: options.programCode,
    studentNumber,
    studentNumberRaw,
    firstName,
    middleName,
    lastName,
    displayName,
    emailRaw: email.raw,
    emailNormalized: email.normalized,
    emailStatus: email.status,
    phoneRaw: phone.raw,
    phoneNormalized: phone.normalized,
    phoneStatus: phone.status,
    intakeLabel: table.title?.intakeLabel ?? null,
    intakeDate: table.title?.intakeDate ?? null,
    // A per-row session column is a fact about the row; a title's session is a
    // fact about the table. The row's own statement wins when both exist.
    session: sessionFromColumn ?? table.title?.session ?? null,
    sourceStartDate,
    sourceStatus: status,
    inOperationalScope: true,
    exclusionReason: null,
  }
}

/** Per-sheet conservation: every row of the range has exactly one kind. */
export function sheetConserved(scan: SheetScan): boolean {
  const total = ROW_KINDS.reduce((sum, kind) => sum + scan.counts[kind], 0)
  return total === scan.rangeRows && scan.rowKinds.length === scan.rangeRows
}
