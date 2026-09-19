/**
 * Deterministic source keys — the importer's idempotency primitive.
 *
 * Every planned entity carries a key derived only from the workbook it came
 * from and where in that workbook it sits. Nothing in a key depends on the
 * order rows were processed in, on a generated id, or on the clock, so two runs
 * over the same file produce byte-identical keys and a re-run can recognise
 * what it already created.
 *
 * The workbook SHA-256 is the first component of every key. A different file is
 * therefore a different key space, which is the point: `legacy_source_row` only
 * means something relative to one exact file, and silently reusing row numbers
 * across two versions of a workbook is how an import corrupts history.
 *
 * Parts are escaped before joining, so a sheet named `A|B` and a sheet named
 * `A` followed by a part `B` cannot collide. This is the only reason the
 * escaping exists — the keys are opaque identifiers, not display strings.
 */

/** Separator between key parts. Escaped out of the parts themselves. */
const SEPARATOR = '|'

/**
 * Escapes a single key part so the join is unambiguous.
 *
 * Backslash first, then the separator: doing it the other way round would
 * double-escape the backslash introduced by the separator.
 */
function escapePart(part: string): string {
  return part.replace(/\\/g, '\\\\').replace(/\|/g, '\\|')
}

/**
 * Joins key parts into one deterministic string.
 *
 * Numbers are rendered through `String`, so a row number is always the same
 * text for the same row. `null` is rendered as an explicit empty part rather
 * than being dropped, because "no value here" is itself part of the identity —
 * an unresolved student with no student number must not key the same as one
 * where the part was simply absent.
 */
export function sourceKey(...parts: (string | number | null)[]): string {
  return parts.map((part) => escapePart(part === null ? '' : String(part))).join(SEPARATOR)
}

/**
 * The identity of one detected table inside a sheet.
 *
 * A sheet is not a batch: every dated PSW sheet holds a Morning and an Evening
 * table. The title row is what separates them, and it is stable for a given
 * file, so it is what identifies the table. Tables with no title (the ELCE
 * roster) fall back to their header row, which is equally stable.
 */
export function tableKey(titleRow: number | null, headerRow: number | null): string {
  if (titleRow !== null) return `title@${titleRow}`
  if (headerRow !== null) return `header@${headerRow}`
  return 'table@unknown'
}

/** workbook hash + sheet + detected table key. */
export function batchSourceKey(hash: string, sheet: string, table: string): string {
  return sourceKey(hash, 'batch', sheet, table)
}

/**
 * workbook hash + student number.
 *
 * Keyed on the exact student number and nothing else, because that is the
 * identity rule: one student number is one student, whatever names the sheets
 * spell against it.
 */
export function studentSourceKey(hash: string, studentNumber: string): string {
  return sourceKey(hash, 'student', studentNumber)
}

/**
 * workbook hash + sheet + detected table key + source row.
 *
 * A row with no student number gets an identity derived from the row itself, so
 * two such rows never merge — not even when the names look alike.
 *
 * The table key is included because a batch sheet holds two tables and both can
 * carry a number-less row; `null` for a flat sheet such as Tracker Master,
 * which has only one.
 */
export function unresolvedStudentSourceKey(
  hash: string,
  sheet: string,
  table: string | null,
  row: number,
): string {
  return sourceKey(hash, 'unresolved-student', sheet, table, row)
}

/**
 * workbook hash + entity type + sheet + source row + source column.
 *
 * Its own key space, separate from the entity the row would have become. A row
 * preserved as an exception because it has no amount may later be corrected
 * into a real payment, and the payment's key must not already be taken by the
 * exception that stood in for it.
 */
export function importExceptionSourceKey(
  hash: string,
  entityType: string,
  sheet: string,
  row: number | null,
  column: string | null,
): string {
  return sourceKey(hash, 'import-exception', entityType, sheet, row, column)
}

/** workbook hash + sheet + source row + detected table key. */
export function financeRecordSourceKey(
  hash: string,
  sheet: string,
  row: number,
  table: string,
): string {
  return sourceKey(hash, 'finance-record', sheet, row, table)
}

/**
 * workbook hash + student key + program, for a record with no batch.
 *
 * Tracker Master payments that cannot be tied to exactly one batch table share
 * one unassigned record per student per program, so the key is deliberately not
 * row-derived: several payment rows must resolve to the same record.
 */
export function unassignedFinanceRecordSourceKey(
  hash: string,
  studentKey: string,
  programShortCode: string,
): string {
  return sourceKey(hash, 'finance-record-unassigned', studentKey, programShortCode)
}

/** workbook hash + "Tracker Master" + source row. */
export function paymentSourceKey(hash: string, sheet: string, row: number): string {
  return sourceKey(hash, 'payment', sheet, row)
}

/** workbook hash + sheet + source row + source column + schedule section. */
export function installmentSourceKey(
  hash: string,
  sheet: string,
  row: number,
  columnLetter: string,
  section: string,
): string {
  return sourceKey(hash, 'installment', sheet, row, columnLetter, section)
}
