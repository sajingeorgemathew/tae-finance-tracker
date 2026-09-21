/**
 * Historical receipt status, derived from what the workbook recorded.
 *
 * There are zero rows in `receipts`. That is a fact about this system, not a
 * fact about a student: the import deliberately created no receipt from a
 * "Receipt Sent" flag, because a flag is not a receipt and has no number, no
 * PDF and no delivery behind it. Showing "Receipt not sent" on every row
 * because the new table is empty would therefore be a lie told 397 times.
 *
 * So the grid reports the *legacy* status only, derived from the `Receipt Sent`
 * value preserved on each of that record's Tracker Master payments. The values
 * the workbook actually holds are `YES` (1005), `NO` (4) and blank (5).
 *
 * The new-system status is reported separately and is, for now, always "none
 * issued" — which is true and is not a statement about the student.
 */

/** What the historical workbook says about receipts for one finance record. */
export type LegacyReceiptStatus = 'sent' | 'mixed' | 'not_sent' | 'unknown'

export interface LegacyReceiptSummary {
  status: LegacyReceiptStatus
  /** Payments that recorded any value at all. */
  recorded: number
  /** Payments that left the cell empty. Ignored when deciding the status. */
  blank: number
  /** Total payments considered. */
  total: number
}

/**
 * Folds a record's preserved `Receipt Sent` values into one status.
 *
 * Blanks are ignored rather than counted against the student: "nobody wrote
 * anything in that cell" is not evidence that a receipt was withheld. A record
 * whose payments are all blank — or which has no payments at all — is
 * `unknown`, not `not_sent`.
 *
 * Anything that is neither `YES` nor `NO` resolves to `mixed` rather than being
 * guessed at in either direction. No such value exists in the current import;
 * this is what happens if a future one introduces `Y`, `Pending` or a date.
 */
export function summarizeLegacyReceipts(
  values: readonly (string | null | undefined)[],
): LegacyReceiptSummary {
  const stated: string[] = []
  let blank = 0

  for (const value of values) {
    const trimmed = value?.trim() ?? ''
    if (trimmed === '') {
      blank += 1
      continue
    }
    stated.push(trimmed.toLowerCase())
  }

  const summary = { recorded: stated.length, blank, total: values.length }

  if (stated.length === 0) return { status: 'unknown', ...summary }
  if (stated.every((value) => value === 'yes')) return { status: 'sent', ...summary }
  if (stated.every((value) => value === 'no')) return { status: 'not_sent', ...summary }

  return { status: 'mixed', ...summary }
}

/** The row label for a status. Always says "Legacy" — it is never a new receipt. */
export function legacyReceiptLabel(status: LegacyReceiptStatus): string {
  switch (status) {
    case 'sent':
      return 'Legacy receipt: Sent'
    case 'mixed':
      return 'Legacy receipt: Mixed'
    case 'not_sent':
      return 'Legacy receipt: Not sent'
    case 'unknown':
      return 'Legacy receipt: Unknown'
  }
}

/**
 * Longer wording for a tooltip.
 *
 * Every variant names the workbook as the source, so a staff member is never
 * left thinking this application decided something about the student.
 */
export function legacyReceiptExplanation(summary: LegacyReceiptSummary): string {
  const { status, recorded, blank, total } = summary

  const scope =
    total === 0
      ? 'This record has no imported payments.'
      : `${recorded} of ${total} imported payment${total === 1 ? '' : 's'} recorded a value` +
        (blank > 0 ? `; ${blank} left it blank.` : '.')

  switch (status) {
    case 'sent':
      return `The historical workbook recorded a receipt as sent for every payment that stated one. ${scope}`
    case 'mixed':
      return `The historical workbook recorded different receipt values across this record's payments. ${scope}`
    case 'not_sent':
      return `The historical workbook recorded no receipt sent for every payment that stated a value. ${scope}`
    case 'unknown':
      return `The historical workbook stated no receipt value for this record. ${scope}`
  }
}
