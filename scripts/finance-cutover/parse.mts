/**
 * Reading the replacement finance workbook into launch cohorts.
 *
 * The importer's block detection and table builder (FINANCE-IMPORT-02) already
 * read these sheet shapes correctly — the PSW ACTUAL/INSTALLMENT split, the
 * unheaded balance column, the flat ELCE roster — and are reused unchanged.
 * What this module adds is the part the old import never needed because the
 * old workbook never had it, or because Tracker Master carried the payments:
 *
 *  * **Row classification that tells seats from totals.** The old builder
 *    calls any identity-less row with a number on it a totals line. On this
 *    workbook that also catches *placeholder seats* (a serial number and a
 *    template fee, nobody named) and `#REF!` rows whose only numbers are
 *    formula results. A totals row is now recognised by what it is — a
 *    formula summing *down* its own column — and the others are named for
 *    what they are.
 *  * **Rows below the totals line.** A table ends at its totals row. Text
 *    typed underneath it (referral notes, first names with no figures) is not
 *    a student of that table.
 *  * **Numeric values in name columns.** A number sitting in a Last Name cell
 *    is not a name. It is reported and kept verbatim in provenance, never
 *    stored as a name part and never read as money.
 *  * **Cells past the last heading.** The old builder reads up to the last
 *    headed column; a note typed further right was invisible to it. Those
 *    cells are captured, reported and preserved — never read as payments.
 *
 * Nothing here manufactures a value: a blank stays blank, an error stays an
 * error, and a student number stays text.
 */

import * as XLSX from 'xlsx'

import { classifySheet } from '../finance-import/lib/classify.mts'
import { findBlocks } from '../finance-import/lib/blocks.mts'
import { columnLetter, readCell } from '../finance-import/lib/excel-values.mts'
import { parseSimpleSumRange } from '../finance-import/lib/formulas.mts'
import { proposedBatchName } from '../finance-import/importer/batches.mts'
import { buildSourceTable, type SourceCell, type SourceRow, type SourceTable } from '../finance-import/importer/source-tables.mts'
import { isSensitiveHeading, normalizeHeading } from '../finance-contact/canonical.mts'
import { parseTitleDate } from '../finance-contact/adapters/title-date.mts'

import { PROGRAM_PATTERNS, TARGET_COHORTS, type CohortDeclaration } from './config.mts'

import type { WorkBook, WorkSheet } from 'xlsx'

export type RowClass =
  /** Names or numbers a student: the only class that becomes a finance record. */
  | 'student'
  /** A formula row summing down the table's own columns. */
  | 'totals'
  /** A serial number and a typed figure (a template fee), but nobody named or numbered. */
  | 'placeholder_seat'
  /** No identity and no typed figure: a serial number, a formula result, an error. */
  | 'empty_seat'
  /** Below the table's totals row: not part of the table. */
  | 'below_table'

export interface MisplacedValue {
  letter: string
  header: string | null
  value: string | number | boolean | null
  reason: string
}

export interface OffTableCell {
  letter: string
  ref: string
  cellType: string
  rawValue: string | number | boolean | null
  text: string | null
  formula: string | null
}

export interface ClassifiedRow {
  row: number
  rowClass: RowClass
  reason: string
  source: SourceRow
  /** Name parts with any numeric-only part removed (see `misplaced`). */
  firstName: string | null
  middleName: string | null
  lastName: string | null
  studentNumber: string | null
  named: boolean
  numbered: boolean
  misplaced: MisplacedValue[]
  offTableCells: OffTableCell[]
}

export interface SourceTotal {
  letter: string
  header: string | null
  value: number | null
  formula: string | null
  /** The rows the totals formula covers, when it is a plain SUM down the column. */
  coversRows: { first: number; last: number } | null
}

export interface ParsedTable {
  sheetName: string
  table: SourceTable
  programShortCode: string
  sourceProgramLabel: string
  /** `YYYY-MM` for a dated PSW table; null for a roster. */
  yearMonth: string | null
  yearMonthEvidence: string
  /** `YYYY-MM-DD` when the title states day, month and year. */
  startDate: string | null
  startDateEvidence: string
  batchName: string
  cohort: CohortDeclaration | null
  rows: ClassifiedRow[]
  totalsRow: number | null
  sourceTotals: SourceTotal[]
  /** Columns whose heading names something that must never be imported (e.g. a date of birth). */
  redactedColumns: { letter: string; header: string }[]
}

export interface ParsedWorkbook {
  sheetNames: string[]
  tables: ParsedTable[]
  /** Sheets that hold no recognisable cohort table. */
  unrecognizedSheets: { sheetName: string; classification: string }[]
  /** Recognised tables that are not a launch cohort. */
  outOfScopeTables: { sheetName: string; title: string | null; programShortCode: string; yearMonth: string | null }[]
}

/** A sheet is the cutover workbook's kind when it holds cohort tables and no Tracker Master. */
export interface WorkbookRecognition {
  recognized: boolean
  reason: string
}

export function recognizeCutoverWorkbook(workbook: WorkBook): WorkbookRecognition {
  if (workbook.SheetNames.includes('Tracker Master')) {
    return {
      recognized: false,
      reason: 'carries a Tracker Master sheet: that is the superseded historical workbook (FINANCE-IMPORT-02)',
    }
  }
  let pswSheets = 0
  let rosterSheets = 0
  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const ref = sheet['!ref']
    const blocks = ref ? findBlocks(sheet, XLSX.utils.decode_range(ref)) : []
    const { classification } = classifySheet(sheetName, blocks)
    if (classification === 'psw_batch') pswSheets += 1
    if (classification === 'other_program_batch') rosterSheets += 1
  }
  if (pswSheets === 0) return { recognized: false, reason: 'no PSW batch sheet with an ACTUAL/INSTALLMENT table' }
  return {
    recognized: true,
    reason: `${pswSheets} PSW batch sheet(s) and ${rosterSheets} program roster sheet(s), no Tracker Master`,
  }
}

function resolveProgram(sheetName: string, title: string | null): { shortCode: string; sourceLabel: string } | null {
  const haystack = `${sheetName} ${title ?? ''}`
  for (const entry of PROGRAM_PATTERNS) {
    if (entry.pattern.test(haystack)) return { shortCode: entry.shortCode, sourceLabel: entry.sourceLabel }
  }
  return null
}

/**
 * The month a table belongs to: the sheet's own name first (that is how the
 * intake UI groups and labels sheets), then the table title.
 */
export function cohortMonthOf(sheetName: string, title: string | null): { yearMonth: string | null; evidence: string } {
  const fromSheet = parseTitleDate(sheetName).yearMonth
  if (fromSheet !== null) return { yearMonth: fromSheet, evidence: `sheet name ${JSON.stringify(sheetName)}` }
  const fromTitle = title === null ? null : parseTitleDate(title).yearMonth
  if (fromTitle !== null) return { yearMonth: fromTitle, evidence: `table title ${JSON.stringify(title)}` }
  return { yearMonth: null, evidence: 'neither the sheet name nor the title states a month and year' }
}

function cellText(cell: SourceCell | undefined): string | null {
  if (!cell || cell.isBlank || cell.isError) return null
  return cell.text ?? (cell.rawValue === null ? null : String(cell.rawValue))
}

/** A vertical `SUM(X5:X19)` in column X: the table's own totals line. */
function verticalSumRange(cell: SourceCell): { first: number; last: number } | null {
  if (cell.formula === null) return null
  const range = parseSimpleSumRange(cell.formula)
  if (range === null || range.firstColumn !== range.lastColumn || range.firstLetter !== cell.letter) return null
  const rows = /^SUM\(\$?[A-Z]{1,3}\$?(\d+):\$?[A-Z]{1,3}\$?(\d+)\)$/i.exec(cell.formula.trim())
  if (!rows) return null
  return { first: Number(rows[1]), last: Number(rows[2]) }
}

function isTotalsRow(row: SourceRow): boolean {
  return row.cells.some((cell) => verticalSumRange(cell) !== null)
}

/** True when a cell holds a typed figure (not a formula result, not an error). */
function hasTypedNumber(cell: SourceCell): boolean {
  return cell.numeric !== null && cell.formula === null && !cell.isError
}

function offTableCellsOf(sheet: WorkSheet, table: SourceTable, rowNumber: number): OffTableCell[] {
  const ref = sheet['!ref']
  if (!ref) return []
  const lastSheetColumn = XLSX.utils.decode_range(ref).e.c
  const lastTableColumn = Math.max(...table.columns.map((column) => column.column))
  const out: OffTableCell[] = []
  for (let column = lastTableColumn + 1; column <= lastSheetColumn; column += 1) {
    const cell = readCell(sheet, rowNumber - 1, column)
    if (!cell) continue
    if (cell.value === undefined || cell.value === null || (typeof cell.value === 'string' && cell.value.trim() === '')) continue
    // A formula right of the schedule is the sheet's own reconciliation
    // (`SUM(S5:X5)-R5`), structure rather than a note somebody typed.
    if (cell.formula !== undefined) continue
    out.push({
      letter: columnLetter(column),
      ref: cell.ref,
      cellType: String(cell.type),
      rawValue: cell.value as OffTableCell['rawValue'],
      text: cell.text ?? null,
      formula: cell.formula ?? null,
    })
  }
  return out
}

const NAME_ROLES = new Set(['first_name', 'middle_name', 'last_name', 'student_name'])

/** Roles that carry money on a flat roster, where every column is `flat`. */
export const FLAT_MONEY_ROLES = new Set([
  'total_fee',
  'enrollment_fee',
  'installment_ordinal',
  'late_fees',
  'month',
  'total_paid',
  'balance',
  'outstanding',
  'discount',
  'amount_paid',
])

/** Identity text columns where a bare number is evidence of a misplaced value. */
const IDENTITY_TEXT_ROLES = new Set(['first_name', 'middle_name', 'last_name', 'student_name', 'payer', 'start_date'])

/**
 * Classifies every row of one table.
 *
 * Exported for tests: the rules are the substance of this module and they are
 * exercised against hand-built sheets, because the real workbook cannot be
 * committed.
 */
export function classifyRows(sheet: WorkSheet, table: SourceTable): { rows: ClassifiedRow[]; totalsRow: number | null } {
  const columnByIndex = new Map(table.columns.map((column) => [column.column, column]))
  const totals = table.rows.find((row) => isTotalsRow(row) && row.studentNumber === null)
  const totalsRow = totals?.row ?? null

  const rows = table.rows.map((source): ClassifiedRow => {
    const misplaced: MisplacedValue[] = []
    const namePart = (role: string): string | null => {
      const column = table.columns.find((candidate) => candidate.role === role)
      if (!column) return null
      const cell = source.cellByColumn.get(column.column)
      if (!cell || cell.isBlank || cell.isError) return null
      return cell.cellType === 'n' ? null : cellText(cell)
    }

    for (const cell of source.cells) {
      const column = columnByIndex.get(cell.column)
      if (!column || !IDENTITY_TEXT_ROLES.has(column.role)) continue
      if (cell.cellType !== 'n' || cell.isBlank) continue
      // A start date stored as a real serial is a date, not a misplaced value.
      if (column.role === 'start_date' && typeof cell.rawValue === 'number' && cell.rawValue >= 1000) continue
      misplaced.push({
        letter: cell.letter,
        header: column.header,
        value: cell.rawValue,
        reason: NAME_ROLES.has(column.role)
          ? 'a number in a name column is not a name; kept in provenance, not stored as a name part'
          : 'a number in an identity text column; kept in provenance, not interpreted',
      })
    }

    const firstName = namePart('first_name') ?? namePart('student_name')
    const middleName = namePart('middle_name')
    const lastName = namePart('last_name')
    const named = [firstName, middleName, lastName].some((part) => part !== null && part.trim() !== '')
    const numbered = source.studentNumber !== null

    const base = {
      row: source.row,
      source,
      firstName,
      middleName,
      lastName,
      studentNumber: source.studentNumber,
      named,
      numbered,
      misplaced,
      offTableCells: offTableCellsOf(sheet, table, source.row),
    }

    if (totalsRow !== null && source.row > totalsRow) {
      return { ...base, rowClass: 'below_table', reason: `below the table's totals row ${totalsRow}; not part of the table` }
    }
    if (source.row === totalsRow) {
      return { ...base, rowClass: 'totals', reason: 'formula row summing down its own columns' }
    }
    if (named || numbered) {
      return { ...base, rowClass: 'student', reason: numbered ? 'states a student number' : 'names a student without a number' }
    }

    const moneyColumns = new Set(
      table.columns
        .filter((column) => column.section === 'actual' || (column.section === 'flat' && FLAT_MONEY_ROLES.has(column.role)))
        .map((column) => column.column),
    )
    const typed = source.cells.some((cell) => moneyColumns.has(cell.column) && hasTypedNumber(cell))
    if (typed) {
      return { ...base, rowClass: 'placeholder_seat', reason: 'a typed figure with nobody named or numbered (an unfilled seat)' }
    }
    return { ...base, rowClass: 'empty_seat', reason: 'no identity and no typed figure' }
  })

  return { rows, totalsRow }
}

function sourceTotalsOf(table: SourceTable, totalsRow: number | null): SourceTotal[] {
  if (totalsRow === null) return []
  const row = table.rows.find((candidate) => candidate.row === totalsRow)
  if (!row) return []
  const columnByIndex = new Map(table.columns.map((column) => [column.column, column]))
  return row.cells
    .filter((cell) => !cell.isBlank)
    .map((cell) => ({
      letter: cell.letter,
      header: columnByIndex.get(cell.column)?.header ?? null,
      value: cell.numeric,
      formula: cell.formula,
      coversRows: verticalSumRange(cell),
    }))
}

function redactedColumnsOf(table: SourceTable): { letter: string; header: string }[] {
  return table.columns
    .filter((column) => column.header !== null && isSensitiveHeading(normalizeHeading(column.header)))
    .map((column) => ({ letter: column.letter, header: column.header as string }))
}

function matchCohort(programShortCode: string, yearMonth: string | null): CohortDeclaration | null {
  const candidates = TARGET_COHORTS.filter(
    (cohort) =>
      cohort.source === 'workbook' &&
      cohort.programShortCode === programShortCode &&
      (cohort.yearMonth === null || cohort.yearMonth === yearMonth),
  )
  return candidates.length === 1 ? candidates[0] : null
}

/** Reads every cohort table of the workbook. Pure apart from reading the in-memory workbook. */
export function parseCutoverWorkbook(workbook: WorkBook): ParsedWorkbook {
  const tables: ParsedTable[] = []
  const unrecognizedSheets: ParsedWorkbook['unrecognizedSheets'] = []
  const outOfScopeTables: ParsedWorkbook['outOfScopeTables'] = []

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName]
    const ref = sheet['!ref']
    const blocks = ref ? findBlocks(sheet, XLSX.utils.decode_range(ref)) : []
    const { classification } = classifySheet(sheetName, blocks)

    if (classification !== 'psw_batch' && classification !== 'other_program_batch') {
      unrecognizedSheets.push({ sheetName, classification })
      continue
    }

    for (const block of blocks) {
      const table = buildSourceTable(sheetName, sheet, block, classification === 'psw_batch' ? 'psw_batch' : 'cohort_roster')
      const program = resolveProgram(sheetName, table.title)
      if (program === null) {
        unrecognizedSheets.push({ sheetName, classification: `${classification} with no recognisable program` })
        continue
      }

      const dated = program.shortCode === 'PSW'
      const month = dated ? cohortMonthOf(sheetName, table.title) : { yearMonth: null, evidence: 'program-wide roster; no intake month' }
      const titleDate = table.title === null ? null : parseTitleDate(table.title).isoDate
      const cohort = matchCohort(program.shortCode, month.yearMonth)

      if (cohort === null) {
        outOfScopeTables.push({ sheetName, title: table.title, programShortCode: program.shortCode, yearMonth: month.yearMonth })
        continue
      }

      const { rows, totalsRow } = classifyRows(sheet, table)

      tables.push({
        sheetName,
        table,
        programShortCode: program.shortCode,
        sourceProgramLabel: program.sourceLabel,
        yearMonth: month.yearMonth,
        yearMonthEvidence: month.evidence,
        startDate: dated ? titleDate : null,
        startDateEvidence: dated
          ? titleDate === null
            ? 'the title does not state day, month and year'
            : `day, month and year read from the title ${JSON.stringify(table.title)}`
          : 'program-wide roster; no start date stated for the table',
        batchName: proposedBatchName(table),
        cohort,
        rows,
        totalsRow,
        sourceTotals: sourceTotalsOf(table, totalsRow),
        redactedColumns: redactedColumnsOf(table),
      })
    }
  }

  return { sheetNames: [...workbook.SheetNames], tables, unrecognizedSheets, outOfScopeTables }
}

/** The rows of a table that become students. */
export function studentRows(table: ParsedTable): ClassifiedRow[] {
  return table.rows.filter((row) => row.rowClass === 'student')
}

/** Rows counted as "named": a student row with at least one name part. */
export function namedRows(table: ParsedTable): ClassifiedRow[] {
  return studentRows(table).filter((row) => row.named)
}
