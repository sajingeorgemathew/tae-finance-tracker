/**
 * Reading a batch row's preserved workbook cells.
 *
 * FINANCE-IMPORT-02 deliberately did *not* import the batch sheets' ACTUAL
 * section as payments — Tracker Master is the transaction source, and importing
 * both would count the same money twice. Those cells survive only inside
 * `student_finance_records.legacy_raw_json`, and this module is what turns them
 * back into the columns senior staff used to read in Excel.
 *
 * Three consequences of how the importer stored them shape everything here:
 *
 * 1. **Blank cells were omitted, not stored as null.** A key's absence means
 *    nothing was entered. So a batch's column list is the *union* of the
 *    letters present across its rows — a column every row left empty cannot be
 *    recovered and is not displayed. That is a real limitation, documented in
 *    docs/FINANCE-GRID-03.md, and it is preferable to inventing a column.
 * 2. **Only `header` and `section` were kept per cell, not the column's role.**
 *    A table with an ACTUAL/INSTALLMENT split marks its money columns
 *    `'actual'`, so the whole section can be shown. A table with no split (the
 *    ECEA roster) marks everything `'flat'`, identity columns included, so
 *    there the headings themselves have to say which columns hold money.
 * 3. **Column letters are the source order.** They are ordered by spreadsheet
 *    position, not alphabetically — `Z` comes before `AA`.
 *
 * Nothing here recalculates, reconciles or corrects a value.
 */

import { BLANK_MONEY, moneyFromNumber, type MoneyCell } from './money.ts'

/** A preserved cell, exactly as `rowCellsForRawJson` wrote it. */
export interface LegacyCell {
  header: string | null
  section: string | null
  cell_type: string | null
  raw_value: string | number | boolean | null
  formatted_text: string | null
  formula: string | null
  is_error: boolean
}

/** `legacy_raw_json` on a batch-sourced `student_finance_records` row. */
export interface LegacyRecordJson {
  sheet?: unknown
  block_title?: unknown
  table_key?: unknown
  session?: unknown
  row?: unknown
  cells?: unknown
}

/** One displayed historical column, resolved for a whole batch. */
export interface LegacyColumn {
  /** Stable key for React and for the per-row cell map. */
  key: string
  /** Spreadsheet column letter, kept so a figure can be traced to its cell. */
  letter: string
  /** Position in the sheet, which is the display order. */
  index: number
  /** The heading, trimmed for display. Never rewritten. */
  label: string
  /** True when the workbook never headed this column. */
  unheaded: boolean
}

/**
 * Headings that name money, normalised.
 *
 * Mirrors the monetary entries of `HEADER_ROLES` in
 * `scripts/finance-import/lib/headers.mts`. Kept as its own list rather than
 * imported, because the importer's module is Node-only tooling and this one
 * renders in the browser — but the two must be changed together, and a heading
 * missing here shows up as a column absent from an ECEA-shaped batch.
 */
const MONEY_HEADERS = new Set([
  'total fee',
  'total fees',
  'enroll. fee',
  'enroll fee',
  'enrollment fee',
  'enrollment fees',
  'enrollment total fees',
  'late fees',
  'late fee',
  'total paid',
  'outstanding',
  'balance',
  'balance fees',
  'discount',
  'amount paid',
  '1st installment',
  '2nd installment',
  '3rd installment',
])

/** Month spellings the workbook uses, including its abbreviations. */
const MONTH_HEADERS = new Set([
  'january',
  'jan',
  'february',
  'feb',
  'march',
  'mar',
  'april',
  'apr',
  'may',
  'june',
  'jun',
  'july',
  'jul',
  'august',
  'aug',
  'september',
  'sept',
  'sep',
  'october',
  'oct',
  'november',
  'nov',
  'december',
  'dec',
])

/**
 * Matching form of a heading: lower-cased, whitespace-collapsed, trailing
 * punctuation removed. The original is what gets displayed.
 */
export function normalizeHeader(header: string): string {
  return header
    .replace(/ /g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.:]+$/, '')
    .toLowerCase()
}

/** True when a heading names a fee, a payment total or a month. */
export function headerNamesMoney(header: string | null): boolean {
  if (header === null) return false
  const normalized = normalizeHeader(header)
  if (normalized === '') return false
  return MONEY_HEADERS.has(normalized) || MONTH_HEADERS.has(normalized)
}

/**
 * `'A'` -> 1, `'Z'` -> 26, `'AA'` -> 27.
 *
 * Needed because column letters sort wrongly as strings: `'AA' < 'B'`
 * alphabetically, but column AA sits far to the right of column B. Returns
 * `Number.MAX_SAFE_INTEGER` for anything that is not a column letter, so an
 * unrecognised key sorts last instead of colliding with column A.
 */
export function columnLetterIndex(letter: string): number {
  if (!/^[A-Za-z]{1,3}$/.test(letter)) return Number.MAX_SAFE_INTEGER

  let index = 0
  for (const character of letter.toUpperCase()) {
    index = index * 26 + (character.charCodeAt(0) - 64)
  }
  return index
}

/** The cell map of a record's `legacy_raw_json`, or an empty map. */
export function legacyCellsOf(raw: unknown): Record<string, LegacyCell> {
  if (raw === null || typeof raw !== 'object') return {}
  const cells = (raw as LegacyRecordJson).cells
  if (cells === null || typeof cells !== 'object' || Array.isArray(cells)) return {}
  return cells as Record<string, LegacyCell>
}

/**
 * Whether a preserved cell belongs in the historical money section.
 *
 * `actual` is the ACTUAL FEE STRUCTURE half of a split batch table and is money
 * throughout, unheaded reconciliation columns included. `flat` is a table with
 * no split, where identity, dates and text sit in the same section as the
 * figures — so there, and only there, the heading has to name money. `identity`
 * and `installment` are excluded: the first is not money, and the second is
 * rendered from normalized installments instead.
 */
export function isHistoricalMoneyCell(cell: LegacyCell): boolean {
  if (cell.section === 'actual') return true
  if (cell.section === 'flat') return headerNamesMoney(cell.header)
  return false
}

/**
 * The historical money columns of a batch, in spreadsheet order.
 *
 * Built from every row together, because the importer omitted blank cells: a
 * column a student left empty is simply absent from that student's map, and
 * only the union across the batch shows the shape of the table.
 *
 * The first heading seen for a letter wins. Headings are inherited down a sheet
 * by the importer, so they do not disagree within one table; if they ever did,
 * taking the first keeps the column list stable rather than letting row order
 * decide the heading.
 */
export function resolveHistoricalColumns(rawJsonByRecord: readonly unknown[]): LegacyColumn[] {
  const byLetter = new Map<string, LegacyColumn>()

  for (const raw of rawJsonByRecord) {
    for (const [letter, cell] of Object.entries(legacyCellsOf(raw))) {
      if (byLetter.has(letter)) continue
      if (!isHistoricalMoneyCell(cell)) continue

      const header = cell.header?.trim() ?? ''
      byLetter.set(letter, {
        key: `actual:${letter}`,
        letter,
        index: columnLetterIndex(letter),
        // An unheaded column is named by its cell reference rather than given a
        // heading the workbook never had.
        label: header === '' ? `Column ${letter}` : header,
        unheaded: header === '',
      })
    }
  }

  return [...byLetter.values()].sort((a, b) => a.index - b.index)
}

/**
 * One preserved cell as a money value.
 *
 * An error cell keeps the text Excel showed (`#REF!`) rather than becoming a
 * blank, so a staff member sees that the workbook itself holds an error there.
 * A string cell is shown as typed. A blank stays blank.
 */
export function legacyCellToMoney(cell: LegacyCell | undefined): MoneyCell {
  if (!cell) return BLANK_MONEY

  if (cell.is_error) {
    const text = cell.formatted_text ?? (cell.raw_value === null ? null : String(cell.raw_value))
    return { kind: 'error', text: text ?? '#ERROR' }
  }

  const value = cell.raw_value

  if (typeof value === 'number') return moneyFromNumber(value)

  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed === '') return BLANK_MONEY
    const parsed = Number(trimmed)
    return Number.isFinite(parsed) ? moneyFromNumber(parsed) : { kind: 'text', text: trimmed }
  }

  if (typeof value === 'boolean') return { kind: 'text', text: String(value) }

  return BLANK_MONEY
}

/**
 * The resolved columns of one record, keyed the same way as the column list.
 *
 * Accepts any column that knows its key and its source letter — a manifest
 * column or a derived one. A column with no letter (an application-defined
 * column with no spreadsheet behind it) has no preserved cell to read and is
 * blank for every historical row.
 */
export function historicalCellsForRecord(
  raw: unknown,
  columns: readonly { key: string; letter: string | null }[],
): Record<string, MoneyCell> {
  const cells = legacyCellsOf(raw)
  const out: Record<string, MoneyCell> = {}

  for (const column of columns) {
    out[column.key] = column.letter === null ? BLANK_MONEY : legacyCellToMoney(cells[column.letter])
  }

  return out
}

/** True when any preserved cell on the row holds a spreadsheet error. */
export function rowHasErrorCell(raw: unknown): boolean {
  return Object.values(legacyCellsOf(raw)).some((cell) => cell.is_error === true)
}
