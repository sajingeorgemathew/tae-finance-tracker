/**
 * Display filtering for the finance grid.
 *
 * Every function here narrows what is *shown*. Nothing merges two students,
 * rewrites a name, or changes a stored value — a search that finds nothing
 * means the batch on screen holds no such row, not that the row is wrong.
 *
 * Pure and client-safe: the grid filters the rows it already has rather than
 * asking the server again, so typing in the search box does not re-query a
 * batch that is already loaded.
 */

import type { FinanceGridRow } from './types.ts'

/** The quick filters offered above the grid. */
export type GridFilter =
  | 'all'
  /** Negative balance under a verified batch convention. */
  | 'balance_due'
  /** Balance recorded as exactly zero. */
  | 'settled'
  /** No balance figure was recorded for the student. */
  | 'no_balance'
  /** The workbook recorded a receipt as not sent, or disagreed with itself. */
  | 'legacy_receipt_gap'

export const GRID_FILTERS: readonly GridFilter[] = [
  'all',
  'balance_due',
  'settled',
  'no_balance',
  'legacy_receipt_gap',
]

export function isGridFilter(value: string | null | undefined): value is GridFilter {
  return GRID_FILTERS.includes(value as GridFilter)
}

export function gridFilterLabel(filter: GridFilter): string {
  switch (filter) {
    case 'all':
      return 'All'
    case 'balance_due':
      return 'Balance due'
    case 'settled':
      return 'Settled'
    case 'no_balance':
      return 'Balance not recorded'
    case 'legacy_receipt_gap':
      return 'Legacy receipt not sent'
  }
}

/**
 * Case-insensitive match on student number or name.
 *
 * Substring, not fuzzy: a staff member searching `125346` must not be shown
 * `125348` because it is close. Identity is never guessed at on this screen.
 */
export function matchesSearch(row: FinanceGridRow, term: string): boolean {
  const needle = term.trim().toLowerCase()
  if (needle === '') return true

  const number = row.studentNumber?.toLowerCase() ?? ''
  const name = row.studentName.toLowerCase()

  return number.includes(needle) || name.includes(needle)
}

/**
 * Applies one quick filter.
 *
 * The balance filters rely on `balanceState`, which is `'unknown'` whenever the
 * batch's balance convention could not be verified — so on such a batch they
 * match nothing, and the UI disables them rather than showing an empty grid.
 */
export function matchesFilter(row: FinanceGridRow, filter: GridFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'balance_due':
      return row.balanceState === 'due'
    case 'settled':
      return row.balanceState === 'settled'
    case 'no_balance':
      return row.legacyBalance.kind === 'blank'
    case 'legacy_receipt_gap':
      return row.receiptStatus === 'not_sent' || row.receiptStatus === 'mixed'
  }
}

/** Search and filter together, preserving the workbook's row order. */
export function filterRows(
  rows: readonly FinanceGridRow[],
  options: { search?: string; filter?: GridFilter },
): FinanceGridRow[] {
  const search = options.search ?? ''
  const filter = options.filter ?? 'all'

  return rows.filter((row) => matchesSearch(row, search) && matchesFilter(row, filter))
}
