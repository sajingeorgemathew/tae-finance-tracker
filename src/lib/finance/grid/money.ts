/**
 * CAD money for the finance tracker.
 *
 * Formatting is hand-rolled rather than delegated to `Intl.NumberFormat`. The
 * grid renders historical figures that have to look identical in a test, in a
 * server render and in a browser, and ICU's currency output varies between
 * Node versions and locales — a non-breaking space or a `CA$` prefix appearing
 * on one machine and not another would make a snapshot of a student's account
 * unstable for no reason.
 *
 * Two rules from the ticket are enforced here rather than at each call site:
 *
 * 1. **A blank is never `$0.00`.** A missing figure is `MoneyCell.blank` and
 *    renders as an em dash. "Nothing was recorded" and "the figure was zero"
 *    are different facts about a student's account.
 * 2. **A negative figure stays negative.** Nothing here takes an absolute
 *    value, swaps a sign, or hides a number because it looks wrong.
 *
 * Pure: no database access, no `server-only`, so the same functions run in the
 * view-model builder, in a Client Component and in a test.
 */

/** ISO 4217 code every figure in this application is denominated in. */
export const CURRENCY = 'CAD'

/**
 * One cell of historical money, as the workbook left it.
 *
 * `text` exists because a money column in the source is not guaranteed to hold
 * a number: staff typed notes into fee cells. Those are shown as written rather
 * than dropped or coerced to zero.
 */
export type MoneyCell =
  | { kind: 'blank' }
  | { kind: 'amount'; amount: number; display: string }
  | { kind: 'text'; text: string }
  | { kind: 'error'; text: string }

/** The single shared blank. Cheap to compare and impossible to mutate apart. */
export const BLANK_MONEY: MoneyCell = Object.freeze({ kind: 'blank' })

/** What a blank renders as. An em dash, never a zero. */
export const BLANK_DISPLAY = '—'

/**
 * `1234.5` -> `'$1,234.50'`, `-900` -> `'-$900.00'`, `0` -> `'$0.00'`.
 *
 * Rounds half away from zero at the cent, which is what the workbook's own
 * two-decimal display does; a value that is already whole cents is unaffected.
 */
export function formatMoney(amount: number): string {
  if (!Number.isFinite(amount)) return BLANK_DISPLAY

  const negative = amount < 0
  const cents = Math.round(Math.abs(amount) * 100)
  const whole = Math.floor(cents / 100)
  const fraction = cents % 100

  const grouped = String(whole).replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  return `${negative ? '-' : ''}$${grouped}.${String(fraction).padStart(2, '0')}`
}

/** A money cell from a number. `null`/`NaN` gives a blank, never a zero. */
export function moneyFromNumber(amount: number | null | undefined): MoneyCell {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return BLANK_MONEY
  return { kind: 'amount', amount, display: formatMoney(amount) }
}

/**
 * A money cell from a PostgREST `NUMERIC` value, which arrives as a string.
 *
 * Parsed here and nowhere else, so there is one place that decides what an
 * unparseable historical value means: it is kept as text rather than discarded,
 * because the workbook did hold *something* and the staff member reading the
 * row needs to see what.
 */
export function moneyFromNumeric(value: string | number | null | undefined): MoneyCell {
  if (value === null || value === undefined) return BLANK_MONEY
  if (typeof value === 'number') return moneyFromNumber(value)

  const trimmed = value.trim()
  if (trimmed === '') return BLANK_MONEY

  const parsed = Number(trimmed)
  if (!Number.isFinite(parsed)) return { kind: 'text', text: trimmed }
  return moneyFromNumber(parsed)
}

/** The string to show for a cell. Blanks give an em dash, never `$0.00`. */
export function displayMoney(cell: MoneyCell): string {
  switch (cell.kind) {
    case 'amount':
      return cell.display
    case 'text':
    case 'error':
      return cell.text
    case 'blank':
      return BLANK_DISPLAY
  }
}

/** The numeric value of a cell, or null when it does not have one. */
export function amountOf(cell: MoneyCell): number | null {
  return cell.kind === 'amount' ? cell.amount : null
}

/**
 * Adds the amounts that exist, and reports how many cells had none.
 *
 * Returns a blank total when nothing could be added, rather than `$0.00`: a
 * column of blanks does not sum to zero, it sums to nothing. `missing` is what
 * lets the summary strip say a total is based on the figures available.
 */
export function sumMoney(cells: readonly MoneyCell[]): {
  total: MoneyCell
  counted: number
  missing: number
} {
  let cents = 0
  let counted = 0
  let missing = 0

  for (const cell of cells) {
    const amount = amountOf(cell)
    if (amount === null) {
      missing += 1
      continue
    }
    cents += Math.round(amount * 100)
    counted += 1
  }

  return {
    total: counted === 0 ? BLANK_MONEY : moneyFromNumber(cents / 100),
    counted,
    missing,
  }
}
