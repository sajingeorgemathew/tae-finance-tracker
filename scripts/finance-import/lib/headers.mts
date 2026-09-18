/**
 * Header handling.
 *
 * Workbook headers are inconsistent on purpose-free grounds: trailing spaces
 * ("Student ID "), varied case ("Late fees" / "Late Fees"), and abbreviations
 * that change between sheets ("Sept" / "September"). Normalisation here exists
 * only so those spellings can be *recognised*. The original string is carried
 * beside the normalised form everywhere and is never rewritten, because the
 * exact header text is part of the audit trail stored in legacy_raw_json.
 */

/**
 * Lower-cased, whitespace-collapsed, punctuation-trimmed form of a header.
 *
 * Used for matching only. `normalizeHeader('Student ID ')` and
 * `normalizeHeader('student  id')` both give `student id`.
 */
export function normalizeHeader(header: string): string {
  return header
    .replace(/ /g, ' ')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.:]+$/, '')
    .toLowerCase()
}

/** A header as found, kept beside the form used for matching. */
export interface HeaderCell {
  /** Zero-based column index within the sheet. */
  column: number
  /** Column letter, for talking about the sheet in a report. */
  letter: string
  /** The header string exactly as the workbook stores it. Never altered. */
  original: string
  /** The matching form. Derived; the original is authoritative. */
  normalized: string
}

/**
 * Month names as they appear in the workbook, including the abbreviations
 * used on some sheets ("Sept", "Mar", "Aug"), mapped to a month number.
 *
 * A month column tells us *which* month a figure belongs to. It says nothing
 * about whether the figure is money received or money expected — that comes
 * from which section the column sits in. See `blocks.ts`.
 */
export const MONTH_NUMBERS: Record<string, number> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sept: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
}

/** The month a header names, or null when it does not name one. */
export function monthNumberFromHeader(header: string): number | null {
  return MONTH_NUMBERS[normalizeHeader(header)] ?? null
}

/**
 * Canonical roles a column can be recognised as.
 *
 * `unknown` is a legitimate outcome and is reported as such: an unrecognised
 * column is a finding, not something to force into the nearest bucket.
 */
export type ColumnRole =
  | 'serial_number'
  | 'student_id'
  | 'first_name'
  | 'middle_name'
  | 'last_name'
  | 'student_name'
  | 'payer'
  | 'graduated'
  | 'start_date'
  | 'date_yyyymmdd'
  | 'schedule_type'
  | 'total_fee'
  | 'enrollment_fee'
  | 'month'
  | 'late_fees'
  | 'total_paid'
  | 'outstanding'
  | 'remarks'
  | 'discount'
  | 'installment_ordinal'
  | 'payment_number'
  | 'batch'
  | 'amount_paid'
  | 'paid_date'
  | 'payment_method'
  | 'receipt_sent'
  | 'program'
  | 'balance'
  | 'unknown'

/** Exact normalised header text to role. Matching is never fuzzy. */
const HEADER_ROLES: Record<string, ColumnRole> = {
  'sr. no': 'serial_number',
  'sr no': 'serial_number',
  'student id': 'student_id',
  'first name': 'first_name',
  'middle name': 'middle_name',
  'last name': 'last_name',
  'student name': 'student_name',
  payer: 'payer',
  payee: 'payer',
  graduated: 'graduated',
  'start date': 'start_date',
  'yyyy/mm/dd': 'date_yyyymmdd',
  'wkd/wknd': 'schedule_type',
  'total fee': 'total_fee',
  'total fees': 'total_fee',
  'enroll. fee': 'enrollment_fee',
  'enroll fee': 'enrollment_fee',
  'enrollment fee': 'enrollment_fee',
  'enrollment fees': 'enrollment_fee',
  'enrollment total fees': 'total_fee',
  'late fees': 'late_fees',
  'late fee': 'late_fees',
  'total paid': 'total_paid',
  outstanding: 'outstanding',
  balance: 'balance',
  'balance fees': 'balance',
  remarks: 'remarks',
  'vikas remarks': 'remarks',
  discount: 'discount',
  '1st installment': 'installment_ordinal',
  '2nd installment': 'installment_ordinal',
  '3rd installment': 'installment_ordinal',
  'payment no': 'payment_number',
  batch: 'batch',
  'amount paid': 'amount_paid',
  'paid date': 'paid_date',
  'mode of payment': 'payment_method',
  'receipt sent': 'receipt_sent',
  program: 'program',
}

/**
 * The role a header names, by exact match on the normalised form.
 *
 * Month names resolve to `month`; anything unrecognised resolves to `unknown`
 * so it shows up in the report rather than disappearing.
 */
export function roleForHeader(header: string): ColumnRole {
  const normalized = normalizeHeader(header)
  if (normalized === '') return 'unknown'
  if (HEADER_ROLES[normalized]) return HEADER_ROLES[normalized]
  if (MONTH_NUMBERS[normalized] !== undefined) return 'month'
  return 'unknown'
}

/** Headers whose presence marks a row as a table header rather than data. */
const HEADER_ROW_MARKERS = new Set([
  'sr. no',
  'sr no',
  'student id',
  'student name',
  'total fee',
  'total fees',
  'enroll. fee',
  'enrollment fees',
  'total paid',
  'first name',
  'last name',
  'payment no',
  'amount paid',
])

/**
 * True when a row's strings look like column headings.
 *
 * Deliberately a count rather than a single sentinel: on some sheets the
 * evening block's header row omits "Sr. No." and starts at "Total Fee", and on
 * others the block title and the headings share one row.
 */
export function looksLikeHeaderRow(values: readonly (string | null)[], minimumMarkers = 2): boolean {
  let markers = 0
  for (const value of values) {
    if (typeof value !== 'string') continue
    if (HEADER_ROW_MARKERS.has(normalizeHeader(value))) markers += 1
  }
  return markers >= minimumMarkers
}
