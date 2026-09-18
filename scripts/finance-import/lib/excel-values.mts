/**
 * Reading cells without deciding what they mean.
 *
 * Two rules run through this module:
 *
 *  1. Blank is not zero. A cell that does not exist, and a cell containing 0,
 *     are different facts about a student's finances, and every helper here
 *     keeps them apart.
 *  2. The raw value survives. Interpretation (a serial read as a date, a
 *     number read as money) is always returned *alongside* the raw value,
 *     never in place of it.
 */

import * as XLSX from 'xlsx'

import type { CellObject, WorkSheet } from 'xlsx'

/** A cell captured verbatim, before anything is inferred from it. */
export interface RawCell {
  /** A1-style address, e.g. M14. */
  ref: string
  /** SheetJS cell type: b boolean, n number, e error, s string, d date, z stub. */
  type: CellObject['t']
  /** The stored value, untouched. undefined for a blank stub. */
  value: CellObject['v']
  /** Excel's formatted text for the cell, when the file carries one. */
  text?: string
  /** Formula source, without a leading equals sign. Absent for literal cells. */
  formula?: string
  /** Number format code, e.g. dd/mm/yyyy. */
  numberFormat?: string
  /** True when the cell holds an Excel error such as #REF!. */
  isError?: true
}

/** The spreadsheet errors worth naming in a report, by SheetJS error code. */
export const EXCEL_ERROR_NAMES: Record<number, string> = {
  0x00: '#NULL!',
  0x07: '#DIV/0!',
  0x0f: '#VALUE!',
  0x17: '#REF!',
  0x1d: '#NAME?',
  0x24: '#NUM!',
  0x2a: '#N/A',
}

export function excelErrorName(value: unknown): string {
  if (typeof value === 'number') return EXCEL_ERROR_NAMES[value] ?? `#UNKNOWN(${value})`
  if (typeof value === 'string') return value
  return '#UNKNOWN'
}

export function encodeCell(row: number, column: number): string {
  return XLSX.utils.encode_cell({ r: row, c: column })
}

export function columnLetter(column: number): string {
  return XLSX.utils.encode_col(column)
}

/**
 * Reads one cell verbatim.
 *
 * Returns null for a cell that is absent *or* a blank stub (type 'z'), which
 * are the same fact — nothing was entered — recorded two ways by Excel. A cell
 * holding 0 is not blank and comes back as a RawCell.
 */
export function readCell(sheet: WorkSheet, row: number, column: number): RawCell | null {
  const ref = encodeCell(row, column)
  const cell = sheet[ref] as CellObject | undefined

  if (!cell) return null
  if (cell.t === 'z' && cell.v === undefined && !cell.f) return null

  const raw: RawCell = { ref, type: cell.t, value: cell.v }

  if (typeof cell.w === 'string') raw.text = cell.w
  if (typeof cell.f === 'string' && cell.f.length > 0) raw.formula = cell.f
  if (typeof cell.z === 'string') raw.numberFormat = cell.z
  if (cell.t === 'e') raw.isError = true

  return raw
}

/**
 * True when a cell carries no value at all.
 *
 * An empty or whitespace-only string counts as blank for *presence* questions
 * ("did anyone fill this in?"). The raw value is still preserved by readCell;
 * this only answers the presence question.
 */
export function isBlank(cell: RawCell | null): boolean {
  if (!cell) return true
  if (cell.value === undefined || cell.value === null) return true
  if (typeof cell.value === 'string' && cell.value.trim() === '') return true
  return false
}

/** True when the cell holds the number zero, which is a value, not a blank. */
export function isExplicitZero(cell: RawCell | null): boolean {
  return cell?.type === 'n' && cell.value === 0
}

/**
 * The cell's text exactly as stored, with no trimming or case folding.
 *
 * Numbers are rendered via Excel's own formatted text (w) when present, so a
 * student number never picks up float noise or loses a leading zero on its way
 * into the analysis.
 */
export function rawText(cell: RawCell | null): string | null {
  if (!cell || cell.value === undefined || cell.value === null) return null
  if (typeof cell.value === 'string') return cell.value
  if (cell.type === 'e') return excelErrorName(cell.value)
  if (typeof cell.text === 'string' && cell.text.trim() !== '') return cell.text
  return String(cell.value)
}

/** The numeric value, or null when the cell is not a plain finite number. */
export function numericValue(cell: RawCell | null): number | null {
  if (!cell || cell.type !== 'n' || typeof cell.value !== 'number') return null
  return Number.isFinite(cell.value) ? cell.value : null
}

// -----------------------------------------------------------------------------
// Dates
// -----------------------------------------------------------------------------

/** Excel day 0 in the 1900 system is 1899-12-30 once the leap-year bug is allowed for. */
const EPOCH_1900_UTC = Date.UTC(1899, 11, 30)
/** The 1904 system counts from 1904-01-01. */
const EPOCH_1904_UTC = Date.UTC(1904, 0, 1)

const MS_PER_DAY = 86_400_000

/**
 * Serials at or below this sit inside Excel's fictional 1900-02-29 window,
 * where the stored serial and the real calendar disagree by a day.
 */
const LOTUS_BUG_SERIAL = 60

/**
 * Serials below this are far more likely to be a quantity than a date
 * (serial 1000 is 1902-09-26). Used only to *flag* a value as implausible.
 */
const IMPLAUSIBLE_BELOW = 1_000

/** Serial 73050 is 2099-12-31; anything beyond is almost certainly not a date. */
const IMPLAUSIBLE_ABOVE = 73_050

export type DateInterpretationStatus =
  /** A clean serial inside a plausible range. */
  | 'ok'
  /** Inside the 1900 leap-year bug window: the calendar date is ambiguous. */
  | 'ambiguous-1900-leap-bug'
  /** A real number, but outside any range a school date would fall in. */
  | 'implausible-range'
  /** Has a fractional part, i.e. carries a time of day as well as a date. */
  | 'has-time-component'
  /** Text, not a serial. Excel never parsed it as a date. */
  | 'not-a-serial'
  /** Nothing was entered. */
  | 'blank'

export interface DateInterpretation {
  /** The value exactly as the workbook stores it. Never rewritten. */
  raw: string | number | null
  /** YYYY-MM-DD when the serial could be read as a date, else null. */
  iso: string | null
  status: DateInterpretationStatus
}

/**
 * Converts an Excel serial to an ISO calendar day.
 *
 * Returns null rather than a guess for values that are not a usable serial,
 * including the 1900-02-29 window that exists in Excel but not in history.
 */
export function serialToISODate(serial: number, date1904 = false): string | null {
  if (!Number.isFinite(serial) || serial < 0) return null
  if (!date1904 && serial <= LOTUS_BUG_SERIAL) return null

  const epoch = date1904 ? EPOCH_1904_UTC : EPOCH_1900_UTC
  const days = Math.floor(serial)
  const date = new Date(epoch + days * MS_PER_DAY)

  if (Number.isNaN(date.getTime())) return null
  return date.toISOString().slice(0, 10)
}

/**
 * Interprets a date-like cell, keeping the raw value beside the reading.
 *
 * This never decides that a cell *is* a date — it reports how the stored value
 * reads if treated as one, and says when that reading is untrustworthy.
 */
export function interpretDateCell(cell: RawCell | null, date1904 = false): DateInterpretation {
  if (isBlank(cell) || !cell) return { raw: null, iso: null, status: 'blank' }

  const value = cell.value

  if (typeof value !== 'number') {
    return { raw: rawText(cell), iso: null, status: 'not-a-serial' }
  }

  if (!date1904 && value <= LOTUS_BUG_SERIAL) {
    return { raw: value, iso: null, status: 'ambiguous-1900-leap-bug' }
  }

  if (value < IMPLAUSIBLE_BELOW || value > IMPLAUSIBLE_ABOVE) {
    return { raw: value, iso: serialToISODate(value, date1904), status: 'implausible-range' }
  }

  const iso = serialToISODate(value, date1904)
  const hasTime = !Number.isInteger(value)

  return { raw: value, iso, status: hasTime ? 'has-time-component' : 'ok' }
}

/** True when the workbook uses the 1904 date system (Mac-era files). */
export function usesDate1904(workbook: {
  Workbook?: { WBProps?: { date1904?: boolean | number } }
}): boolean {
  return Boolean(workbook.Workbook?.WBProps?.date1904)
}
