/**
 * Turning worksheets into the shape the planners work on.
 *
 * Everything downstream of this module is pure: it takes `SourceTable` values
 * and produces a plan. That split is what makes the mapping rules testable
 * against hand-built tables rather than only against the real workbook, which
 * cannot be committed.
 *
 * Three rules are enforced here rather than being left to callers:
 *
 *  1. **A blank is not a zero.** Every cell carries `isBlank` alongside
 *     `numeric`, and `numeric` is null for a blank. Nothing downstream can
 *     accidentally read an empty instalment cell as a payment of 0.
 *  2. **An error cell is not a value.** `Aug 2026!A11` holds `#REF!`. It is
 *     preserved and reported, and it is explicitly barred from becoming a
 *     student number, so a spreadsheet error cannot conjure a student.
 *  3. **The raw value survives.** `rawValue`, `text`, `formula` and `cellType`
 *     are all kept, because legacy_raw_json is meant to let someone reconstruct
 *     what the workbook said, not what this importer made of it.
 */

import { columnLetter, isBlank, numericValue, readCell } from '../lib/excel-values.mts'
import { monthNumberFromHeader, roleForHeader } from '../lib/headers.mts'
import { studentIdText } from '../lib/student-ids.mts'
import { tableKey } from './source-keys.mts'

import type { ColumnRole } from '../lib/headers.mts'
import type { SheetBlock } from '../lib/blocks.mts'
import type { WorkSheet } from 'xlsx'

/**
 * Which half of a batch table a column sits in.
 *
 * `flat` is for tables with no ACTUAL/INSTALLMENT split at all — the ELCE
 * roster — where the distinction does not exist and must not be invented.
 */
export type ColumnSection = 'identity' | 'actual' | 'installment' | 'flat'

export interface SourceColumn {
  column: number
  letter: string
  /** Heading exactly as stored, trailing spaces and all. Null when unheaded. */
  header: string | null
  role: ColumnRole
  section: ColumnSection
  /** Month the heading names, when it names one. */
  month: number | null
  /** True when this heading was borrowed from an earlier table on the sheet. */
  inherited: boolean
}

export interface SourceCell {
  column: number
  letter: string
  ref: string
  /** SheetJS cell type: n number, s string, b boolean, e error, z stub. */
  cellType: string
  /** The stored value, untouched. */
  rawValue: string | number | boolean | null
  /** Excel's displayed text, when the file carries it. */
  text: string | null
  formula: string | null
  numberFormat: string | null
  isError: boolean
  isBlank: boolean
  /** The numeric value, or null when the cell is not a plain finite number. */
  numeric: number | null
}

export interface SourceErrorCell {
  ref: string
  letter: string
  row: number
  error: string
  formula: string | null
}

/** How a row inside a table's data span is treated. */
export type RowKind =
  /** Names a student: the only kind that becomes a student or finance record. */
  | 'student'
  /** No student, but money on it — the totals line most tables end with. */
  | 'totals'
  /** Neither. A stray row; imported as nothing, counted so it is not silent. */
  | 'other'

export interface SourceRow {
  /** 1-based row number in the sheet. */
  row: number
  cells: SourceCell[]
  cellByColumn: Map<number, SourceCell>
  /** Student number exactly as stored, trimmed. Null when absent or unusable. */
  studentNumber: string | null
  /** Set when a student number was refused, e.g. the cell held a spreadsheet error. */
  studentNumberRejected: string | null
  firstName: string | null
  middleName: string | null
  lastName: string | null
  /** A single-column name, where the sheet has one instead of parts. */
  fullName: string | null
  kind: RowKind
  errorCells: SourceErrorCell[]
}

export type TableKind = 'psw_batch' | 'cohort_roster' | 'transaction_master'

export interface SourceTable {
  sheetName: string
  /** Table title exactly as stored. Null for a sheet whose table has no title. */
  title: string | null
  titleRow: number | null
  headerRow: number | null
  firstDataRow: number | null
  lastDataRow: number | null
  /** Stable identity of this table within its sheet. */
  key: string
  kind: TableKind
  /**
   * Morning/Evening, only when the workbook structure says so in the title.
   * Null otherwise — never inferred from position on the sheet.
   */
  session: 'Morning' | 'Evening' | null
  columns: SourceColumn[]
  rows: SourceRow[]
  /** True when the table has an explicit scheduled-installment section. */
  hasInstallmentSection: boolean
}

/** Roles that identify a person rather than a figure. */
const NAME_ROLES: ColumnRole[] = ['first_name', 'middle_name', 'last_name', 'student_name']

/**
 * Roles that carry money, used to tell a totals line from an empty row.
 *
 * A row with no student on it but numbers in these columns is the trailing
 * total almost every batch table ends with.
 */
const MONEY_ROLES: ColumnRole[] = [
  'total_fee',
  'enrollment_fee',
  'month',
  'late_fees',
  'total_paid',
  'outstanding',
  'balance',
  'installment_ordinal',
]

function toSourceCell(sheet: WorkSheet, row: number, column: number): SourceCell | null {
  const cell = readCell(sheet, row - 1, column)
  if (!cell) return null

  return {
    column,
    letter: columnLetter(column),
    ref: cell.ref,
    cellType: String(cell.type),
    rawValue: (cell.value ?? null) as SourceCell['rawValue'],
    text: cell.text ?? null,
    formula: cell.formula ?? null,
    numberFormat: cell.numberFormat ?? null,
    isError: cell.isError === true,
    isBlank: isBlank(cell),
    numeric: numericValue(cell),
  }
}

/**
 * The session a title names, and only when it names one.
 *
 * "ONLY append Morning/Evening when the workbook structure explicitly
 * identifies the section that way" — so this reads the title text and returns
 * null for anything that does not say it outright. Position on the sheet is
 * never used: the second table being lower down is not evidence that it is the
 * evening cohort.
 */
export function sessionFromTitle(title: string | null): 'Morning' | 'Evening' | null {
  if (title === null) return null
  if (/\bmorning\b/i.test(title)) return 'Morning'
  if (/\bevening\b/i.test(title)) return 'Evening'
  return null
}

/**
 * Reads a student number, refusing anything that is not one.
 *
 * A cell holding `#REF!` renders as the text "#REF!", which would otherwise
 * sail through as a perfectly good-looking student number and create a student.
 * It is refused here, once, so no caller has to remember to.
 *
 * Nothing else is refused and nothing is cleaned up: a number carrying a stray
 * character is stored exactly as the workbook spells it.
 */
export function readStudentNumber(cell: SourceCell | null | undefined): {
  value: string | null
  rejected: string | null
} {
  if (!cell) return { value: null, rejected: null }
  if (cell.isError) {
    return { value: null, rejected: `error cell ${cell.text ?? String(cell.rawValue)}` }
  }

  const value = studentIdText({
    ref: cell.ref,
    type: cell.cellType as never,
    value: cell.rawValue as never,
    ...(cell.text === null ? {} : { text: cell.text }),
  })

  return { value, rejected: null }
}

/**
 * Assigns each column of a table to a section.
 *
 * The bounds come from the block detection in `lib/blocks.mts`, which
 * establishes them from the sheet's own banners and arithmetic. A table with no
 * split gets `flat` throughout rather than a section boundary invented for it.
 */
function buildColumns(block: SheetBlock): SourceColumn[] {
  const inherited = new Set(block.inheritedHeaders.map((header) => header.column))
  const actual = block.actualSection
  const installment = block.installmentSection
  const split = actual !== null || installment !== null

  return block.headers
    .map((header) => {
      let section: ColumnSection = 'flat'
      if (split) {
        if (installment && header.column >= installment.firstColumn) section = 'installment'
        else if (actual && header.column >= actual.firstColumn) section = 'actual'
        else section = 'identity'
      }

      return {
        column: header.column,
        letter: header.letter,
        header: header.original,
        role: roleForHeader(header.original),
        section,
        month: monthNumberFromHeader(header.original),
        inherited: inherited.has(header.column),
      }
    })
    .sort((a, b) => a.column - b.column)
}

/** The section an unheaded column falls in, from the table's own bounds. */
function sectionForUnheadedColumn(block: SheetBlock, column: number): ColumnSection {
  const { actualSection: actual, installmentSection: installment } = block
  if (installment && column >= installment.firstColumn) return 'installment'
  if (actual && column >= actual.firstColumn) return 'actual'
  if (actual || installment) return 'identity'
  return 'flat'
}

/**
 * Builds the importable view of one detected table.
 *
 * Rows are read across the table's full column span, including columns with no
 * heading, because an unheaded column still holds data that belongs in
 * legacy_raw_json.
 */
export function buildSourceTable(
  sheetName: string,
  sheet: WorkSheet,
  block: SheetBlock,
  kind: TableKind,
): SourceTable {
  const columns = buildColumns(block)

  const firstColumn = columns.length > 0 ? columns[0].column : 0
  const lastColumn = Math.max(
    block.installmentSection?.lastColumn ?? 0,
    block.actualSection?.lastColumn ?? 0,
    ...columns.map((column) => column.column),
  )

  const columnByIndex = new Map(columns.map((column) => [column.column, column]))

  const idColumn = columns.find((column) => column.role === 'student_id') ?? null
  const nameColumns = columns.filter((column) => NAME_ROLES.includes(column.role))
  const moneyColumns = columns.filter((column) => MONEY_ROLES.includes(column.role))

  const rows: SourceRow[] = []

  for (let row = block.firstDataRow ?? 0; row <= (block.lastDataRow ?? -1); row += 1) {
    const cells: SourceCell[] = []
    const cellByColumn = new Map<number, SourceCell>()
    const errorCells: SourceErrorCell[] = []

    for (let column = firstColumn; column <= lastColumn; column += 1) {
      const cell = toSourceCell(sheet, row, column)
      if (!cell) continue
      cells.push(cell)
      cellByColumn.set(column, cell)
      if (cell.isError) {
        errorCells.push({
          ref: cell.ref,
          letter: cell.letter,
          row,
          error: cell.text ?? String(cell.rawValue),
          formula: cell.formula,
        })
      }
    }

    const { value: studentNumber, rejected } = readStudentNumber(
      idColumn === null ? null : cellByColumn.get(idColumn.column),
    )

    const nameAt = (role: ColumnRole): string | null => {
      const column = nameColumns.find((candidate) => candidate.role === role)
      if (!column) return null
      const cell = cellByColumn.get(column.column)
      if (!cell || cell.isBlank || cell.isError) return null
      return cell.text ?? (cell.rawValue === null ? null : String(cell.rawValue))
    }

    const firstName = nameAt('first_name')
    const middleName = nameAt('middle_name')
    const lastName = nameAt('last_name')
    const fullName = nameAt('student_name')

    const hasName = [firstName, middleName, lastName, fullName].some(
      (part) => part !== null && part.trim() !== '',
    )

    const hasMoney = moneyColumns.some(
      (column) => cellByColumn.get(column.column)?.numeric !== null &&
        cellByColumn.get(column.column)?.numeric !== undefined,
    )

    const kindOfRow: RowKind =
      studentNumber !== null || hasName ? 'student' : hasMoney ? 'totals' : 'other'

    rows.push({
      row,
      cells,
      cellByColumn,
      studentNumber,
      studentNumberRejected: rejected,
      firstName,
      middleName,
      lastName,
      fullName,
      kind: kindOfRow,
      errorCells,
    })
  }

  // Unheaded columns carrying data are legitimate — the outstanding column is
  // unheaded on most sheets. They are described so legacy_raw_json can name
  // them, but they are never given a role they did not state.
  for (const row of rows) {
    for (const cell of row.cells) {
      if (columnByIndex.has(cell.column)) continue
      columnByIndex.set(cell.column, {
        column: cell.column,
        letter: cell.letter,
        header: null,
        role: 'unknown',
        section: sectionForUnheadedColumn(block, cell.column),
        month: null,
        inherited: false,
      })
    }
  }

  return {
    sheetName,
    title: block.title,
    titleRow: block.titleRow,
    headerRow: block.headerRow,
    firstDataRow: block.firstDataRow,
    lastDataRow: block.lastDataRow,
    key: tableKey(block.titleRow, block.headerRow),
    kind,
    session: sessionFromTitle(block.title),
    columns: [...columnByIndex.values()].sort((a, b) => a.column - b.column),
    rows,
    hasInstallmentSection: block.installmentSection !== null,
  }
}

/**
 * Every populated cell of a row, shaped for legacy_raw_json.
 *
 * Keyed by column letter and carrying the heading, the raw value, the displayed
 * text, the formula and the cell type — enough to reconstruct what the workbook
 * said without consulting the workbook. Blank cells are omitted rather than
 * stored as nulls, so a key's absence means "nothing was entered" and a stored
 * 0 keeps meaning zero.
 */
export function rowCellsForRawJson(
  table: SourceTable,
  row: SourceRow,
): Record<string, Record<string, unknown>> {
  const columnByIndex = new Map(table.columns.map((column) => [column.column, column]))
  const out: Record<string, Record<string, unknown>> = {}

  for (const cell of row.cells) {
    if (cell.isBlank && cell.formula === null && !cell.isError) continue
    const column = columnByIndex.get(cell.column)
    out[cell.letter] = {
      header: column?.header ?? null,
      section: column?.section ?? null,
      cell_type: cell.cellType,
      raw_value: cell.rawValue,
      formatted_text: cell.text,
      formula: cell.formula,
      is_error: cell.isError,
    }
  }

  return out
}
